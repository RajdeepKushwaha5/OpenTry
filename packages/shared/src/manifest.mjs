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
  const ttlMinutes = Math.min(
    Number(trial.ttlMinutes ?? LIMITS.defaultTtlMinutes),
    LIMITS.maxTtlMinutes,
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
  };
}

/**
 * Clamp every resource request down to the platform ceiling. Never up.
 *
 * Also strips fields the target service family does not accept — Zerops
 * rejects the whole import if, say, a database is given `minContainers`.
 */
function clampService(svc) {
  const type = String(svc.type);

  // Object storage is sized by objectStorageSize alone.
  if (isObjectStorage(type)) {
    const { verticalAutoscaling, minContainers, maxContainers, mode, ...rest } = svc;
    return rest;
  }

  // Docker VMs take fixed cpu/ram/disk, never min/max ranges.
  if (isDockerService(type)) {
    const va = svc.verticalAutoscaling ?? {};
    const fixed = {
      cpu: Math.min(Number(va.cpu ?? va.maxCpu ?? 2), LIMITS.maxCpuPerService),
      ram: Math.min(Number(va.ram ?? va.maxRam ?? 2), LIMITS.maxRamGbPerService),
      disk: Math.min(Number(va.disk ?? va.maxDisk ?? 5), LIMITS.maxDiskGbPerService),
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

  if (va.maxCpu !== undefined) clampedVa.maxCpu = Math.min(Number(va.maxCpu), LIMITS.maxCpuPerService);
  if (va.maxRam !== undefined) clampedVa.maxRam = Math.min(Number(va.maxRam), LIMITS.maxRamGbPerService);
  if (va.maxDisk !== undefined) clampedVa.maxDisk = Math.min(Number(va.maxDisk), LIMITS.maxDiskGbPerService);
  // A min above the clamped max is invalid to Zerops; pull it down too.
  if (clampedVa.minCpu !== undefined && clampedVa.maxCpu !== undefined)
    clampedVa.minCpu = Math.min(Number(clampedVa.minCpu), clampedVa.maxCpu);
  if (clampedVa.minRam !== undefined && clampedVa.maxRam !== undefined)
    clampedVa.minRam = Math.min(Number(clampedVa.minRam), clampedVa.maxRam);
  if (clampedVa.minDisk !== undefined && clampedVa.maxDisk !== undefined)
    clampedVa.minDisk = Math.min(Number(clampedVa.minDisk), clampedVa.maxDisk);

  const out = { ...svc, verticalAutoscaling: clampedVa };

  if (supportsContainerCount(type)) {
    out.minContainers = 1;
    out.maxContainers = Math.min(Number(svc.maxContainers ?? 1), LIMITS.maxContainersPerService);
    // Runtimes have no mode; leaving one set would be rejected.
    delete out.mode;
  } else {
    // Databases and shared storage: fixed container count, chosen via mode.
    delete out.minContainers;
    delete out.maxContainers;
    out.mode = svc.mode === 'HA' ? 'HA' : 'NON_HA';
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

function normaliseCheck(check, i) {
  const kind = String(check.kind ?? 'http');
  if (!['http', 'tcp'].includes(kind)) {
    throw new ManifestError(`unsupported check kind "${kind}"`, `verify[${i}]`);
  }
  return {
    name: String(check.name ?? `check ${i + 1}`),
    kind,
    path: check.path ?? '/',
    service: check.service ?? null,
    port: check.port ?? null,
    // null => accept any 2xx. The Zerops Node recipe answers 201, so a
    // hardcoded 200 default would fail perfectly healthy apps.
    expectStatus: check.expectStatus ?? null,
    expectBodyContains: check.expectBodyContains ?? null,
    timeoutMs: Math.min(Number(check.timeoutMs ?? 60_000), 180_000),
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
    if (out.envSecrets) {
      out.envSecrets = { ...out.envSecrets };
      // Inject generated credentials into the entry service so the app can
      // bootstrap an owner account with the details we display.
      if (svc.hostname === manifest.trial.entry.service) {
        Object.assign(out.envSecrets, secrets);
      }
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
