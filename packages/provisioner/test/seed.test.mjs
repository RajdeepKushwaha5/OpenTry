/**
 * Seed-runner tests.
 *
 * Seeding runs unattended against a live trial, so its failure behaviour
 * matters as much as its success path: a broken seed step must never cost a
 * visitor a working trial.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { runSeed, normaliseSeedStep } from '../src/seed.mjs';

/** Minimal stub of an app being seeded. */
async function stubApp(handler) {
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() };
}

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

describe('seed runner', () => {
  test('captures a value and uses it in a later step', async () => {
    const seen = [];
    const app = await stubApp((req, res) => {
      if (req.url === '/token') return json(res, 200, { 'setup-token': 'tok-123' });
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => { seen.push(JSON.parse(body)); json(res, 200, { ok: true }); });
    });

    const steps = [
      { name: 'get token', method: 'GET', path: '/token', capture: { t: 'setup-token' } },
      { name: 'use token', method: 'POST', path: '/setup', body: { token: '${t}' } },
    ].map(normaliseSeedStep);

    const result = await runSeed({ baseUrl: app.url, steps });
    app.close();
    assert.equal(result.ran, 2);
    assert.deepEqual(seen[0], { token: 'tok-123' }, 'captured value must reach the next step');
  });

  test('interpolates generated credentials', async () => {
    let received;
    const app = await stubApp((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => { received = JSON.parse(body); json(res, 200, {}); });
    });
    const steps = [normaliseSeedStep({ name: 'signup', path: '/u', body: { pw: '${OPENTRY_ADMIN_PASSWORD}' } })];
    await runSeed({ baseUrl: app.url, steps, vars: { OPENTRY_ADMIN_PASSWORD: 's3cret' } });
    app.close();
    assert.equal(received.pw, 's3cret');
  });

  test('a failing optional step does not abort the rest', async () => {
    let lastPath;
    const app = await stubApp((req, res) => {
      lastPath = req.url;
      if (req.url === '/broken') return json(res, 500, { error: 'boom' });
      json(res, 200, {});
    });
    const steps = [
      normaliseSeedStep({ name: 'broken', path: '/broken' }),
      normaliseSeedStep({ name: 'fine', path: '/fine' }),
    ];
    const result = await runSeed({ baseUrl: app.url, steps });
    app.close();
    assert.equal(result.failed, 1);
    assert.equal(result.ran, 1);
    assert.equal(lastPath, '/fine', 'must continue past a best-effort failure');
  });

  test('a failing REQUIRED step aborts', async () => {
    const app = await stubApp((_req, res) => json(res, 500, { error: 'boom' }));
    const steps = [normaliseSeedStep({ name: 'must work', path: '/x', required: true })];
    await assert.rejects(() => runSeed({ baseUrl: app.url, steps }), /Required seed step/);
    app.close();
  });

  test('no steps is a no-op, not an error', async () => {
    const r = await runSeed({ baseUrl: 'http://127.0.0.1:1', steps: [] });
    assert.deepEqual(r, { ran: 0, failed: 0, skipped: true });
  });

  test('rejects an unsupported method at parse time', () => {
    assert.throws(() => normaliseSeedStep({ name: 'x', method: 'DELETE', path: '/a' }, 0), /unsupported method/);
  });

  test('requires a path', () => {
    assert.throws(() => normaliseSeedStep({ name: 'x' }, 0), /path is required/);
  });
});
