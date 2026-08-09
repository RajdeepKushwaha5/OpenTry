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
  /** Object storage is billed per GB stored and takes no verticalAutoscaling,
   *  so it is the one resource a manifest could otherwise request without a
   *  ceiling applying to it. */
  maxObjectStorageGb: 5,

  /** Ceiling per trial project. */
  maxServicesPerTrial: 4,
  maxTtlMinutes: 30,
  minTtlMinutes: 5,
  defaultTtlMinutes: 30,

  /** Ceiling across the whole platform — the blast-radius control. */
  maxConcurrentTrials: Number(process.env.OPENTRY_MAX_CONCURRENT_TRIALS ?? 6),
  maxTrialsPerVisitor: 1,

  /**
   * How long provisioning may run before we give up and destroy.
   *
   * 20 min. This was 12, chosen when the catalog measured 264-310s end to end
   * — comfortable headroom at the time. It is not any more: the same four apps
   * now take 699-749s against the live platform, and a 720s ceiling sitting
   * inside the spread of normal completion times is a coin flip, not a
   * timeout. It behaved like one, failing 60% of provisions with
   * `pollUntil: timed out after 721s` while the successes finished at 749s.
   *
   * A timeout has to be far enough above p95 that firing means something is
   * actually wrong. An idle slot costs ~$0.0001/min, so the headroom is
   * almost free; a demo whose pool cannot refill is not.
   */
  provisionTimeoutMs: 20 * 60 * 1000,
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
