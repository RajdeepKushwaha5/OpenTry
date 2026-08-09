/**
 * Authorization tests.
 *
 * Every rule here was got wrong once and shipped. `GET /api/trials/:id`
 * returned credentials to anyone; the SSE stream sent them for unclaimed
 * trials; DELETE skipped its ownership check entirely for the warm pool. All
 * three were live and reachable with nothing but a trial id — and trial ids are
 * published by /api/pool/building so the UI can show real provisioning.
 *
 * So these are not defensive unit tests around obvious code. Each one is a
 * request an attacker can make with curl and no account.
 *
 *   node --test packages/api/test/
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ownsTrial,
  canViewTrial,
  canDestroyTrial,
  publicEvent,
  readyPayload,
  bucketFor,
} from '../src/authz.mjs';

const ME = 'fingerprint-me';
const THEM = 'fingerprint-them';

const lease = (over = {}) => ({
  id: 'abc123',
  app_slug: 'umami',
  state: 'CLAIMED',
  visitor_hash: ME,
  url: 'https://app-2d72-3000.prg1.zerops.app',
  ...over,
});

/** Stand-in for server.mjs's `shape`, which includes url + credentials. */
const shape = (l) => ({
  id: l.id,
  url: l.url,
  credentials: [{ label: 'password', value: 'hunter2' }],
});

describe('reading a trial', () => {
  test('the holder can read it', () => {
    assert.equal(canViewTrial(lease(), ME), true);
  });

  test('a stranger with the id cannot', () => {
    // The original bug, exactly: knowing the id was sufficient.
    assert.equal(canViewTrial(lease(), THEM), false);
  });

  test('a warm trial belongs to nobody, including the next caller', () => {
    const warm = lease({ state: 'READY_UNCLAIMED', visitor_hash: null });
    assert.equal(canViewTrial(warm, ME), false);
    assert.equal(canViewTrial(warm, THEM), false);
  });

  test('an unclaimed lease and a caller with no fingerprint are not "equal"', () => {
    // null === null would have been true. This is the sharp edge of comparing
    // an absent owner against an absent caller.
    const warm = lease({ state: 'READY_UNCLAIMED', visitor_hash: null });
    assert.equal(canViewTrial(warm, null), false);
    assert.equal(canViewTrial(warm, undefined), false);
    assert.equal(canViewTrial(warm, ''), false);
  });

  test('a claimed lease still requires the state, not just the hash', () => {
    // A PROVISIONING row can carry a visitor_hash in some flows; the hash alone
    // must not be the whole test.
    assert.equal(canViewTrial(lease({ state: 'PROVISIONING' }), ME), false);
    assert.equal(canViewTrial(lease({ state: 'DESTROYED' }), ME), false);
  });

  test('ownership, view and destroy agree today and are asserted separately', () => {
    for (const fn of [ownsTrial, canViewTrial, canDestroyTrial]) {
      assert.equal(fn(lease(), ME), true, fn.name);
      assert.equal(fn(lease(), THEM), false, fn.name);
    }
  });
});

describe('destroying a trial', () => {
  test('a stranger cannot destroy an unclaimed warm trial', () => {
    // This one did not merely leak — it let anyone expire the pool the demo
    // runs on, using an id the pool endpoint hands out.
    const warm = lease({ state: 'READY_UNCLAIMED', visitor_hash: null });
    assert.equal(canDestroyTrial(warm, THEM), false);
  });

  test('a stranger cannot destroy something still provisioning', () => {
    const building = lease({ state: 'PROVISIONING', visitor_hash: null });
    assert.equal(canDestroyTrial(building, THEM), false);
  });
});

describe('the public provisioning stream', () => {
  test('a step frame carries no internal metadata', () => {
    const row = {
      id: 12,
      at_ms: 400,
      step: 'import',
      status: 'ok',
      message: 'Isolated project created',
      // Everything below is written by the controller for its own debugging.
      meta: { projectId: 'secret-project-id', url: 'https://trial.example' },
      project_id: 'secret-project-id',
    };
    const out = publicEvent(row);
    assert.deepEqual(Object.keys(out).sort(), ['at_ms', 'id', 'message', 'status', 'step']);
    assert.equal(JSON.stringify(out).includes('secret-project-id'), false);
  });

  test('a field added to an event later does not become public by default', () => {
    // Allowlist, not blocklist — the reason publicEvent enumerates rather than
    // deletes. A future column must not leak because nobody updated a list.
    const out = publicEvent({ id: 1, at_ms: 0, step: 's', status: 'ok', message: 'm', newSecret: 'x' });
    assert.equal('newSecret' in out, false);
  });

  test('ready sends credentials to the holder', () => {
    const out = readyPayload(lease(), ME, shape);
    assert.ok(out.credentials, 'the person who claimed it must get the password');
    assert.equal(out.url, lease().url);
  });

  test('ready sends no credentials to anyone watching the pool', () => {
    // The pool-watch stream is public on purpose — it is how visitors see that
    // provisioning is real. It must still be safe to leave open.
    for (const [who, l] of [
      ['stranger on a claimed trial', lease()],
      ['anyone on a warm trial', lease({ state: 'READY_UNCLAIMED', visitor_hash: null })],
    ]) {
      const out = readyPayload(l, THEM, shape);
      assert.equal(out.credentials, undefined, who);
      assert.equal(out.url, undefined, who);
      assert.equal(out.state, 'ready', who);
    }
  });
});

describe('rate-limit buckets', () => {
  const limits = { strict: 30, poll: 240 };
  const get = (path) => bucketFor({ method: 'GET', path }, limits);

  test('the UI pollers do not spend the claim budget', () => {
    // 27 req/min at idle against a 30/min shared bucket meant the 429 landed
    // on the Try button.
    for (const p of ['/api/pool', '/api/pool/building', '/api/metrics', '/api/catalog', '/api/trials/mine']) {
      assert.equal(get(p).name, 'poll', p);
      assert.equal(get(p).max, 240, p);
    }
  });

  test('reading and streaming one trial is polling', () => {
    assert.equal(get('/api/trials/abc123').name, 'poll');
    assert.equal(get('/api/trials/abc123/events').name, 'poll');
  });

  test('anything that can create infrastructure keeps the strict budget', () => {
    assert.equal(bucketFor({ method: 'POST', path: '/api/trials' }, limits).max, 30);
    assert.equal(bucketFor({ method: 'DELETE', path: '/api/trials/abc' }, limits).max, 30);
    assert.equal(bucketFor({ method: 'POST', path: '/api/validate' }, limits).max, 30);
  });

  test('an unknown read is strict, not generous', () => {
    // Default deny on budget too: a new endpoint should not inherit the
    // generous bucket merely by existing.
    assert.equal(get('/api/something/new').max, 30);
    assert.equal(get('/api/trials/abc/extra/path').max, 30);
  });
});
