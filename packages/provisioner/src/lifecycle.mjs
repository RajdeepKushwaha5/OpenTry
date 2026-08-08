/**
 * The trial lease lifecycle — the heart of OpenTry.
 *
 *   REQUESTED -> PROVISIONING -> VERIFYING -> READY -> (EXPIRED|DESTROYING) -> DESTROYED
 *                     |              |
 *                     +--------------+--> FAILED (always followed by destroy)
 *
 * Every transition emits an event so the browser can watch a real timeline
 * instead of a spinner. The events ARE the product's core UX — a visitor
 * waiting 90 seconds with visible progress is fine; 90 seconds of nothing is not.
 *
 * NETWORK BOUNDARY (important, and a genuine constraint of the design):
 * the controller runs inside the OpenTry project. Each trial is a SEPARATE
 * Zerops project with its own private network. The controller therefore cannot
 * dial `db:5432` inside a trial — private networks do not cross project
 * boundaries. So:
 *   - `http` checks run against the trial's public subdomain (real HTTP)
 *   - `tcp`  checks are satisfied via the Zerops API service status, not a
 *            socket dial, because a socket is not reachable from here
 * This is documented rather than hidden; see ARCHITECTURE.md.
 */

import { LEASE_TAG, LIMITS } from '../../shared/src/limits.mjs';
import { renderImportYaml } from '../../shared/src/manifest.mjs';
import { pollUntil } from './zerops-client.mjs';
import { estimateCostUsd } from './cost.mjs';

export const LeaseState = Object.freeze({
  REQUESTED: 'REQUESTED',
  PROVISIONING: 'PROVISIONING',
  VERIFYING: 'VERIFYING',
  READY: 'READY',
  EXPIRED: 'EXPIRED',
  DESTROYING: 'DESTROYING',
  DESTROYED: 'DESTROYED',
  FAILED: 'FAILED',
});

/**
 * Real service statuses, taken from the OpenAPI schema `OutDtoServiceStack`
 * rather than guessed. The full enum is:
 *
 *   NEW CREATING ACTIVE STOPPING STOPPED STARTING RESTARTING RELOADING
 *   DELETING DELETED FAILED ACTION_FAILED UPGRADING READY_TO_DEPLOY
 *   REPAIRING CONTAINER_FAILED MOVING_CONTAINER SCALING REPAIR_FAILED
 *   ...plus a SERVICE_-prefixed mirror of most of the above.
 *
 * The one that matters and cost us a debugging cycle: READY_TO_DEPLOY.
 * A runtime created with `buildFromGit` sits there while its build pipeline
 * runs, then flips to ACTIVE once the first version deploys. It is a normal
 * intermediate state, NOT a terminal one — but it is also where a service will
 * sit forever if no build was ever triggered, so we surface it explicitly.
 */
const SERVICE_READY = new Set(['ACTIVE', 'SERVICE_ACTIVE']);

const SERVICE_BROKEN = new Set([
  'FAILED',
  'SERVICE_FAILED',
  'ACTION_FAILED',
  'SERVICE_ACTION_FAILED',
  'CONTAINER_FAILED',
  'SERVICE_CONTAINER_FAILED',
  'REPAIR_FAILED',
  'SERVICE_REPAIR_FAILED',
  'DELETED',
  'SERVICE_DELETED',
  'STOPPED',
  'SERVICE_STOPPED',
]);

/** Waiting on a build/deploy rather than on infrastructure. */
const SERVICE_AWAITING_DEPLOY = new Set(['READY_TO_DEPLOY']);

/**
 * How long a service may sit in READY_TO_DEPLOY before we call it stuck.
 *
 * Type-aware on purpose. Docker services run in VMs, not Incus containers, and
 * the Zerops docs are explicit that VMs "require more time to initialize due to
 * full kernel boot" and that they are "actively working on ... reducing the
 * startup time of runtime VMs". A flat 150s threshold was firing before a
 * Docker VM had finished booting, producing a misleading "no build was
 * triggered" diagnosis.
 */
const STUCK_AWAITING_DEPLOY_MS = 150_000;
const STUCK_AWAITING_DEPLOY_MS_VM = 420_000;

function stuckThresholdFor(serviceType) {
  return /docker/i.test(String(serviceType ?? ''))
    ? STUCK_AWAITING_DEPLOY_MS_VM
    : STUCK_AWAITING_DEPLOY_MS;
}

/**
 * Provision one trial from a parsed manifest.
 *
 * @param {object} args
 * @param {import('./zerops-client.mjs').ZeropsClient} args.client
 * @param {object}   args.manifest   parsed via shared/manifest.mjs
 * @param {string}   args.trialId
 * @param {(e:object)=>void} args.emit  receives {step, status, message, atMs}
 * @returns {Promise<{projectId,url,credentials,services,timings}>}
 */
export async function provisionTrial({ client, manifest, trialId, emit = () => {} }) {
  const started = Date.now();
  const timings = {};
  const at = () => Date.now() - started;

  const step = (name, status, message, extra = {}) =>
    emit({ step: name, status, message, atMs: at(), ...extra });

  let projectId = null;

  try {
    // -- 1. render + import ------------------------------------------------
    step('render', 'running', 'Preparing isolated project');
    const { yaml, projectName, secrets } = renderImportYaml(manifest, { trialId });
    step('render', 'ok', `Manifest rendered (${manifest.services.length} services)`);

    step('import', 'running', 'Creating isolated project');
    const res = await client.importProject(yaml);
    projectId =
      res?.projectId ??
      res?.project?.id ??
      res?.id ??
      (Array.isArray(res?.projects) ? res.projects[0]?.id : undefined);

    if (!projectId) {
      throw new Error('Zerops accepted the import but returned no project id');
    }
    timings.importMs = at();
    step('import', 'ok', 'Isolated project created', { projectId, projectName });

    // -- 2. wait for services ---------------------------------------------
    // Report each service individually so the timeline reads like real work,
    // because it is: "PostgreSQL ready", then "Application deployed".
    const seenReady = new Set();

    // Only wait on services WE declared. Zerops adds a `core` service to every
    // project (L3/L7 balancer, logger, statistics); it is not ours to wait on.
    const expected = new Set(manifest.services.map((s) => s.hostname));
    // hostname -> declared service type, so the stuck threshold can be
    // type-aware (Docker VMs boot far slower than Incus containers).
    const declaredType = new Map(manifest.services.map((s) => [s.hostname, s.type]));

    // A runtime stuck in READY_TO_DEPLOY means no build was ever triggered —
    // usually a `setup:` name in the repo's zerops.yml that does not match the
    // service hostname. Left alone this hangs until the global timeout, so we
    // detect it early and fail with something actionable.
    const awaitingSince = new Map();

    const services = await pollUntil(
      async () => {
        const all = await client.listServices(projectId);
        const list = all.filter((s) => expected.has(s.name));
        if (!list.length) return null;

        for (const svc of list) {
          const status = String(svc.status ?? '').toUpperCase();

          if (SERVICE_BROKEN.has(status)) {
            throw new Error(`Service "${svc.name}" entered state ${status}`);
          }

          if (SERVICE_AWAITING_DEPLOY.has(status)) {
            const since = awaitingSince.get(svc.name) ?? Date.now();
            awaitingSince.set(svc.name, since);
            const threshold = stuckThresholdFor(declaredType.get(svc.name));
            if (Date.now() - since > threshold) {
              throw new Error(
                `Service "${svc.name}" has been READY_TO_DEPLOY for ` +
                  `${Math.round((Date.now() - since) / 1000)}s (limit ${threshold / 1000}s) — ` +
                  `no deploy completed.\n` +
                  `  Most likely cause: the repo's zerops.yml declares a "setup:" name that\n` +
                  `  does not match the service hostname "${svc.name}". Either rename the\n` +
                  `  service to match, or set "zeropsSetup: <name>" on it in the manifest.\n` +
                  `  For docker services, also confirm the run section has no build base —\n` +
                  `  Docker has no build phase (base list: Build = "-").`,
              );
            }
          } else {
            awaitingSince.delete(svc.name);
          }

          if (SERVICE_READY.has(status) && !seenReady.has(svc.name)) {
            seenReady.add(svc.name);
            step(`service:${svc.name}`, 'ok', `${svc.name} ready`);
          }
        }

        const ready = list.filter((s) => SERVICE_READY.has(String(s.status).toUpperCase()));
        return ready.length === list.length ? list : null;
      },
      {
        timeoutMs: LIMITS.provisionTimeoutMs,
        intervalMs: 4_000,
        // Always report the ACTUAL statuses. A tick that says only "waiting"
        // is useless: it hid a service stuck in READY_TO_DEPLOY for eight
        // minutes during the first real run.
        onTick: async (elapsed) => {
          const list = await client.listServices(projectId).catch(() => []);
          const detail = list.map((s) => `${s.name}=${s.status}`).join(' ');
          const building = list.some((s) =>
            SERVICE_AWAITING_DEPLOY.has(String(s.status).toUpperCase()),
          );
          step(
            'services',
            'running',
            `${building ? 'Building' : 'Provisioning'} ${Math.round(elapsed / 1000)}s — ${detail || 'no services yet'}`,
          );
        },
      },
    );
    timings.servicesMs = at();

    // -- 3. resolve the public URL ----------------------------------------
    const entryName = manifest.trial.entry.service;
    const entry = services.find((s) => s.name === entryName);
    if (!entry) throw new Error(`entry service "${entryName}" not found in provisioned project`);

    // `enableSubdomainAccess: true` in the Import YAML is NOT reliably applied
    // — a real run came back with subdomainAccess=false and no HTTP routing.
    // So we always enable it explicitly and wait for it to take effect.
    // RACE, observed on a real run: a service reports ACTIVE before its HTTP
    // port is registered. `ports` is still [] while `requestedPorts` holds the
    // http entry, and enable-subdomain-access rejects with
    // `serviceStackIsNotHttp`. So we retry rather than calling once.
    step('url', 'running', 'Enabling public access');
    await pollUntil(
      async () => {
        const list = await client.listServices(projectId);
        const svc = list.find((s) => s.name === entryName);
        if (svc?.subdomainAccess) return true;
        try {
          await client.enableSubdomain(svc.id);
          return true;
        } catch (err) {
          // Only swallow the "port not registered yet" case; surface anything else.
          if (err.body?.error?.code === 'serviceStackIsNotHttp') return null;
          throw err;
        }
      },
      { timeoutMs: 120_000, intervalMs: 5_000 },
    ).catch((err) => {
      if (/timed out/.test(err.message)) {
        throw new Error(
          `Could not enable public access within 120s — service "${entryName}" never ` +
            `registered an HTTP port. Check that the app listens on port ` +
            `${manifest.trial.entry.port} and that the manifest declares it.`,
        );
      }
      throw err;
    });

    // Confirm it actually stuck before composing a URL from it.
    await pollUntil(
      async () => {
        const list = await client.listServices(projectId);
        return list.find((s) => s.name === entryName)?.subdomainAccess ? true : null;
      },
      { timeoutMs: 60_000, intervalMs: 3_000 },
    ).catch(() => {
      throw new Error('Subdomain access was requested but never became active');
    });

    // The URL is not returned by any endpoint; it must be composed. See
    // ZeropsClient#subdomainUrl for the verified formula.
    const project = await client.getProject(projectId);
    const url = client.subdomainUrl({
      serviceName: entryName,
      subdomainHost: project.zeropsSubdomainHost,
      port: manifest.trial.entry.port,
    });
    if (!url) throw new Error('Project has no zeropsSubdomainHost — cannot compose a public URL');

    timings.urlMs = at();
    step('url', 'ok', 'Public URL assigned', { url });

    // -- 4. behaviour verification ----------------------------------------
    // The step that makes this more than a deploy button: we do not hand over
    // a URL until the application genuinely answers.
    for (const check of manifest.verify) {
      step(`verify:${check.name}`, 'running', check.name);
      await runCheck({ check, url, client, projectId, services });
      step(`verify:${check.name}`, 'ok', check.name);
    }
    timings.verifiedMs = at();

    step('ready', 'ok', 'Trial ready', { url });

    return {
      projectId,
      projectName,
      url,
      credentials: manifest.trial.credentials.map((c) => ({
        label: c.label ?? c.key,
        value: secrets[c.key] ?? c.value ?? '',
      })),
      services: services.map((s) => ({ name: s.name, type: s.serviceStackTypeId ?? s.type ?? '' })),
      timings,
    };
  } catch (err) {
    step('failed', 'error', err.message);
    // Never leak a half-built project. Destroy on the way out, then rethrow.
    if (projectId) {
      try {
        await client.deleteProject(projectId, LEASE_TAG);
        step('cleanup', 'ok', 'Partial project destroyed');
      } catch (cleanupErr) {
        step('cleanup', 'error', `Cleanup failed: ${cleanupErr.message}`);
      }
    }
    err.projectId = projectId;
    throw err;
  }
}

async function runCheck({ check, url, client, projectId, services }) {
  if (check.kind === 'tcp') {
    // See the network-boundary note at the top of this file: we cannot dial a
    // trial's private network from here, so we assert on platform state.
    const svc = services.find((s) => s.name === check.service);
    if (!svc) throw new Error(`check "${check.name}": no service named ${check.service}`);
    const status = String(svc.status ?? '').toUpperCase();
    if (!SERVICE_READY.has(status)) {
      throw new Error(`check "${check.name}": ${check.service} is ${status}`);
    }
    return;
  }

  // http
  const target = new URL(check.path ?? '/', url).toString();
  await pollUntil(
    async () => {
      try {
        const res = await fetch(target, {
          redirect: 'follow',
          signal: AbortSignal.timeout(10_000),
          headers: { 'user-agent': 'OpenTry-Verifier/1.0' },
        });
        if (check.expectStatus == null) {
          if (!res.ok) return null; // any 2xx
        } else if (res.status !== check.expectStatus) {
          return null;
        }
        if (check.expectBodyContains) {
          const body = await res.text();
          if (!body.includes(check.expectBodyContains)) return null;
        }
        return true;
      } catch {
        return null;
      }
    },
    { timeoutMs: check.timeoutMs, intervalMs: 3_000 },
  ).catch(() => {
    throw new Error(`check "${check.name}" did not pass within ${check.timeoutMs / 1000}s`);
  });
}

/**
 * Destroy a trial. Tag-guarded inside the client; this adds the accounting.
 * Returns the receipt shown to the visitor after they hit Destroy.
 */
export async function destroyTrial({ client, lease }) {
  const startedAt = new Date(lease.createdAt).getTime();
  const lifetimeMs = Date.now() - startedAt;

  await client.deleteProject(lease.projectId, LEASE_TAG);

  return {
    projectId: lease.projectId,
    lifetimeMs,
    estimatedCostUsd: estimateCostUsd(lease.services ?? [], lifetimeMs),
    removed: ['containers', 'database', 'storage', 'credentials', 'routes'],
  };
}
