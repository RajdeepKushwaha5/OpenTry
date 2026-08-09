/**
 * Hard limits. These are enforced by OpenTry regardless of what a catalog
 * manifest asks for.
 *
 * A manifest is untrusted input from a third-party maintainer. Without these
 * ceilings a single entry could ask for 8 dedicated cores across 10 containers
 * and quietly drain the account. Every value here is deliberately small: a
 * 30-minute evaluation of a web app does not need production resources.
 */

export const LEASE_TAG = 'OPENTRY_EPHEMERAL';

export const LIMITS = Object.freeze({
  /** Ceiling per service, applied after the manifest is parsed. */
  maxCpuPerService: 2,
  maxRamGbPerService: 2,
  maxDiskGbPerService: 10,
  maxContainersPerService: 1,

  /** Ceiling per trial project. */
  maxServicesPerTrial: 4,
  maxTtlMinutes: 30,
  minTtlMinutes: 5,
  defaultTtlMinutes: 30,

  /** Ceiling across the whole platform — the blast-radius control. */
  maxConcurrentTrials: Number(process.env.OPENTRY_MAX_CONCURRENT_TRIALS ?? 6),
  maxTrialsPerVisitor: 1,

  /** How long provisioning may run before we give up and destroy. */
  // 12 min: a Docker VM may sit in READY_TO_DEPLOY for up to 7 min on its own
  // (full kernel boot), so the global ceiling must exceed the per-service one.
  provisionTimeoutMs: 12 * 60 * 1000,
  /** Grace period after expiry before the reaper force-deletes. */
  reaperGraceMs: 60 * 1000,
  /** How often the reaper sweeps. */
  reaperIntervalMs: 30 * 1000,
  /** Rotate idle pool projects so removed apps and stale images cannot bill forever. */
  warmMaxAgeMs: 6 * 60 * 60 * 1000,
});

/**
 * Env keys a manifest may never set.
 *
 * The dominant abuse risk for free, anonymous, disposable infrastructure is
 * outbound spam. Blocking SMTP configuration at the manifest layer means a
 * malicious or careless catalog entry cannot turn a trial into a mail relay.
 */
export const FORBIDDEN_ENV_PATTERNS = [
  /^SMTP_/i,
  /^MAIL(GUN|CHIMP|JET)?_/i,
  /^SENDGRID/i,
  /^POSTMARK/i,
  /^SES_/i,
  /^AWS_(ACCESS|SECRET)/i,
  /^TWILIO/i,
];

/** Service types a manifest may use. Anything else is rejected. */
export const ALLOWED_SERVICE_TYPES = [
  /^postgresql@\d+$/,
  /^mariadb@[\d.]+$/,
  /^valkey@[\d.]+$/,
  /^keydb@[\d.]+$/,
  /^clickhouse@[\d.]+$/,
  /^meilisearch@[\d.]+$/,
  /^typesense@[\d.]+$/,
  /^elasticsearch@[\d.]+$/,
  /^nats@[\d.]+$/,
  /^docker@[\d.]+$/,
  /^nodejs@\d+$/,
  /^python@[\d.]+$/,
  /^go@[\d.]+$/,
  /^java@\d+$/,
  /^php-nginx@[\d.]+$/,
  /^ubuntu@[\d.]+$/,
  /^alpine@[\d.]+$/,
  /^static$/,
  /^objectstorage$/,
  /^object-storage$/,
];

export function isAllowedServiceType(type) {
  return ALLOWED_SERVICE_TYPES.some((re) => re.test(String(type)));
}

/**
 * Service families that accept `minContainers` / `maxContainers`.
 *
 * Verified against the live API: sending container counts to a managed
 * database is rejected with
 *   `db.minContainers: ["setting min containers not supported"]`
 *
 * Zerops splits scaling into two models (docs: features/scaling):
 *   - runtimes, Linux containers and Docker  -> horizontal scaling (1..10)
 *   - databases and shared storage           -> fixed count via mode HA/NON_HA
 *   - object storage                         -> no containers at all
 *
 * We must therefore only emit container counts for the first family.
 */
const HORIZONTALLY_SCALABLE = [
  /^nodejs@/,
  /^python@/,
  /^go@/,
  /^golang@/,
  /^java@/,
  /^rust@/,
  /^dotnet@/,
  /^php-nginx@/,
  /^php-apache@/,
  /^bun@/,
  /^deno@/,
  /^elixir@/,
  /^gleam@/,
  /^ruby@/,
  /^nginx@/,
  /^static/,
  /^ubuntu@/,
  /^alpine@/,
  /^docker@/,
];

export function supportsContainerCount(type) {
  return HORIZONTALLY_SCALABLE.some((re) => re.test(String(type)));
}

/** Object storage takes neither container counts nor verticalAutoscaling. */
export function isObjectStorage(type) {
  return /^object-?storage$/i.test(String(type));
}

/**
 * Docker services run in VMs and take FIXED resources, not min/max ranges:
 *
 *   verticalAutoscaling:
 *     cpu: 3
 *     ram: 2
 *     disk: 20
 *
 * Sending minCpu/maxCpu/minRam/maxRam to a Docker service is the third
 * variant of the same trap in this API — databases reject `minContainers`,
 * object storage rejects `verticalAutoscaling` entirely, and Docker rejects
 * ranges. Each one is accepted at import time and then quietly misbehaves.
 *
 * Docker DOES still support horizontal scaling via min/maxContainers.
 */
export function isDockerService(type) {
  return /^docker@/i.test(String(type));
}

export function isForbiddenEnvKey(key) {
  return FORBIDDEN_ENV_PATTERNS.some((re) => re.test(String(key)));
}
