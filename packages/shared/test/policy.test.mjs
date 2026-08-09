/**
 * Policy tests.
 *
 * The default here is a security decision: Zerops cannot firewall a trial's
 * egress, so an app that makes outbound requests is an open proxy in anonymous
 * hands. "Off unless someone opts in" must hold even if a manifest says
 * nothing, and the kill switch must work without a redeploy.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { appPolicy, partitionCatalog, disabledApps, elevatedAllowed } from '../src/policy.mjs';

const app = (slug, level, hidden = false) => ({
  app: { slug, name: slug, hidden, capabilities: { level } },
});

describe('app policy', () => {
  test('safe apps are offered by default', () => {
    assert.deepEqual(appPolicy(app('umami', 'standard'), {}), { offered: true, reason: null });
  });

  test('elevated-risk apps are WITHHELD by default', () => {
    const p = appPolicy(app('n8n', 'elevated'), {});
    assert.equal(p.offered, false, 'no-egress-filtering means risky apps must be opt-in');
    assert.equal(p.reason, 'elevated-risk-not-enabled');
  });

  test('an operator can opt in explicitly', () => {
    const p = appPolicy(app('n8n', 'elevated'), { OPENTRY_ALLOW_ELEVATED: 'true' });
    assert.equal(p.offered, true);
  });

  test('only unambiguous values enable it', () => {
    for (const v of ['false', 'no', '0', '', 'maybe', undefined]) {
      assert.equal(elevatedAllowed({ OPENTRY_ALLOW_ELEVATED: v }), false, `"${v}" must not enable`);
    }
    for (const v of ['true', 'TRUE', '1', 'yes', 'on']) {
      assert.equal(elevatedAllowed({ OPENTRY_ALLOW_ELEVATED: v }), true);
    }
  });

  test('kill switch withdraws an app immediately', () => {
    const env = { OPENTRY_DISABLED_APPS: 'umami, metabase' };
    assert.equal(appPolicy(app('umami', 'standard'), env).reason, 'disabled-by-operator');
    assert.equal(appPolicy(app('n8n', 'standard'), env).offered, true);
  });

  test('kill switch beats the opt-in', () => {
    const env = { OPENTRY_ALLOW_ELEVATED: 'true', OPENTRY_DISABLED_APPS: 'n8n' };
    assert.equal(appPolicy(app('n8n', 'elevated'), env).offered, false);
  });

  test('kill switch is case and whitespace tolerant', () => {
    const env = { OPENTRY_DISABLED_APPS: '  UMAMI ,, ' };
    assert.equal(appPolicy(app('umami', 'standard'), env).offered, false);
    assert.deepEqual([...disabledApps(env)], ['umami']);
  });

  test('hidden apps are never offered', () => {
    assert.equal(appPolicy(app('hello', 'standard', true), {}).reason, 'hidden');
  });

  test('an unknown app is refused, not crashed on', () => {
    assert.equal(appPolicy(undefined, {}).offered, false);
  });
});

describe('catalog partitioning', () => {
  const catalog = new Map([
    ['umami', app('umami', 'standard')],
    ['n8n', app('n8n', 'elevated')],
    ['metabase', app('metabase', 'elevated')],
    ['hello', app('hello', 'standard', true)],
  ]);

  test('withholds risky apps and excludes hidden ones entirely', () => {
    const { offered, withheld } = partitionCatalog(catalog, {});
    assert.deepEqual(offered.map((o) => o.manifest.app.slug), ['umami']);
    assert.deepEqual(withheld.map((w) => w.manifest.app.slug).sort(), ['metabase', 'n8n']);
  });

  test('opting in moves them across', () => {
    const { offered, withheld } = partitionCatalog(catalog, { OPENTRY_ALLOW_ELEVATED: '1' });
    assert.equal(offered.length, 3);
    assert.equal(withheld.length, 0);
  });
});
