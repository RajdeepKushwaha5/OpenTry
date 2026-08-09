/**
 * Alerting.
 *
 * The metrics existed and nothing watched them, which is only marginally
 * better than not collecting them: a total provisioning outage still had to be
 * noticed by a human refreshing a page. This closes that loop.
 *
 * Two deliberate design choices:
 *
 *  1. EDGE-TRIGGERED, NOT LEVEL-TRIGGERED. An alert fires when health changes,
 *     not on every sweep. A reaper running every 30 seconds would otherwise
 *     emit 120 identical alerts an hour, and an alert you learn to ignore is
 *     worse than no alert.
 *
 *  2. RECOVERY IS ALSO AN EVENT. Being told something broke without being told
 *     it fixed itself leaves you chasing a resolved problem.
 *
 * Delivery is a webhook if one is configured, and always a structured log line.
 * The log always happens: a webhook that is misconfigured, rate-limited or
 * down must never be the reason nobody heard about an outage.
 */

import { Health } from './metrics.mjs';

/** How bad is each state, so we only shout when things get worse. */
const SEVERITY = { [Health.OK]: 0, [Health.IDLE]: 0, [Health.DEGRADED]: 1, [Health.FAILING]: 2 };

export class Alerter {
  /**
   * @param {object} deps
   * @param {import('./metrics.mjs').Metrics} deps.metrics
   * @param {string} [deps.webhookUrl]
   * @param {(msg:string)=>void} [deps.log]
   */
  constructor({ metrics, webhookUrl = process.env.OPENTRY_ALERT_WEBHOOK, log = console.log }) {
    this.metrics = metrics;
    this.webhookUrl = webhookUrl;
    this.log = log;
    this.lastHealth = null;
    this.timer = null;
  }

  start(intervalMs = Number(process.env.OPENTRY_ALERT_INTERVAL_MS ?? 120_000)) {
    if (this.timer) return;
    this.timer = setInterval(
      () => void this.check().catch((e) => this.log(`[alert] check failed: ${e.message}`)),
      intervalMs,
    );
    this.timer.unref?.();
    this.log(
      `[alert] watching provisioning health every ${intervalMs / 1000}s` +
        (this.webhookUrl ? ' (webhook configured)' : ' (log only — set OPENTRY_ALERT_WEBHOOK)'),
    );
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async check() {
    const snap = await this.metrics.snapshot({ windowHours: 2 });
    const now = snap.health;
    const before = this.lastHealth;
    this.lastHealth = now;

    if (before === now) return null; // no change

    // First observation. Normally there is nothing to report — you cannot
    // call something a change when you have not seen it before, and alerting
    // on every controller start would be noise. But starting up INTO a bad
    // state is the one case where silence is wrong: a restart during an
    // outage would adopt "failing" as the baseline and then say nothing until
    // something else moved, which is precisely when nothing else is moving.
    const firstLook = before === null;
    if (firstLook && SEVERITY[now] === 0) return null;

    const worse = firstLook || SEVERITY[now] > SEVERITY[before];
    const recovered = SEVERITY[now] === 0 && SEVERITY[before] > 0;
    if (!worse && !recovered) return null;

    const alert = {
      kind: recovered ? 'recovered' : firstLook ? 'already-degraded' : 'degraded',
      firstObservation: firstLook || undefined,
      from: before,
      to: now,
      failureRate: snap.failureRate,
      attempted: snap.totals.attempted,
      failed: snap.totals.failed,
      inUse: snap.capacity.inUse,
      ceiling: snap.capacity.ceiling,
      spendUsd: snap.spend.totalUsd,
      // The reasons, not just the fact — an alert without them means logging in
      // to find out what everyone already knows.
      recentErrors: snap.recentFailures.slice(0, 3).map((f) => `${f.app}: ${f.error}`),
      at: new Date().toISOString(),
    };

    this.#emit(alert);
    return alert;
  }

  #emit(alert) {
    const headline =
      alert.kind === 'recovered'
        ? `[alert] RECOVERED — provisioning healthy again (was ${alert.from})`
        : `[alert] ${alert.to.toUpperCase()} — provisioning ${alert.to}, ` +
          `${(alert.failureRate * 100).toFixed(0)}% of ${alert.attempted} attempts failed`;

    this.log(headline);
    for (const err of alert.recentErrors) this.log(`[alert]   ${err}`);

    if (!this.webhookUrl) return;

    // Fire and forget, with a short timeout. A slow webhook must not stall the
    // controller's own loops.
    fetch(this.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: headline, ...alert }),
      signal: AbortSignal.timeout(8000),
    }).catch((err) => this.log(`[alert] webhook delivery failed: ${err.message}`));
  }
}
