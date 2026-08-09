/**
 * The reaper — the component that stops OpenTry becoming an expensive mistake.
 *
 * Two jobs:
 *
 *  1. Destroy leases that have outlived their TTL, failed, or hung mid-provision.
 *  2. Destroy ORPHANS — projects carrying our tag in the Zerops account that
 *     have no corresponding lease row. These appear if the controller dies
 *     between `importProject` returning and the database write landing. Without
 *     this sweep such a project would run, and bill, forever with nothing
 *     pointing at it.
 *
 * SAFETY. Every deletion goes through `ZeropsClient#deleteProject`, which
 * re-fetches the project and refuses unless it carries `OPENTRY_EPHEMERAL`.
 * The reaper never deletes by name, by pattern, or by "everything in the
 * account". Orphan detection is deliberately conservative: a project is only
 * an orphan if it is tagged as ours AND is older than a grace window, so a
 * project mid-import is never mistaken for one.
 */

import { LEASE_TAG, LIMITS } from '../../shared/src/limits.mjs';
import { estimateCostUsd } from '../../provisioner/src/cost.mjs';

/** An orphan must be at least this old before we touch it. */
const ORPHAN_MIN_AGE_MS = 15 * 60 * 1000;

export class Reaper {
  constructor({ store, client, catalog, log = console.log }) {
    this.store = store;
    this.client = client;
    this.catalog = catalog;
    this.log = log;
    this.timer = null;
    this.running = false;
  }

  start(intervalMs = LIMITS.reaperIntervalMs) {
    if (this.timer) return;
    this.timer = setInterval(() => void this.sweep().catch((e) => this.log(`[reaper] ${e.message}`)), intervalMs);
    this.timer.unref?.();
    this.log(`[reaper] started, sweeping every ${intervalMs / 1000}s`);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async sweep() {
    if (this.running) return; // never overlap sweeps
    this.running = true;
    try {
      await this.#reapExpired();
      await this.#reapOrphans();
    } finally {
      this.running = false;
    }
  }

  async #reapExpired() {
    const due = await this.store.findReapable({
      graceMs: LIMITS.reaperGraceMs,
      provisionTimeoutMs: LIMITS.provisionTimeoutMs + 120_000,
      warmMaxAgeMs: LIMITS.warmMaxAgeMs,
    });

    for (const lease of due) {
      try {
        await this.store.markDestroying(lease.id);

        const manifest = this.catalog.get(lease.app_slug);
        const lifetimeMs = Date.now() - new Date(lease.created_at).getTime();
        const cost = manifest ? estimateCostUsd(manifest.services, lifetimeMs) : null;

        await this.client.deleteProject(lease.project_id, LEASE_TAG);
        await this.store.markDestroyed(lease.id, { estimatedCost: cost });

        this.log(
          `[reaper] destroyed ${lease.app_slug}/${lease.id} ` +
            `(lived ${Math.round(lifetimeMs / 60_000)}m, ~$${cost ?? '?'})`,
        );
      } catch (err) {
        // A project already gone by hand yields a 404 — treat that as done
        // rather than retrying it every 30 seconds forever.
        if (err.status === 404 || /not found/i.test(err.message)) {
          await this.store.markDestroyed(lease.id, {});
          this.log(`[reaper] ${lease.id} already gone, marked destroyed`);
        } else {
          this.log(`[reaper] FAILED to destroy ${lease.id}: ${err.message}`);
        }
      }
    }
  }

  async #reapOrphans() {
    let projects;
    try {
      projects = await this.client.listProjects();
    } catch (err) {
      this.log(`[reaper] could not list projects: ${err.message}`);
      return;
    }

    const known = await this.store.knownProjectIds();
    const cutoff = Date.now() - ORPHAN_MIN_AGE_MS;

    for (const project of projects) {
      const tags = project.tags ?? project.tagList ?? [];
      if (!tags.includes(LEASE_TAG)) continue; // not ours — never touch
      if (known.has(project.id)) continue; // accounted for

      const created = new Date(project.created ?? project.createdAt ?? 0).getTime();
      if (Number.isFinite(created) && created > cutoff) continue; // too young to judge

      try {
        await this.client.deleteProject(project.id, LEASE_TAG);
        this.log(`[reaper] destroyed ORPHAN ${project.name} (${project.id})`);
      } catch (err) {
        this.log(`[reaper] failed to destroy orphan ${project.id}: ${err.message}`);
      }
    }
  }

  /** Destroy a specific trial on the visitor's request. Returns the receipt. */
  async destroyNow(leaseId) {
    const lease = await this.store.getLease(leaseId);
    if (!lease) throw new Error('unknown trial');
    if (lease.state === 'DESTROYED') return { alreadyDestroyed: true };

    const manifest = this.catalog.get(lease.app_slug);
    const lifetimeMs = Date.now() - new Date(lease.created_at).getTime();
    const cost = manifest ? estimateCostUsd(manifest.services, lifetimeMs) : null;

    await this.store.markDestroying(lease.id);
    await this.client.deleteProject(lease.project_id, LEASE_TAG);
    await this.store.markDestroyed(lease.id, { estimatedCost: cost });

    return {
      leaseId,
      lifetimeMs,
      estimatedCostUsd: cost,
      removed: ['containers', 'database', 'storage', 'credentials', 'routes'],
    };
  }
}
