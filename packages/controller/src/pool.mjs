/**
 * The warm pool.
 *
 * Measured reality: provisioning a real trial takes ~340s (n8n on a Docker VM
 * plus managed Postgres). Nobody waits six minutes to look at a piece of
 * software — that delay is the exact reason people don't evaluate self-hosted
 * apps, which is the problem OpenTry exists to solve. So we pay the cost
 * up-front and keep finished trials idling, ready to hand over instantly.
 *
 * Invariants:
 *  - Never exceed LIMITS.maxConcurrentTrials across the whole platform. This
 *    is the blast-radius control and the thing standing between a bug and a
 *    drained account.
 *  - Only one backfill in flight per app, so a slow provision cannot cause a
 *    stampede of duplicates.
 *  - Every project id is written to the database BEFORE we wait on it, so a
 *    controller crash can never orphan infrastructure invisibly.
 */

import { LIMITS } from '../../shared/src/limits.mjs';
import { generateTrialId } from '../../shared/src/manifest.mjs';
import { provisionTrial } from '../../provisioner/src/lifecycle.mjs';
import { appPolicy } from '../../shared/src/policy.mjs';

export class WarmPool {
  /**
   * @param {object} deps
   * @param {import('./store.mjs').LeaseStore} deps.store
   * @param {import('../../provisioner/src/zerops-client.mjs').ZeropsClient} deps.client
   * @param {Map<string, object>} deps.catalog   slug -> parsed manifest
   * @param {number} [deps.targetPerApp]
   * @param {(msg: string, extra?: object) => void} [deps.log]
   */
  constructor({ store, client, catalog, targetPerApp, log = console.log }) {
    this.store = store;
    this.client = client;
    this.catalog = catalog;
    this.targetPerApp = targetPerApp ?? Number(process.env.OPENTRY_WARM_PER_APP ?? 1);
    this.log = log;
    /** @type {Set<string>} apps with a backfill currently running */
    this.inFlight = new Set();
  }

  /**
   * Bring every app up to its warm target, subject to the global cap.
   * Safe to call repeatedly; it is a no-op when the pool is full.
   */
  async reconcile() {
    const active = await this.store.activeCount();
    let budget = LIMITS.maxConcurrentTrials - active;
    if (budget <= 0) return;

    for (const [slug, manifest] of this.catalog) {
      if (budget <= 0) break;
      // Do not spend money warming something we will refuse to hand out.
      if (!appPolicy(manifest).offered) continue;
      if (this.inFlight.has(slug)) continue;

      const { ready, provisioning } = await this.store.poolDepth(slug);
      if (ready + provisioning >= this.targetPerApp) continue;

      budget--;
      // Deliberately not awaited: backfill runs in the background so the
      // reconcile loop (and any HTTP request that triggered it) returns now.
      void this.#backfill(slug, manifest);
    }
  }

  async #backfill(slug, manifest) {
    this.inFlight.add(slug);
    const trialId = generateTrialId();
    const started = Date.now();

    try {
      await this.store.createLease({
        id: trialId,
        appSlug: slug,
        ttlMinutes: manifest.trial.ttlMinutes,
      });
      this.log(`[pool] warming ${slug} (${trialId})`);

      const result = await provisionTrial({
        client: this.client,
        manifest,
        trialId,
        emit: (e) => {
          // Persist the timeline so the browser can replay it, and capture the
          // project id the moment it exists.
          void this.store.appendEvent(trialId, e).catch(() => {});
          if (e.projectId) {
            void this.store
              .attachProject(trialId, { projectId: e.projectId, projectName: e.projectName })
              .catch(() => {});
          }
        },
      });

      await this.store.markReady(trialId, {
        url: result.url,
        credentials: result.credentials,
        services: result.services,
        provisionMs: Date.now() - started,
      });
      this.log(`[pool] ${slug} warm in ${Math.round((Date.now() - started) / 1000)}s -> ${result.url}`);
    } catch (err) {
      // provisionTrial destroys the partial project on its way out, so the
      // lease is terminal here rather than left for the reaper.
      await this.store.markFailed(trialId, err.message).catch(() => {});
      this.log(`[pool] ${slug} FAILED: ${err.message}`);
    } finally {
      this.inFlight.delete(slug);
    }
  }

  /**
   * Hand a warm trial to a visitor, then immediately start replacing it.
   *
   * @returns {Promise<{lease: object|null, reason?: string}>}
   */
  async claim({ appSlug, visitorHash }) {
    const manifest = this.catalog.get(appSlug);
    const policy = appPolicy(manifest);
    if (!policy.offered) return { lease: null, reason: policy.reason };

    // One trial per visitor: free anonymous infrastructure needs a limit that
    // does not depend on the honesty of the person clicking.
    const existing = await this.store.hasActiveTrial(visitorHash);
    if (existing) return { lease: existing, reason: 'existing' };

    const lease = await this.store.claimWarmLease({
      appSlug,
      visitorHash,
      ttlMinutes: manifest.trial.ttlMinutes,
    });

    // Replace what we just gave away, regardless of outcome.
    void this.reconcile().catch(() => {});

    if (!lease) return { lease: null, reason: 'pool-empty' };
    return { lease };
  }

  async stats() {
    const out = {};
    for (const [slug] of this.catalog) out[slug] = await this.store.poolDepth(slug);
    return {
      apps: out,
      active: await this.store.activeCount(),
      maxConcurrent: LIMITS.maxConcurrentTrials,
      targetPerApp: this.targetPerApp,
    };
  }
}
