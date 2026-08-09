/**
 * Operational metrics, read straight from the lease table.
 *
 * WHY THIS EXISTS
 * OpenTry spends real money on its own. Until now every failure landed in
 * Postgres and stayed there: if provisioning started failing for every app,
 * nothing would say so — you would find out from a visitor, or from the bill.
 * For a system whose whole job is creating and destroying infrastructure,
 * silent failure is the worst possible property.
 *
 * No new dependency and no time-series store. Every number here is one SQL
 * aggregate over rows that already exist, which is enough to answer the four
 * questions that actually matter:
 *
 *   Is provisioning working?     failure rate
 *   Is it getting slower?        p50 / p95 provisioning time
 *   What is this costing?        spend, actual and projected
 *   Is anything stuck right now? live state
 */

import { LIMITS } from '../../shared/src/limits.mjs';
import { estimateCostUsd } from '../../provisioner/src/cost.mjs';

/** Health verdicts, in increasing order of "you should look at this". */
export const Health = Object.freeze({
  OK: 'ok',
  DEGRADED: 'degraded',
  FAILING: 'failing',
  IDLE: 'idle',
});

export class Metrics {
  constructor({ store, catalog }) {
    this.store = store;
    this.catalog = catalog;
  }

  /**
   * @param {number} windowHours how far back to look
   */
  async snapshot({ windowHours = 24 } = {}) {
    const since = `${windowHours} hours`;

    const { rows: outcomes } = await this.store.pool.query(
      `SELECT
         app_slug,
         count(*)::int                                           AS attempted,
         count(*) FILTER (WHERE provision_ms IS NOT NULL)::int    AS succeeded,
         count(*) FILTER (WHERE state = 'FAILED')::int            AS failed,
         count(*) FILTER (WHERE claimed_at IS NOT NULL)::int      AS claimed,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY provision_ms)  AS p50_ms,
         percentile_cont(0.95) WITHIN GROUP (ORDER BY provision_ms) AS p95_ms,
         max(provision_ms)                                        AS slowest_ms
       FROM leases
       WHERE created_at > now() - $1::interval
       GROUP BY app_slug
       ORDER BY app_slug`,
      [since],
    );

    // Recent failures, with their reasons — the thing you actually need when
    // the failure rate goes up.
    const { rows: failures } = await this.store.pool.query(
      `SELECT id, app_slug, error, created_at
         FROM leases
        WHERE state = 'FAILED' AND created_at > now() - $1::interval
        ORDER BY created_at DESC
        LIMIT 10`,
      [since],
    );

    const { rows: live } = await this.store.pool.query(
      `SELECT state, count(*)::int AS n FROM leases
        WHERE state IN ('PROVISIONING','READY_UNCLAIMED','CLAIMED','DESTROYING')
        GROUP BY state`,
    );

    // Spend. Destroyed trials carry a recorded estimate; anything still alive
    // is charged from its start until now.
    const { rows: spentRows } = await this.store.pool.query(
      `SELECT coalesce(sum(estimated_cost), 0)::float AS spent
         FROM leases
        WHERE destroyed_at > now() - $1::interval`,
      [since],
    );

    const { rows: openRows } = await this.store.pool.query(
      `SELECT app_slug, created_at FROM leases
        WHERE state IN ('PROVISIONING','READY_UNCLAIMED','CLAIMED')`,
    );
    let openCost = 0;
    for (const row of openRows) {
      const manifest = this.catalog.get(row.app_slug);
      if (!manifest) continue;
      openCost += estimateCostUsd(manifest.services, Date.now() - new Date(row.created_at).getTime());
    }

    const totals = outcomes.reduce(
      (acc, r) => ({
        attempted: acc.attempted + r.attempted,
        succeeded: acc.succeeded + r.succeeded,
        failed: acc.failed + r.failed,
        claimed: acc.claimed + r.claimed,
      }),
      { attempted: 0, succeeded: 0, failed: 0, claimed: 0 },
    );

    const finished = totals.succeeded + totals.failed;
    const failureRate = finished ? totals.failed / finished : 0;

    return {
      windowHours,
      health: this.#verdict({ finished, failureRate, live }),
      failureRate: Number(failureRate.toFixed(3)),
      totals,
      perApp: outcomes.map((r) => ({
        app: r.app_slug,
        attempted: r.attempted,
        succeeded: r.succeeded,
        failed: r.failed,
        claimed: r.claimed,
        p50Seconds: r.p50_ms == null ? null : Math.round(r.p50_ms / 1000),
        p95Seconds: r.p95_ms == null ? null : Math.round(r.p95_ms / 1000),
        slowestSeconds: r.slowest_ms == null ? null : Math.round(r.slowest_ms / 1000),
      })),
      live: Object.fromEntries(live.map((r) => [r.state, r.n])),
      capacity: {
        inUse: live.reduce((n, r) => n + (r.state === 'DESTROYING' ? 0 : r.n), 0),
        ceiling: LIMITS.maxConcurrentTrials,
      },
      spend: {
        // Labelled everywhere it surfaces: computed from published list prices,
        // not read from a billing API.
        estimated: true,
        destroyedUsd: Number(spentRows[0].spent.toFixed(4)),
        openUsd: Number(openCost.toFixed(4)),
        totalUsd: Number((spentRows[0].spent + openCost).toFixed(4)),
      },
      recentFailures: failures.map((f) => ({
        id: f.id,
        app: f.app_slug,
        at: f.created_at,
        // Errors can be long stack-ish strings; a dashboard wants the gist.
        error: String(f.error ?? '').split('\n')[0].slice(0, 200),
      })),
    };
  }

  /**
   * A single verdict, so a human (or an uptime check) does not have to read a
   * table to know whether something is wrong.
   */
  #verdict({ finished, failureRate, live }) {
    if (finished === 0) {
      const provisioning = live.find((r) => r.state === 'PROVISIONING')?.n ?? 0;
      return provisioning > 0 ? Health.OK : Health.IDLE;
    }
    if (failureRate >= 0.5) return Health.FAILING;
    if (failureRate >= 0.2) return Health.DEGRADED;
    return Health.OK;
  }
}
