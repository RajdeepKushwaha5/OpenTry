/**
 * Proof-of-work and cost-model tests.
 *
 * The PoW cases are all attack cases. Each one is a way somebody could claim a
 * trial without paying the CPU cost, so each is asserted explicitly rather
 * than assumed from reading the code.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { issueChallenge, verifySolution, solve, DIFFICULTY } from '../src/proof-of-work.mjs';
import { estimateCostUsd, monthlyEquivalentUsd, costPerMinute } from '../../provisioner/src/cost.mjs';

describe('proof of work', () => {
  test('accepts a correctly solved challenge', () => {
    const c = issueChallenge('demo', 12);
    const solution = solve(c.challenge, 12);
    assert.deepEqual(verifySolution({ challenge: c.challenge, solution, appSlug: 'demo' }), {
      ok: true,
    });
  });

  test('rejects replay — a solved challenge is single-use', () => {
    const c = issueChallenge('demo', 12);
    const solution = solve(c.challenge, 12);
    verifySolution({ challenge: c.challenge, solution, appSlug: 'demo' });
    const second = verifySolution({ challenge: c.challenge, solution, appSlug: 'demo' });
    assert.equal(second.ok, false);
    assert.match(second.reason, /already used/);
  });

  test('rejects a challenge issued for a different app', () => {
    const c = issueChallenge('cheap-app', 12);
    const solution = solve(c.challenge, 12);
    const r = verifySolution({ challenge: c.challenge, solution, appSlug: 'expensive-app' });
    assert.equal(r.ok, false, 'must not let a cheap challenge unlock a costly app');
    assert.match(r.reason, /different app/);
  });

  test('rejects insufficient work', () => {
    const c = issueChallenge('demo', 20);
    const r = verifySolution({ challenge: c.challenge, solution: '1', appSlug: 'demo' });
    assert.equal(r.ok, false);
    assert.match(r.reason, /insufficient work/);
  });

  test('rejects a forged signature — difficulty cannot be self-lowered', () => {
    const real = issueChallenge('demo', 21);
    // Rewrite the difficulty down and keep the original MAC.
    const forged = real.challenge.replace(/^demo\.21\./, 'demo.1.');
    const r = verifySolution({ challenge: forged, solution: '0', appSlug: 'demo' });
    assert.equal(r.ok, false);
    assert.match(r.reason, /bad signature/);
  });

  test('rejects an expired challenge', () => {
    const c = issueChallenge('demo', 12);
    const [slug, bits, nonce, , mac] = c.challenge.split('.');
    const stale = [slug, bits, nonce, String(Date.now() - 1000), mac].join('.');
    const r = verifySolution({ challenge: stale, solution: '0', appSlug: 'demo' });
    assert.equal(r.ok, false);
    // Signature covers the expiry, so tampering with it trips that check first.
    assert.ok(/expired|bad signature/.test(r.reason), r.reason);
  });

  test('rejects malformed input rather than throwing', () => {
    for (const challenge of ['', 'x', 'a.b.c', null, undefined, 12345]) {
      const r = verifySolution({ challenge, solution: '0', appSlug: 'demo' });
      assert.equal(r.ok, false, `should reject ${JSON.stringify(challenge)}`);
    }
  });

  test('risky apps cost strictly more work than safe ones', () => {
    assert.ok(DIFFICULTY.elevated > DIFFICULTY.standard);
  });
});

describe('cost model', () => {
  // Published Zerops list prices, per 30 days:
  //   shared CPU $0.60/core, dedicated $6.00/core,
  //   RAM $3.00/GB, disk $0.10/GB
  const MINUTES_30D = 43_200;

  test('shared and dedicated CPU are priced apart by 10x', () => {
    const shared = costPerMinute({ cpu: 1, ramGb: 0, diskGb: 0, cpuMode: 'SHARED' });
    const dedicated = costPerMinute({ cpu: 1, ramGb: 0, diskGb: 0, cpuMode: 'DEDICATED' });
    assert.ok(Math.abs(dedicated / shared - 10) < 0.01, `ratio was ${dedicated / shared}`);
  });

  test('a full 30 days of usage equals the published monthly rate', () => {
    const svc = [{ verticalAutoscaling: { maxCpu: 1, maxRam: 1, maxDisk: 1, cpuMode: 'SHARED' } }];
    const month = estimateCostUsd(svc, MINUTES_30D * 60_000);
    const expected = 0.6 + 3.0 + 0.1; // 1 core + 1 GB RAM + 1 GB disk
    assert.ok(Math.abs(month - expected) < 0.01, `got ${month}, expected ~${expected}`);
  });

  test('cost scales linearly with time', () => {
    const svc = [{ verticalAutoscaling: { maxCpu: 2, maxRam: 2, maxDisk: 5 } }];
    const ten = estimateCostUsd(svc, 10 * 60_000);
    const twenty = estimateCostUsd(svc, 20 * 60_000);
    assert.ok(Math.abs(twenty / ten - 2) < 0.01);
  });

  test('bills a minimum of one minute — Zerops bills whole minutes', () => {
    const svc = [{ verticalAutoscaling: { maxCpu: 1, maxRam: 1 } }];
    assert.equal(estimateCostUsd(svc, 1000), estimateCostUsd(svc, 60_000));
  });

  test('estimates from the ceiling, so it never under-reports', () => {
    // Vertical autoscaling means real usage is usually below max. Over-
    // estimating is the safe direction when the number is on screen.
    const svc = [{ verticalAutoscaling: { minCpu: 1, maxCpu: 2, minRam: 0.25, maxRam: 2 } }];
    const perMin = estimateCostUsd(svc, 60_000);
    const atMin = costPerMinute({ cpu: 1, ramGb: 0.25, diskGb: 0 });
    assert.ok(perMin > atMin, 'must use max, not min');
  });

  test('a real trial stack is cents per month, not dollars', () => {
    const stack = [
      { verticalAutoscaling: { maxCpu: 2, maxRam: 1, maxDisk: 5 } },
      { verticalAutoscaling: { cpu: 2, ram: 2, disk: 5 } },
    ];
    const halfHour = estimateCostUsd(stack, 30 * 60_000);
    const monthly = monthlyEquivalentUsd(stack);
    assert.ok(halfHour < 0.02, `30-min trial should be under 2 cents, got ${halfHour}`);
    assert.ok(monthly > 1 && monthly < 20, `monthly equivalent looked wrong: ${monthly}`);
  });
});
