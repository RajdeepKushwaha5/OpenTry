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
import { Health } from '../src/metrics.mjs';

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
