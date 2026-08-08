/**
 * OpenTry controller — the background worker.
 *
 * Runs two loops and nothing else:
 *   1. WarmPool.reconcile()  — keep finished trials idling, ready to hand out
 *   2. Reaper.sweep()        — destroy expired trials and orphaned projects
 *
 * Deliberately separate from the API service. The API is stateless HTTP that
 * only reads and writes Postgres; only this process holds the Zerops token and
 * only this process can create or destroy infrastructure. That boundary means
 * a bug in request handling cannot provision or delete anything.
 */

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadCatalog } from '../../shared/src/catalog.mjs';
import { LIMITS } from '../../shared/src/limits.mjs';
import { ZeropsClient } from '../../provisioner/src/zerops-client.mjs';
import { LeaseStore } from './store.mjs';
import { WarmPool } from './pool.mjs';
import { Reaper } from './reaper.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const RECONCILE_INTERVAL_MS = Number(process.env.OPENTRY_RECONCILE_MS ?? 20_000);

const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);

async function main() {
  // Zerops reserves the "ZEROPS_" env prefix for its own generated variables
  // and rejects any import that defines one, so on-platform the token arrives
  // as OPENTRY_ZEROPS_TOKEN. Locally, .env.local uses the plainer name.
  const token = process.env.OPENTRY_ZEROPS_TOKEN ?? process.env.ZEROPS_TOKEN;
  if (!token) {
    console.error(
      'No Zerops token. Set OPENTRY_ZEROPS_TOKEN (on Zerops) or ZEROPS_TOKEN (locally).',
    );
    process.exit(2);
  }

  const catalog = await loadCatalog(join(ROOT, 'catalog'), { log });
  log(`[controller] catalog: ${[...catalog.keys()].join(', ')}`);

  const store = new LeaseStore();
  await store.migrate();
  log('[controller] database ready');

  const client = new ZeropsClient({ token });
  const clientId = await client.getClientId();
  log(`[controller] zerops clientId=${clientId}`);

  const pool = new WarmPool({ store, client, catalog, log });
  const reaper = new Reaper({ store, client, catalog, log });

  // Sweep before warming: reclaim anything left over from a previous process
  // so we do not start provisioning on top of a full account.
  await reaper.sweep().catch((e) => log(`[reaper] initial sweep failed: ${e.message}`));
  reaper.start();

  const tick = async () => {
    try {
      await pool.reconcile();
    } catch (err) {
      log(`[pool] reconcile failed: ${err.message}`);
    }
  };
  await tick();
  const timer = setInterval(tick, RECONCILE_INTERVAL_MS);

  log(
    `[controller] running — warm target ${pool.targetPerApp}/app, ` +
      `max ${LIMITS.maxConcurrentTrials} concurrent trials`,
  );

  // Graceful shutdown. We deliberately do NOT destroy warm trials on exit:
  // they are still valid, the reaper will collect them when they age out, and
  // tearing them down on every deploy would make restarts expensive.
  const shutdown = async (signal) => {
    log(`[controller] ${signal} received, shutting down`);
    clearInterval(timer);
    reaper.stop();
    await store.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[controller] fatal:', err);
  process.exit(1);
});
