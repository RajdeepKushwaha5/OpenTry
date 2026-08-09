/**
 * Lease store — all database access for OpenTry.
 *
 * The one interesting query here is `claimWarmLease`. Two visitors clicking
 * "Try" at the same moment must never receive the same trial, so the claim is
 * a single atomic statement using `FOR UPDATE SKIP LOCKED`: each concurrent
 * transaction locks a different row instead of queueing behind the same one.
 * Doing this as SELECT-then-UPDATE would be a race that only shows up under
 * exactly the conditions a demo creates.
 */

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';

const HERE = dirname(fileURLToPath(import.meta.url));

export const LeaseState = Object.freeze({
  PROVISIONING: 'PROVISIONING',
  READY_UNCLAIMED: 'READY_UNCLAIMED',
  CLAIMED: 'CLAIMED',
  DESTROYING: 'DESTROYING',
  DESTROYED: 'DESTROYED',
  FAILED: 'FAILED',
});

/**
 * Build a Postgres connection string from Zerops' generated env vars.
 *
 * Zerops names them after the service hostname, so a `db` service yields
 * db_hostname / db_port / db_user / db_password / db_dbName, plus a
 * ready-made db_connectionString. We prefer the connection string and fall
 * back to assembling one, because the exact variable set differs slightly
 * between database types.
 */
export function connectionStringFromEnv(env = process.env) {
  if (env.DATABASE_URL) return env.DATABASE_URL;
  if (env.db_connectionString) return env.db_connectionString;

  const host = env.db_hostname ?? 'db';
  const port = env.db_port ?? '5432';
  const user = env.db_user ?? 'db';
  const pass = env.db_password ?? '';
  const name = env.db_dbName ?? env.db_database ?? 'db';
  return `postgresql://${user}:${encodeURIComponent(pass)}@${host}:${port}/${name}`;
}

export class LeaseStore {
  constructor({ connectionString = connectionStringFromEnv(), pool } = {}) {
    this.pool = pool ?? new pg.Pool({ connectionString, max: 8, idleTimeoutMillis: 30_000 });
  }

  async migrate() {
    const sql = await readFile(join(HERE, 'schema.sql'), 'utf8');
    await this.pool.query(sql);
  }

  close() {
    return this.pool.end();
  }

  // -- creation ------------------------------------------------------------

  /** Insert a lease row BEFORE provisioning starts, so a crash leaves a trace. */
  async createLease({ id, appSlug, ttlMinutes }) {
    const { rows } = await this.pool.query(
      `INSERT INTO leases (id, app_slug, state, ttl_minutes)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [id, appSlug, LeaseState.PROVISIONING, ttlMinutes],
    );
    return rows[0];
  }

  /**
   * Record the Zerops project id the instant the import returns — before we
   * wait for services. If the controller dies mid-provision, the reaper can
   * still find and destroy this project.
   */
  attachProject(id, { projectId, projectName }) {
    return this.pool.query(
      `UPDATE leases SET project_id = $2, project_name = $3 WHERE id = $1`,
      [id, projectId, projectName],
    );
  }

  markReady(id, { url, credentials, services, provisionMs }) {
    return this.pool.query(
      `UPDATE leases
          SET state = $2, url = $3, credentials = $4, services = $5,
              provision_ms = $6, ready_at = now()
        WHERE id = $1`,
      [
        id,
        LeaseState.READY_UNCLAIMED,
        url,
        JSON.stringify(credentials ?? []),
        JSON.stringify(services ?? []),
        provisionMs ?? null,
      ],
    );
  }

  markFailed(id, error) {
    return this.pool.query(
      `UPDATE leases SET state = $2, error = $3 WHERE id = $1`,
      [id, LeaseState.FAILED, String(error).slice(0, 2000)],
    );
  }

  /**
   * Attach a failure reason without changing state.
   *
   * Separate from markFailed because the reaper needs to record WHY it is
   * tearing something down while driving its own PROVISIONING -> DESTROYING ->
   * DESTROYED sequence. Only fills an empty error, so a specific diagnosis
   * from the provisioner is never overwritten by a generic one from cleanup.
   */
  recordError(id, error) {
    return this.pool.query(
      `UPDATE leases SET error = $2 WHERE id = $1 AND error IS NULL`,
      [id, String(error).slice(0, 2000)],
    );
  }

  markDestroyed(id, { estimatedCost } = {}) {
    return this.pool.query(
      `UPDATE leases SET state = $2, destroyed_at = now(), estimated_cost = $3 WHERE id = $1`,
      [id, LeaseState.DESTROYED, estimatedCost ?? null],
    );
  }

  // -- the claim -----------------------------------------------------------

  /**
   * Atomically hand one warm trial to a visitor.
   *
   * SKIP LOCKED is what makes this safe under concurrency: if two requests
   * arrive together, the second skips the row the first has locked and takes
   * the next one, rather than blocking and then claiming the same trial.
   *
   * Returns the claimed lease, or null if the pool is empty.
   */
  async claimWarmLease({ appSlug, visitorHash, ttlMinutes }) {
    try {
      const { rows } = await this.pool.query(
        `UPDATE leases
          SET state = $1,
              claimed_at = now(),
              expires_at = now() + ($2 || ' minutes')::interval,
              visitor_hash = $3
        WHERE id = (
          SELECT id FROM leases
           WHERE state = $4 AND app_slug = $5
           ORDER BY ready_at ASC
           FOR UPDATE SKIP LOCKED
           LIMIT 1
        )
        RETURNING *`,
        [LeaseState.CLAIMED, String(ttlMinutes), visitorHash, LeaseState.READY_UNCLAIMED, appSlug],
      );
      return rows[0] ?? null;
    } catch (err) {
      if (err.code !== '23505') throw err;
      return this.hasActiveTrial(visitorHash);
    }
  }

  // -- pool accounting -----------------------------------------------------

  /** How many trials of an app are warm or on their way to warm. */
  async poolDepth(appSlug) {
    const { rows } = await this.pool.query(
      `SELECT
         count(*) FILTER (WHERE state = $2) AS ready,
         count(*) FILTER (WHERE state = $3) AS provisioning
       FROM leases WHERE app_slug = $1`,
      [appSlug, LeaseState.READY_UNCLAIMED, LeaseState.PROVISIONING],
    );
    return { ready: Number(rows[0].ready), provisioning: Number(rows[0].provisioning) };
  }

  /** Everything currently costing money — the blast-radius number. */
  async activeCount() {
    const { rows } = await this.pool.query(
      `SELECT count(*)::int AS n FROM leases
        WHERE state <> $1 AND (project_id IS NOT NULL OR state = $2)`,
      [LeaseState.DESTROYED, LeaseState.PROVISIONING],
    );
    return rows[0].n;
  }

  async hasActiveTrial(visitorHash) {
    const { rows } = await this.pool.query(
      `SELECT * FROM leases
        WHERE visitor_hash = $1 AND state = $2 AND expires_at > now()
        LIMIT 1`,
      [visitorHash, LeaseState.CLAIMED],
    );
    return rows[0] ?? null;
  }

  /**
   * The trial currently being built, if any.
   *
   * Exists so the browser can watch a real provision happen. Without it the
   * SSE timeline is unreachable: a warm claim returns an already-ready trial,
   * so nothing in the normal flow ever shows the work being done — which is
   * precisely the thing worth showing.
   */
  async currentlyProvisioning(appSlug = null) {
    const { rows } = await this.pool.query(
      `SELECT id, app_slug, created_at FROM leases
        WHERE state = $1 AND ($2::text IS NULL OR app_slug = $2)
        ORDER BY created_at DESC LIMIT 1`,
      [LeaseState.PROVISIONING, appSlug],
    );
    return rows[0] ?? null;
  }

  getLease(id) {
    return this.pool.query(`SELECT * FROM leases WHERE id = $1`, [id]).then((r) => r.rows[0] ?? null);
  }

  // -- reaping -------------------------------------------------------------

  /**
   * Leases that should be destroyed:
   *  - CLAIMED and past their TTL
   *  - PROVISIONING for far longer than provisioning can legitimately take
   *  - READY_UNCLAIMED and stale (the pool shrank, or an app was removed)
   */
  async findReapable({ graceMs = 60_000, provisionTimeoutMs = 720_000, warmMaxAgeMs } = {}) {
    const { rows } = await this.pool.query(
      `SELECT * FROM leases
        WHERE project_id IS NOT NULL
          AND (
            (state = $1 AND expires_at < now() - ($2 || ' milliseconds')::interval)
         OR (state = $3 AND created_at < now() - ($4 || ' milliseconds')::interval)
         OR (state = $5 AND $6::bigint IS NOT NULL
             AND ready_at < now() - ($6 || ' milliseconds')::interval)
         OR state IN ($7, $8)
          )`,
      [
        LeaseState.CLAIMED,
        String(graceMs),
        LeaseState.PROVISIONING,
        String(provisionTimeoutMs),
        LeaseState.READY_UNCLAIMED,
        warmMaxAgeMs ?? null,
        LeaseState.FAILED,
        LeaseState.DESTROYING,
      ],
    );
    return rows;
  }

  /**
   * Leases that never got as far as a project, and never will.
   *
   * `findReapable` requires `project_id IS NOT NULL`, because its job is to
   * delete infrastructure and there is none to delete here. But `activeCount`
   * counts PROVISIONING rows whether or not they carry a project id, so a
   * controller that crashed between INSERT and the import response leaves a
   * row that occupies a slot against the global ceiling forever. Enough of
   * those and the pool stops provisioning entirely, with nothing in the
   * Zerops account to explain why.
   *
   * These are closed out in the database only — deliberately no API calls,
   * since by definition nothing was created.
   */
  async findStaleWithoutProject({ provisionTimeoutMs = 720_000 } = {}) {
    const { rows } = await this.pool.query(
      `SELECT * FROM leases
        WHERE project_id IS NULL
          AND state = $1
          AND created_at < now() - ($2 || ' milliseconds')::interval`,
      [LeaseState.PROVISIONING, String(provisionTimeoutMs)],
    );
    return rows;
  }

  /** Every project id we have ever created and not yet destroyed. */
  async knownProjectIds() {
    const { rows } = await this.pool.query(
      `SELECT project_id FROM leases
        WHERE project_id IS NOT NULL AND state <> $1`,
      [LeaseState.DESTROYED],
    );
    return new Set(rows.map((r) => r.project_id));
  }

  markDestroying(id) {
    return this.pool.query(`UPDATE leases SET state = $2 WHERE id = $1`, [
      id,
      LeaseState.DESTROYING,
    ]);
  }

  // -- rate limiting ---------------------------------------------------------

  /**
   * Count a hit and report whether the caller is over the limit.
   *
   * One atomic upsert: the INSERT wins if the window is new, and the DO UPDATE
   * either increments within the window or resets it. Doing this as
   * read-then-write would let two concurrent requests each see the same count
   * and both pass — the exact failure a rate limiter exists to prevent.
   */
  async hitRateLimit(key, { windowMs, max }) {
    const { rows } = await this.pool.query(
      `INSERT INTO rate_limits (bucket, hits, window_start)
       VALUES ($1, 1, now())
       ON CONFLICT (bucket) DO UPDATE SET
         hits = CASE
           WHEN rate_limits.window_start < now() - ($2 || ' milliseconds')::interval
           THEN 1 ELSE rate_limits.hits + 1 END,
         window_start = CASE
           WHEN rate_limits.window_start < now() - ($2 || ' milliseconds')::interval
           THEN now() ELSE rate_limits.window_start END
       RETURNING hits, window_start`,
      [key, String(windowMs)],
    );
    const { hits, window_start } = rows[0];
    return {
      allowed: hits <= max,
      hits,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((new Date(window_start).getTime() + windowMs - Date.now()) / 1000),
      ),
    };
  }

  /** Drop expired buckets so the table stays small. */
  pruneRateLimits(windowMs) {
    return this.pool.query(
      `DELETE FROM rate_limits WHERE window_start < now() - ($1 || ' milliseconds')::interval`,
      [String(windowMs * 2)],
    );
  }

  // -- events --------------------------------------------------------------

  appendEvent(leaseId, { step, status, message, atMs, ...meta }) {
    return this.pool.query(
      `INSERT INTO lease_events (lease_id, at_ms, step, status, message, meta)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [leaseId, Math.round(atMs ?? 0), step, status, message, JSON.stringify(meta ?? {})],
    );
  }

  async listEvents(leaseId, afterId = 0) {
    const { rows } = await this.pool.query(
      `SELECT id, at_ms, step, status, message, meta FROM lease_events
        WHERE lease_id = $1 AND id > $2 ORDER BY id ASC`,
      [leaseId, afterId],
    );
    return rows;
  }
}

/**
 * Identify a visitor without storing anything identifying.
 *
 * A raw IP is personal data and we have no reason to keep it — we only need
 * "is this the same person who already has a trial open". A salted hash gives
 * us that and nothing else. The salt is per-deployment, so hashes are not
 * comparable across environments and cannot be reversed with a rainbow table.
 */
const VISITOR_SALT = process.env.OPENTRY_VISITOR_SALT ?? randomBytes(16).toString('hex');

/**
 * Trusted proxy hops in front of this process. Zerops terminates TLS and
 * routes public traffic through the project's own L7 balancer: exactly one.
 */
const TRUSTED_PROXY_HOPS = Number(process.env.OPENTRY_TRUSTED_PROXY_HOPS ?? 1);

/**
 * Which entry of X-Forwarded-For is actually ours.
 *
 * A proxy APPENDS the peer it received the request from, so the header reads
 * left-to-right as [client-supplied..., untrusted-hops..., trusted-hops...].
 * Everything except the entries our own infrastructure appended is attacker
 * controlled: a caller can send `X-Forwarded-For: 1.2.3.4` and the balancer
 * will happily forward `1.2.3.4, <their real ip>`.
 *
 * Reading `[0]`, as this used to, therefore reads exactly the value the caller
 * chose — a new fingerprint per request, which is a free bypass of the
 * one-trial-per-visitor limit. Counting from the right instead takes the entry
 * the last trusted hop wrote.
 *
 * This is correct or no worse under every proxy behaviour: if Zerops appends,
 * the rightmost hop is the real peer; if it replaces the header, there is one
 * entry and both readings agree; if it forwarded the header untouched we would
 * fall back to the socket address, which is what the `||` chain is for.
 */
function clientIp(req) {
  const chain = (req.headers['x-forwarded-for'] ?? '')
    .toString()
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  if (!chain.length) return null;
  return chain[Math.max(0, chain.length - TRUSTED_PROXY_HOPS)] ?? null;
}

export function visitorFingerprint(req) {
  const ip = clientIp(req) || req.socket?.remoteAddress || 'unknown';
  const ua = (req.headers['user-agent'] ?? '').toString().slice(0, 200);
  return createHash('sha256').update(`${VISITOR_SALT}|${ip}|${ua}`).digest('hex').slice(0, 32);
}
