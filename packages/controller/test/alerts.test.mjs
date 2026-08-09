/**
 * Alerting tests.
 *
 * Written because the alerter had never actually fired. Code that only runs
 * during an incident is exactly the code most likely to be broken when the
 * incident arrives, so every path is exercised here with a stub metrics
 * source rather than waiting for a real outage.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Alerter } from '../src/alerts.mjs';
import { Health, Metrics } from '../src/metrics.mjs';

/** Metrics stub that returns whatever health we hand it. */
const stubMetrics = (states) => {
  let i = 0;
  return {
    snapshot: async () => ({
      health: states[Math.min(i++, states.length - 1)],
      failureRate: 0.8,
      totals: { attempted: 10, failed: 8 },
      capacity: { inUse: 2, ceiling: 6 },
      spend: { totalUsd: 0.01 },
      recentFailures: [{ app: 'demo', error: 'image pull timed out' }],
    }),
  };
};

const collector = () => {
  const lines = [];
  return { lines, log: (m) => lines.push(m) };
};

describe('alerter', () => {
  test('stays silent when the first observation is healthy', async () => {
    const { lines, log } = collector();
    const a = new Alerter({ metrics: stubMetrics([Health.OK]), log, webhookUrl: null });
    assert.equal(await a.check(), null, 'nothing to compare against, and nothing wrong');
    assert.equal(lines.length, 0);
  });

  test('reports a first observation that is ALREADY failing', async () => {
    // Starting up into an outage is the one case where "no change yet" is the
    // wrong answer. A controller restarted mid-incident would otherwise adopt
    // FAILING as its baseline and stay quiet until something moved — and
    // during an outage nothing moves.
    const { lines, log } = collector();
    const a = new Alerter({ metrics: stubMetrics([Health.FAILING]), log, webhookUrl: null });
    const alert = await a.check();
    assert.equal(alert.kind, 'already-degraded');
    assert.equal(alert.to, Health.FAILING);
    assert.equal(alert.firstObservation, true);
    assert.ok(lines.some((l) => l.includes('FAILING')), lines.join('\n'));
  });

  test('an already-failing start does not then re-alert on every sweep', async () => {
    const { lines, log } = collector();
    const a = new Alerter({ metrics: stubMetrics([Health.FAILING, Health.FAILING]), log, webhookUrl: null });
    await a.check();
    assert.equal(await a.check(), null, 'unchanged health must stay quiet');
    // One alert, not one line: an alert emits a headline plus its reasons.
    const headlines = lines.filter((l) => l.startsWith('[alert] ') && !l.startsWith('[alert]   '));
    assert.equal(headlines.length, 1, lines.join('\n'));
  });

  test('fires when health gets worse', async () => {
    const { lines, log } = collector();
    const a = new Alerter({ metrics: stubMetrics([Health.OK, Health.FAILING]), log, webhookUrl: null });
    await a.check();
    const alert = await a.check();
    assert.equal(alert.kind, 'degraded');
    assert.equal(alert.to, Health.FAILING);
    assert.ok(lines.some((l) => l.includes('FAILING')), lines.join('\n'));
    assert.ok(lines.some((l) => l.includes('image pull timed out')), 'must include the reason');
  });

  test('does NOT repeat while the state persists', async () => {
    // A 30s sweep would otherwise emit 120 identical alerts an hour, and an
    // alert you learn to ignore is worse than no alert.
    const { lines, log } = collector();
    const a = new Alerter({
      metrics: stubMetrics([Health.OK, Health.FAILING, Health.FAILING, Health.FAILING]),
      log,
      webhookUrl: null,
    });
    await a.check();
    await a.check();
    const before = lines.length;
    await a.check();
    await a.check();
    assert.equal(lines.length, before, 'repeat observations must stay quiet');
  });

  test('reports recovery', async () => {
    const { lines, log } = collector();
    const a = new Alerter({ metrics: stubMetrics([Health.OK, Health.FAILING, Health.OK]), log, webhookUrl: null });
    await a.check();
    await a.check();
    const alert = await a.check();
    assert.equal(alert.kind, 'recovered');
    assert.ok(lines.some((l) => l.includes('RECOVERED')));
  });

  test('does not shout when things merely get better but stay bad', async () => {
    const a = new Alerter({
      metrics: stubMetrics([Health.FAILING, Health.DEGRADED]),
      log: () => {},
      webhookUrl: null,
    });
    await a.check();
    assert.equal(await a.check(), null, 'failing -> degraded is an improvement, not news');
  });

  test('idle is not treated as an outage', async () => {
    const a = new Alerter({ metrics: stubMetrics([Health.OK, Health.IDLE]), log: () => {}, webhookUrl: null });
    await a.check();
    assert.equal(await a.check(), null, 'an empty pool at 3am is not an incident');
  });

  test('a broken webhook never suppresses the log', async () => {
    const { lines, log } = collector();
    const a = new Alerter({
      metrics: stubMetrics([Health.OK, Health.FAILING]),
      log,
      webhookUrl: 'http://127.0.0.1:1/nope',
    });
    await a.check();
    await a.check();
    assert.ok(lines.some((l) => l.includes('FAILING')), 'the log must land regardless');
  });
});

/**
 * The health verdict is what a monitor pages on, so its recency behaviour is
 * worth pinning down. These drive the private #verdict through snapshot() with
 * a stub pool, which is the only seam available and the one that matters.
 */
describe('health verdict reads recent outcomes, not the whole window', () => {
  /** @param {boolean[]} recent newest-first outcome list; true = failed */
  const metricsWith = (recent) => {
    const pool = {
      query: async (sql) => {
        if (/ORDER BY created_at DESC/.test(sql)) return { rows: recent.map((f) => ({ failed: f })) };
        if (/FROM leases\s+WHERE state IN/.test(sql)) return { rows: [] };
        if (/percentile_cont/.test(sql)) return { rows: [] };
        if (/coalesce\(sum/.test(sql)) return { rows: [{ spent: 0 }] };
        return { rows: [] };
      },
    };
    return new Metrics({ store: { pool }, catalog: new Map() });
  };

  test('a burst of old failures clears as successes push it out of view', async () => {
    // The real incident: six failures in a 25-minute burst, bug fixed, every
    // attempt afterwards succeeded. Under the old window-average verdict this
    // reported FAILING for hours and /api/health/deep returned 503 the whole
    // time. Recovery should track the recent run, not the window.
    const F = true;
    const S = false;
    const verdict = async (recent) => (await metricsWith(recent).snapshot({ windowHours: 6 })).health;

    // Newest first. Four successes so far — six of the last ten still failed.
    assert.equal(await verdict([S, S, S, S, F, F, F, F, F, F]), Health.FAILING);
    // Eight successes: 2/10 recent failures.
    assert.equal(await verdict([S, S, S, S, S, S, S, S, F, F]), Health.DEGRADED);
    // The burst has fallen out of the last ten entirely.
    assert.equal(await verdict(Array(10).fill(S)), Health.OK);
  });

  test('failing now reads FAILING even if the window looks fine', async () => {
    const snap = await metricsWith([true, true, true, true, true, false]).snapshot({ windowHours: 6 });
    assert.equal(snap.health, Health.FAILING);
  });

  test('nothing finished and nothing building is idle, not healthy', async () => {
    const snap = await metricsWith([]).snapshot({ windowHours: 6 });
    assert.equal(snap.health, Health.IDLE);
  });
});
