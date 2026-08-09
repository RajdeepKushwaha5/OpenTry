/**
 * Who may see what, and which requests share a budget.
 *
 * These decisions used to live inline in server.mjs, where they were correct
 * but untestable: importing that module opens a Postgres pool, so the only way
 * to exercise an authorization rule was to stand up a database and drive HTTP
 * through it. The rules are the most security-sensitive logic in OpenTry and
 * every one of them was got WRONG at least once — the trial-read leak, the SSE
 * credential leak, and the destroy guard that skipped unclaimed leases were all
 * shipped and live. Logic with that record should be assertable in isolation.
 *
 * So: pure functions over a lease row and a visitor fingerprint, no I/O, no
 * Express. server.mjs calls these and does nothing else with the question.
 *
 * The single rule underneath all of it: a trial's URL and generated password
 * belong to exactly one person — whoever CLAIMED it — and a lease nobody has
 * claimed yet belongs to nobody. Trial ids are not secret (the pool endpoint
 * publishes the id being provisioned so the UI can show real work happening),
 * so knowing an id must never be sufficient for anything.
 */

export const CLAIMED = 'CLAIMED';
export const DESTROYED = 'DESTROYED';

/** Does this fingerprint hold this lease? */
export function ownsTrial(lease, fingerprint) {
  if (!lease || !fingerprint) return false;
  // A null visitor_hash means unclaimed. It must never compare equal to a
  // caller who also has no fingerprint, hence the explicit guard above.
  return lease.state === CLAIMED && lease.visitor_hash === fingerprint;
}

/**
 * May this caller read the full trial, credentials included?
 *
 * Identical to ownership. Kept as its own name because the read path and the
 * destroy path are separate decisions that merely happen to agree today, and
 * collapsing them would hide it the day one of them changes.
 */
export function canViewTrial(lease, fingerprint) {
  return ownsTrial(lease, fingerprint);
}

/** May this caller tear this trial down early? */
export function canDestroyTrial(lease, fingerprint) {
  return ownsTrial(lease, fingerprint);
}

/**
 * What the public timeline is allowed to say about a provisioning event.
 *
 * Event rows carry a `meta` blob the controller writes for its own debugging:
 * project ids, service ids, the trial URL. The stream is deliberately public —
 * visitors watch the pool backfill, and that honesty is the point — so it may
 * carry the human-readable timeline and nothing else. Allowlist, not blocklist:
 * a new field added to `meta` later must not silently become public.
 */
export function publicEvent(e) {
  return {
    id: e.id,
    at_ms: e.at_ms,
    step: e.step,
    status: e.status,
    message: e.message,
  };
}

/**
 * The `ready` frame: the full trial for its owner, an acknowledgement for
 * everyone else.
 *
 * @param {object} lease
 * @param {string} fingerprint
 * @param {(l:object)=>object} shape  the full public shape, for the owner only
 */
export function readyPayload(lease, fingerprint, shape) {
  if (canViewTrial(lease, fingerprint)) return shape(lease);
  return { id: lease.id, app: lease.app_slug, state: 'ready' };
}

/**
 * Rate-limit buckets.
 *
 * Polling and claiming cannot share a budget. The UI refreshes the pool and
 * live build every 5s and the ops panel every 20s — 27 requests a minute
 * before the visitor touches anything. Against one 30/min bucket an idle tab
 * exhausts its own allowance and the 429 lands on whatever they do next, which
 * is the Try button. Reads are cheap and mostly self-inflicted, so they get
 * room for several tabs; anything that can create infrastructure keeps the
 * strict limit, with proof of work in front of it as well.
 */
export const POLL_PATHS = new Set([
  '/api/pool',
  '/api/pool/building',
  '/api/metrics',
  '/api/health/deep',
  '/api/catalog',
  '/api/trials/mine',
]);

const TRIAL_READ_RE = /^\/api\/trials\/[^/]+(\/events)?$/;

/**
 * @param {{method:string, path:string}} req
 * @param {{strict:number, poll:number}} limits
 */
export function bucketFor(req, { strict, poll }) {
  if (req.method !== 'GET') return { name: 'write', max: strict };
  if (POLL_PATHS.has(req.path) || TRIAL_READ_RE.test(req.path)) {
    return { name: 'poll', max: poll };
  }
  return { name: 'read', max: strict };
}
