/**
 * Parse, validate and clamp an `opentry.yaml`, then render it into a real
 * Zerops Import YAML for one isolated trial project.
 *
 * Two ideas do the heavy lifting here:
 *
 *  1. A manifest is UNTRUSTED. Everything is validated and every resource
 *     request is clamped to LIMITS. A manifest cannot widen its own ceiling.
 *
 *  2. Secret generation is delegated to Zerops' own import preprocessor
 *     (`<@generateRandomString(<32>)>`), rather than reimplemented here.
 *     Values we must know client-side (the trial login) are generated locally
 *     and injected, because we have to display them to the visitor.
 */

import YAML from 'yaml';
import { assertLocalPath } from './local-path.mjs';
import { normaliseSeedStep } from '../../provisioner/src/seed.mjs';
import { randomBytes } from 'node:crypto';
import {
  LEASE_TAG,
  LIMITS,
  isAllowedServiceType,
  isForbiddenEnvKey,
  isDockerService,
  isObjectStorage,
  supportsContainerCount,
} from './limits.mjs';

export class ManifestError extends Error {
  constructor(message, path) {
    super(path ? `${path}: ${message}` : message);
    this.name = 'ManifestError';
    this.path = path;
  }
}

const req = (obj, key, path) => {
  const v = obj?.[key];
  if (v === undefined || v === null || v === '') {
    throw new ManifestError(`missing required field "${key}"`, path);
  }
  return v;
};

/** Readable, unambiguous password (no 0/O/1/l) — a visitor may retype it. */
export function generatePassword(length = 20) {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

/** Short, URL-safe, collision-resistant trial id. */
export function generateTrialId() {
  return randomBytes(6).toString('hex');
}

// ---------------------------------------------------------------------------
// Parse + validate
// ---------------------------------------------------------------------------

export function parseManifest(yamlText, { source = 'opentry.yaml' } = {}) {
  let doc;
  try {
    doc = YAML.parse(yamlText);
  } catch (err) {
    throw new ManifestError(`invalid YAML — ${err.message}`, source);
  }
  if (!doc || typeof doc !== 'object') throw new ManifestError('manifest is empty', source);
  if (Number(doc.version) !== 1) {
    throw new ManifestError(`unsupported version "${doc.version}" (expected 1)`, source);
  }

  const app = req(doc, 'app', source);
  const slug = String(req(app, 'slug', 'app'));
  if (!/^[a-z0-9][a-z0-9-]{0,23}$/.test(slug)) {
    throw new ManifestError(
      'slug must be lowercase alphanumeric/dashes, max 24 chars (it becomes part of a hostname)',
      'app.slug',
    );
  }

  const trial = doc.trial ?? {};
  const entry = req(trial, 'entry', 'trial');
  const requestedTtl = Number(trial.ttlMinutes ?? LIMITS.defaultTtlMinutes);
  if (!Number.isFinite(requestedTtl)) {
    throw new ManifestError('ttlMinutes must be a number', 'trial.ttlMinutes');
  }
  const ttlMinutes = Math.max(
    LIMITS.minTtlMinutes,
    Math.min(Math.floor(requestedTtl), LIMITS.maxTtlMinutes),
  );

  const services = req(doc.infra ?? {}, 'services', 'infra');
  if (!Array.isArray(services) || services.length === 0) {
    throw new ManifestError('at least one service is required', 'infra.services');
  }
  if (services.length > LIMITS.maxServicesPerTrial) {
    throw new ManifestError(
      `${services.length} services requested, limit is ${LIMITS.maxServicesPerTrial}`,
      'infra.services',
    );
  }

  const hostnames = new Set();
  for (const svc of services) {
    const hostname = String(req(svc, 'hostname', 'infra.services[]'));
    if (!/^[a-z0-9]{1,25}$/.test(hostname)) {
      throw new ManifestError(
        'hostname must contain only lowercase ASCII letters and numbers, max 25 characters',
        'infra.services',
      );
    }
    if (hostnames.has(hostname)) {
      throw new ManifestError(`duplicate hostname "${hostname}"`, 'infra.services');
    }
    hostnames.add(hostname);

    const type = String(req(svc, 'type', `infra.services.${hostname}`));
    if (!isAllowedServiceType(type)) {
      throw new ManifestError(
        `service type "${type}" is not allowed`,
        `infra.services.${hostname}.type`,
      );
    }

    for (const key of Object.keys({ ...(svc.envSecrets ?? {}), ...(svc.envVariables ?? {}) })) {
      if (isForbiddenEnvKey(key)) {
        throw new ManifestError(
          `env key "${key}" is blocked (outbound-mail credentials are not permitted in trials)`,
          `infra.services.${hostname}`,
        );
      }
    }
  }

  if (!hostnames.has(String(entry.service))) {
    throw new ManifestError(
      `entry.service "${entry.service}" is not one of [${[...hostnames].join(', ')}]`,
      'trial.entry.service',
    );
  }

  for (const [i, credential] of (trial.credentials ?? []).entries()) {
    if (!credential || typeof credential !== 'object') {
      throw new ManifestError('credential must be an object', `trial.credentials[${i}]`);
    }
    if (credential.key) {
      const key = String(credential.key);
      if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) {
        throw new ManifestError('credential key must be a valid uppercase environment key', `trial.credentials[${i}].key`);
      }
      if (isForbiddenEnvKey(key)) {
        throw new ManifestError(`credential key "${key}" is blocked`, `trial.credentials[${i}].key`);
      }
    }
  }

  // Zerops reserves ports outside 10-65435 for internal systems, and the
  // subdomain hostname embeds the port, so an out-of-range value produces a
  // URL that can never resolve.
  const entryPort = Number(req(entry, 'port', 'trial.entry'));
  if (!Number.isInteger(entryPort) || entryPort < 10 || entryPort > 65435) {
    throw new ManifestError(
      `port ${entry.port} is outside the range Zerops allows (10-65435)`,
      'trial.entry.port',
    );
  }

  // A Docker container under --network=host that binds 80 or 443 collides with
  // the project's own L7 balancer. This fails in the most misleading way the
  // platform offers: the service reports ACTIVE, the subdomain resolves, and
  // nothing ever answers. Two catalog candidates were lost to it (Excalidraw,
  // IT-Tools) before it was understood, both being nginx images that ignore
  // any port override and bind 80 regardless. Reject it up front.
  const entrySvc = services.find((sv) => sv.hostname === String(entry.service));
  if (/^docker@/i.test(String(entrySvc?.type)) && [80, 443].includes(entryPort)) {
    throw new ManifestError(
      `port ${entryPort} cannot be used by a docker service. Under --network=host it ` +
        `collides with the project's L7 balancer: the service reports ACTIVE and the URL ` +
        `resolves, but nothing responds. Use a high port, and pick an image whose listen ` +
        `port is configurable.`,
      'trial.entry.port',
    );
  }

  return {
    version: 1,
    app: {
      slug,
      name: String(req(app, 'name', 'app')),
      tagline: String(app.tagline ?? ''),
      description: String(app.description ?? '').trim(),
      homepage: app.homepage ?? null,
      repo: app.repo ?? null,
      license: app.license ?? null,
      category: app.category ?? 'other',
      accent: /^#[0-9a-f]{6}$/i.test(String(app.accent)) ? app.accent : '#3BBDB2',
      firstSteps: Array.isArray(app.firstSteps) ? app.firstSteps.map(String) : [],
      hidden: app.hidden === true,
      capabilities: normaliseCapabilities(app.capabilities),
    },
    trial: {
      ttlMinutes,
      entry: { service: String(entry.service), port: Number(req(entry, 'port', 'trial.entry')) },
      credentials: Array.isArray(trial.credentials) ? trial.credentials : [],
    },
    services: services.map(clampService),
    verify: Array.isArray(doc.verify) ? doc.verify.map(normaliseCheck) : [],
    seed: Array.isArray(doc.seed) ? doc.seed.map(normaliseSeedStep) : [],
  };
}

/**
 * Clamp every resource request down to the platform ceiling. Never up.
 *
 * Also strips fields the target service family does not accept — Zerops
 * rejects the whole import if, say, a database is given `minContainers`.
 */
/**
 * Coerce a manifest-supplied resource number into a usable one.
 *
 * `Math.min(Number(x), ceiling)` is not a clamp when `x` is `"two"` or `{}` —
 * it yields NaN, which serialises into the Import YAML and is then either
 * rejected far downstream or, worse, interpreted. Anything that is not a
 * positive finite number falls back to the ceiling rather than propagating.
 */
function bounded(value, ceiling, fallback = ceiling) {
  if (value === undefined || value === null) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, ceiling);
}

function clampService(svc) {
  const type = String(svc.type);

  // Object storage is sized by objectStorageSize alone.
  if (isObjectStorage(type)) {
    const { verticalAutoscaling, minContainers, maxContainers, mode, ...rest } = svc;
    return {
      ...rest,
      objectStorageSize: bounded(rest.objectStorageSize, LIMITS.maxObjectStorageGb, 1),
    };
  }

  // Docker VMs take fixed cpu/ram/disk, never min/max ranges.
  if (isDockerService(type)) {
    const va = svc.verticalAutoscaling ?? {};
    const fixed = {
      cpu: bounded(va.cpu ?? va.maxCpu, LIMITS.maxCpuPerService),
      ram: bounded(va.ram ?? va.maxRam, LIMITS.maxRamGbPerService),
      disk: bounded(va.disk ?? va.maxDisk, LIMITS.maxDiskGbPerService, 5),
    };
    return {
      ...svc,
      verticalAutoscaling: fixed,
      minContainers: 1,
      maxContainers: 1,
      mode: undefined,
    };
  }

  const va = svc.verticalAutoscaling ?? {};
  const clampedVa = { ...va };

  if (va.maxCpu !== undefined) clampedVa.maxCpu = bounded(va.maxCpu, LIMITS.maxCpuPerService);
  if (va.maxRam !== undefined) clampedVa.maxRam = bounded(va.maxRam, LIMITS.maxRamGbPerService);
  if (va.maxDisk !== undefined) clampedVa.maxDisk = bounded(va.maxDisk, LIMITS.maxDiskGbPerService);

  // `min*` is clamped against the ceiling too, not only against `max*`. A
  // manifest declaring `minCpu: 8` and no `maxCpu` would otherwise pass
  // through untouched and hold eight dedicated cores for its whole TTL — the
  // exact "a manifest cannot widen its own ceiling" property this file claims.
  if (va.minCpu !== undefined) clampedVa.minCpu = bounded(va.minCpu, clampedVa.maxCpu ?? LIMITS.maxCpuPerService, 1);
  if (va.minRam !== undefined) clampedVa.minRam = bounded(va.minRam, clampedVa.maxRam ?? LIMITS.maxRamGbPerService, 1);
  if (va.minDisk !== undefined) clampedVa.minDisk = bounded(va.minDisk, clampedVa.maxDisk ?? LIMITS.maxDiskGbPerService, 1);

  const out = { ...svc, verticalAutoscaling: clampedVa };

  if (supportsContainerCount(type)) {
    out.minContainers = 1;
    out.maxContainers = bounded(svc.maxContainers, LIMITS.maxContainersPerService, 1);
    // Runtimes have no mode; leaving one set would be rejected.
    delete out.mode;
  } else {
    // Databases and shared storage: fixed container count, chosen via mode.
    delete out.minContainers;
    delete out.maxContainers;
    // Always NON_HA. HA runs three containers instead of one — triple the cost
    // for a 30-minute throwaway whose data is deleted with the project. There
    // is no trial for which a manifest asking for HA is answering a real need.
    out.mode = 'NON_HA';
  }

  return out;
}

/**
 * What a trial of this app can do, declared honestly by the catalog entry.
 *
 * This matters because Zerops' firewall is INBOUND only — there is no egress
 * filtering, so a trial cannot be network-isolated. An app that can make
 * arbitrary outbound HTTP requests or run user-supplied code is, handed to an
 * anonymous stranger, an open proxy with a 30-minute lease. n8n is exactly
 * that by design.
 *
 * We cannot remove the risk at the network layer, so we price it: risky apps
 * get a harder proof-of-work, a shorter default TTL, and a visible warning.
 * A manifest that fails to declare a capability it has is a catalog bug, and
 * the honest default is to assume the worst.
 */
function normaliseCapabilities(cap = {}) {
  const outboundHttp = cap.outboundHttp !== false; // default: assume it can
  const codeExecution = cap.codeExecution === true;
  const level = codeExecution || outboundHttp ? 'elevated' : 'standard';
  return {
    outboundHttp,
    codeExecution,
    level,
    // Shown to the visitor. Silence about a known risk is worse than a label.
    notice:
      level === 'elevated'
        ? 'This app can make outbound network requests. Trials are rate-limited and short-lived.'
        : null,
  };
}

/**
 * Accept a status, a list of statuses, or nothing — but never a NaN.
 *
 * `[Number('nope')]` is `[NaN]`, and a check whose expected status is NaN can
 * never pass; it fails the trial minutes later with a message about an
 * unexpected status rather than about the manifest that is actually wrong.
 */
export function normaliseStatuses(value, where) {
  if (value === undefined || value === null) return null;
  const list = (Array.isArray(value) ? value : [value]).map(Number);
  const bad = list.filter((n) => !Number.isInteger(n) || n < 100 || n > 599);
  if (bad.length || !list.length) {
    throw new ManifestError(
      `expectStatus must be HTTP status codes (got ${JSON.stringify(value)})`,
      `${where}.expectStatus`,
    );
  }
  return list;
}

function normaliseCheck(check, i) {
  const kind = String(check.kind ?? 'http');
  if (!['http', 'tcp'].includes(kind)) {
    throw new ManifestError(`unsupported check kind "${kind}"`, `verify[${i}]`);
  }
  const path = check.path ?? '/';
  if (kind === 'http') {
    // Same rule the seed runner enforces: lifecycle resolves this against the
    // trial URL, and an absolute one would point the controller at another host.
    assertLocalPath(path, `verify[${i}] "${check.name ?? i}"`, (m) => new ManifestError(m, `verify[${i}].path`));
  }

  return {
    name: String(check.name ?? `check ${i + 1}`),
    kind,
    path,
    service: check.service ?? null,
    port: check.port ?? null,
    // null => accept any 2xx. The Zerops Node recipe answers 201, so a
    // hardcoded 200 default would fail perfectly healthy apps.
    expectStatus: normaliseStatuses(check.expectStatus, `verify[${i}]`),
    expectBodyContains: check.expectBodyContains ?? null,
    timeoutMs: bounded(check.timeoutMs, 180_000, 60_000),
  };
}

// ---------------------------------------------------------------------------
// Render -> Zerops Import YAML
// ---------------------------------------------------------------------------

/**
 * Build the Import YAML for one trial.
 *
 * @param {object} manifest  output of parseManifest
 * @param {object} opts
 * @param {string} opts.trialId
 * @returns {{ yaml: string, projectName: string, secrets: Record<string,string> }}
 */
export function renderImportYaml(manifest, { trialId } = {}) {
  if (!trialId) throw new Error('renderImportYaml requires a trialId');
  const projectName = `opentry-${manifest.app.slug}-${trialId}`.slice(0, 40);

  // Credentials we must show the visitor are generated here, not by Zerops,
  // because the platform's preprocessor output is never returned to us.
  const secrets = {};
  for (const cred of manifest.trial.credentials) {
    if (!cred.key) continue;
    secrets[cred.key] = cred.generate === 'password' ? generatePassword() : String(cred.value ?? '');
  }

  const services = manifest.services.map((svc) => {
    const out = { ...svc };
    if (out.envSecrets) out.envSecrets = { ...out.envSecrets };
    // Inject generated credentials into the entry service so the app can
    // bootstrap an owner account with the details we display. Create the map
    // when the manifest did not otherwise need service secrets.
    if (svc.hostname === manifest.trial.entry.service && Object.keys(secrets).length) {
      out.envSecrets = { ...(out.envSecrets ?? {}), ...secrets };
    }
    return out;
  });

  const doc = {
    project: {
      name: projectName,
      description: `OpenTry disposable trial — ${manifest.app.name} — auto-deleted`,
      corePackage: 'LIGHT',
      // The reaper refuses to delete anything without this tag.
      tags: [LEASE_TAG, `OPENTRY_APP_${manifest.app.slug.toUpperCase()}`, `OPENTRY_ID_${trialId}`],
      envVariables: {
        OPENTRY_TRIAL_ID: trialId,
        OPENTRY_EPHEMERAL: 'true',
      },
    },
    services,
  };

  // The leading directive switches on Zerops' server-side preprocessor so
  // <@generateRandomString(<32>)> in manifests is expanded by the platform.
  const yaml = `#yamlPreprocessor=on\n${YAML.stringify(doc, { lineWidth: 0 })}`;
  return { yaml, projectName, secrets };
}
