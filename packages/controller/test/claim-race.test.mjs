/**
 * Concurrency tests for the warm-pool claim.
 *
 * This is the one piece of OpenTry whose correctness cannot be established by
 * reading it. `FOR UPDATE SKIP LOCKED` and a partial unique index are claims
 * about what Postgres does under simultaneous writes, and the failure mode —
 * two visitors handed the same trial — appears only under exactly the load a
 * live demo produces.
 *
 * Needs a real Postgres. SKIP LOCKED and partial unique indexes are not
 * faithfully emulated by in-memory substitutes, and a test that passes against
 * a fake would be worse than no test at all.
 *
 *   DATABASE_URL=postgresql://user:pass@localhost:5432/opentry_test \
 *     node --test packages/controller/test/
 *
 * Skipped, loudly, when DATABASE_URL is absent.
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { LeaseStore, LeaseState } from '../src/store.mjs';

const DB = process.env.DATABASE_URL;
const skip = DB ? false : 'set DATABASE_URL to run concurrency tests against a real Postgres';

if (!DB) {
  // A silently skipped safety test reads as a passing one. Say so.
  console.warn(
    [
      '',
      '  ! CONCURRENCY TESTS SKIPPED — no DATABASE_URL.',
      '    The claim race is UNVERIFIED in this run. To verify:',
      '      docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=pw postgres:16',
      '      DATABASE_URL=postgresql://postgres:pw@localhost:5432/postgres npm run test:db',
      '',
    ].join('\n'),
  );
}

describe('warm-pool claim under concurrency', { skip }, () => {
  let store;

  before(async () => {
    store = new LeaseStore({ connectionString: DB });
    await store.migrate();
  });

  after(async () => {
    await store?.pool.query(`DELETE FROM leases WHERE app_slug LIKE 'racetest%'`).catch(() => {});
    await store?.close();
  });

  beforeEach(async () => {
    await store.pool.query(`DELETE FROM leases WHERE app_slug LIKE 'racetest%'`);
  });

  /** Put n finished trials in the pool, ready to be claimed. */
  async function seedWarm(appSlug, n) {
    for (let i = 0; i < n; i++) {
      const id = `${appSlug}-${i}-${Date.now()}`;
      await store.createLease({ id, appSlug, ttlMinutes: 30 });
      await store.attachProject(id, { projectId: `proj-${id}`, projectName: id });
      await store.markReady(id, { url: `https://${id}.example`, credentials: [], services: [] });
    }
  }

  test('20 simultaneous visitors never receive the same trial', async () => {
    const app = 'racetest-a';
    await seedWarm(app, 5);

    // Distinct visitors, all claiming at once.
    const claims = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        store.claimWarmLease({ appSlug: app, visitorHash: `visitor-${i}`, ttlMinutes: 30 }),
      ),
    );

    const won = claims.filter(Boolean);
    const ids = won.map((l) => l.id);

    assert.equal(won.length, 5, 'exactly the 5 warm trials should be handed out');
    assert.equal(new Set(ids).size, 5, 'the same trial must never go to two visitors');
    assert.equal(claims.filter((c) => c === null).length, 15, 'the rest must get a clean miss');
  });

  test('one visitor racing themselves ends up with exactly one trial', async () => {
    const app = 'racetest-b';
    await seedWarm(app, 5);

    // The API checks for an existing trial first, but only the database can
    // close the window between that check and the claim.
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        store
          .claimWarmLease({ appSlug: app, visitorHash: 'same-person', ttlMinutes: 30 })
          .catch((e) => ({ error: e.message })),
      ),
    );

    assert.ok(
      !results.some((r) => r?.error),
      `unique violation leaked to the caller: ${results.find((r) => r?.error)?.error}`,
    );

    const { rows } = await store.pool.query(
      `SELECT count(*)::int AS n FROM leases WHERE app_slug = $1 AND state = $2`,
      [app, LeaseState.CLAIMED],
    );
    assert.equal(rows[0].n, 1, 'a visitor must hold at most one trial');
  });

  test('an empty pool returns null rather than blocking or erroring', async () => {
    const claim = await store.claimWarmLease({
      appSlug: 'racetest-empty',
      visitorHash: 'v1',
      ttlMinutes: 30,
    });
    assert.equal(claim, null);
  });

  test('claiming sets an expiry, so the reaper can always find it', async () => {
    const app = 'racetest-c';
    await seedWarm(app, 1);
    const lease = await store.claimWarmLease({ appSlug: app, visitorHash: 'v', ttlMinutes: 30 });

    assert.ok(lease.expires_at, 'a claimed trial without an expiry would run forever');
    const minutes = (new Date(lease.expires_at) - Date.now()) / 60_000;
    assert.ok(minutes > 29 && minutes <= 30, `expiry was ${minutes} minutes away`);
  });

  test('a claim never hands out another app', async () => {
    await seedWarm('racetest-x', 2);
    await seedWarm('racetest-y', 2);
    const lease = await store.claimWarmLease({
      appSlug: 'racetest-y',
      visitorHash: 'v',
      ttlMinutes: 30,
    });
    assert.equal(lease.app_slug, 'racetest-y');
  });

  test('project id is recorded before readiness, so a crash leaves a trail', async () => {
    // If the controller dies mid-provision, the reaper can only clean up what
    // the database knows about.
    const id = `racetest-crash-${Date.now()}`;
    await store.createLease({ id, appSlug: 'racetest-crash', ttlMinutes: 30 });
    await store.attachProject(id, { projectId: 'proj-abc', projectName: 'p' });

    const known = await store.knownProjectIds();
    assert.ok(known.has('proj-abc'), 'an un-finished project must still be reapable');
  });
});
