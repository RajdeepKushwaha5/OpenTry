/**
 * OpenTry API — the only publicly reachable service.
 *
 * SECURITY BOUNDARY: this process does NOT hold the Zerops token and cannot
 * create or destroy infrastructure directly. It reads and writes Postgres;
 * the controller does everything else. Claiming a trial is a single atomic
 * UPDATE, and destroying one sets a flag the reaper acts on. The worst a
 * compromised request handler can do is mark rows.
 *
 * (`/api/trials/:id` DELETE is the one exception and is discussed inline.)
 */

import express from 'express';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadCatalog, publicCatalog } from '../../shared/src/catalog.mjs';
import { LIMITS } from '../../shared/src/limits.mjs';
import { LeaseStore, visitorFingerprint, LeaseState } from '../../controller/src/store.mjs';
import { issueChallenge, verifySolution, DIFFICULTY } from '../../shared/src/proof-of-work.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PORT = Number(process.env.PORT ?? 3000);

const catalog = await loadCatalog(join(ROOT, 'catalog'));
const store = new LeaseStore();
await store.migrate();

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));

// -- tiny in-memory rate limiter --------------------------------------------
// Deliberately not a dependency: one counter per fingerprint, reset on a
// rolling window. Enough to stop a script hammering claim attempts, and it
// costs nothing. Real abuse protection is the per-visitor trial cap and the
// global concurrency ceiling, both enforced in the database.
const hits = new Map();
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 30;

function rateLimit(req, res, next) {
  const key = visitorFingerprint(req);
  const now = Date.now();
  const rec = hits.get(key);
  if (!rec || now - rec.start > RATE_WINDOW_MS) {
    hits.set(key, { start: now, n: 1 });
    return next();
  }
  if (++rec.n > RATE_MAX) {
    return res.status(429).json({ error: 'Too many requests. Wait a minute.' });
  }
  next();
}
setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW_MS;
  for (const [k, v] of hits) if (v.start < cutoff) hits.delete(k);
}, RATE_WINDOW_MS).unref?.();

app.use('/api', rateLimit);

// -- routes ------------------------------------------------------------------

app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/api/catalog', (_req, res) => {
  res.json({ apps: publicCatalog(catalog) });
});

/**
 * Pool telemetry. Public on purpose: the demo shows this live, and it is the
 * honest proof that trials are real infrastructure being continuously
 * provisioned and destroyed rather than a canned recording.
 */
app.get('/api/pool', async (_req, res) => {
  const apps = {};
  for (const [slug, m] of catalog) {
    if (m.app.hidden) continue;
    apps[slug] = await store.poolDepth(slug);
  }
  res.json({
    apps,
    active: await store.activeCount(),
    maxConcurrent: LIMITS.maxConcurrentTrials,
  });
});

/**
 * What is being built right now, so the UI can stream its timeline.
 *
 * This is the "honest reveal": visitors get an instant handoff, and this shows
 * the five minutes of real work that made it instant. Public on purpose.
 */
app.get('/api/pool/building', async (_req, res) => {
  const lease = await store.currentlyProvisioning();
  if (!lease) return res.json({ building: null });
  res.json({
    building: {
      id: lease.id,
      app: lease.app_slug,
      startedAt: lease.created_at,
      elapsedMs: Date.now() - new Date(lease.created_at).getTime(),
    },
  });
});

/**
 * Issue a proof-of-work challenge.
 *
 * Difficulty scales with what the app can do. Zerops has no egress filtering,
 * so an app that can make outbound requests is, in anonymous hands, a proxy —
 * we cannot isolate it at the network layer, so we make volume expensive
 * instead. An honest visitor pays about a second of CPU once.
 */
app.get('/api/challenge', (req, res) => {
  const slug = String(req.query.app ?? '');
  const manifest = catalog.get(slug);
  if (!manifest || manifest.app.hidden) {
    return res.status(404).json({ error: `Unknown app "${slug}"` });
  }
  const bits =
    manifest.app.capabilities.level === 'elevated' ? DIFFICULTY.elevated : DIFFICULTY.standard;
  res.json(issueChallenge(slug, bits));
});

/** Claim a warm trial. */
app.post('/api/trials', async (req, res) => {
  const slug = String(req.body?.app ?? '');
  const manifest = catalog.get(slug);
  if (!manifest || manifest.app.hidden) {
    return res.status(404).json({ error: `Unknown app "${slug}"` });
  }

  // Proof of work before anything expensive happens.
  const pow = verifySolution({
    challenge: req.body?.challenge,
    solution: String(req.body?.solution ?? ''),
    appSlug: slug,
  });
  if (!pow.ok) {
    return res.status(400).json({ error: `Proof of work failed: ${pow.reason}`, reason: 'pow' });
  }

  const visitorHash = visitorFingerprint(req);

  const existing = await store.hasActiveTrial(visitorHash);
  if (existing) {
    return res.status(409).json({
      error: 'You already have a trial running.',
      trial: shape(existing),
      reason: 'existing',
    });
  }

  const lease = await store.claimWarmLease({
    appSlug: slug,
    visitorHash,
    ttlMinutes: manifest.trial.ttlMinutes,
  });

  if (!lease) {
    // Honest failure. The controller is already backfilling; telling the
    // visitor the truth ("one is being built, ~6 minutes") beats a spinner
    // that silently waits, and it is the moment the product's real cost
    // becomes visible — which is the story, not something to hide.
    const depth = await store.poolDepth(slug);
    return res.status(503).json({
      error: 'No warm trial available right now.',
      reason: 'pool-empty',
      building: depth.provisioning > 0,
      retryAfterSeconds: 30,
    });
  }

  res.status(201).json({ trial: shape(lease) });
});

app.get('/api/trials/:id', async (req, res) => {
  const lease = await store.getLease(req.params.id);
  if (!lease) return res.status(404).json({ error: 'Unknown trial' });
  res.json({ trial: shape(lease) });
});

/**
 * Live provisioning timeline over Server-Sent Events.
 *
 * SSE rather than WebSockets: the stream is one-directional and short-lived,
 * it survives the Zerops L7 balancer without special configuration, and it
 * reconnects on its own. Clients resume with Last-Event-ID so a dropped
 * connection does not lose the timeline.
 */
app.get('/api/trials/:id/events', async (req, res) => {
  const lease = await store.getLease(req.params.id);
  if (!lease) return res.status(404).json({ error: 'Unknown trial' });

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no', // stop any proxy buffering the stream
  });

  let lastId = Number(req.headers['last-event-id'] ?? req.query.after ?? 0);
  let closed = false;
  req.on('close', () => {
    closed = true;
  });

  const send = (id, event, data) => {
    res.write(`id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  while (!closed) {
    const events = await store.listEvents(req.params.id, lastId);
    for (const e of events) {
      lastId = e.id;
      send(e.id, 'step', e);
    }

    const current = await store.getLease(req.params.id);
    if (current && ['READY_UNCLAIMED', 'CLAIMED'].includes(current.state)) {
      send(lastId + 1, 'ready', shape(current));
      break;
    }
    if (current && ['FAILED', 'DESTROYED'].includes(current.state)) {
      send(lastId + 1, 'failed', { error: current.error ?? 'Trial ended' });
      break;
    }

    res.write(': keep-alive\n\n'); // comment frame keeps intermediaries honest
    await new Promise((r) => setTimeout(r, 1500));
  }
  res.end();
});

/**
 * Destroy a trial early.
 *
 * This only flags the lease; the reaper performs the actual deletion, because
 * the reaper is the single place that holds the Zerops token and enforces the
 * tag guard. Keeping destruction in one process means there is exactly one
 * code path that can delete infrastructure.
 */
app.delete('/api/trials/:id', async (req, res) => {
  const lease = await store.getLease(req.params.id);
  if (!lease) return res.status(404).json({ error: 'Unknown trial' });

  if (lease.visitor_hash && lease.visitor_hash !== visitorFingerprint(req)) {
    return res.status(403).json({ error: 'Not your trial' });
  }
  if (lease.state === LeaseState.DESTROYED) {
    return res.json({ destroyed: true, alreadyDestroyed: true });
  }

  // Expire it immediately; the reaper collects it on its next sweep.
  await store.pool.query(`UPDATE leases SET expires_at = now() - interval '1 minute' WHERE id = $1`, [
    lease.id,
  ]);

  res.json({ destroyed: true, sweepWithinSeconds: LIMITS.reaperIntervalMs / 1000 });
});

// -- static frontend ---------------------------------------------------------
app.use(express.static(join(ROOT, 'packages', 'web', 'public'), { index: 'index.html' }));

/** Never leak internal shapes (visitor_hash, project_id) to a browser. */
function shape(lease) {
  return {
    id: lease.id,
    app: lease.app_slug,
    state: lease.state,
    url: lease.url,
    credentials: lease.credentials ?? [],
    createdAt: lease.created_at,
    expiresAt: lease.expires_at,
    ttlMinutes: lease.ttl_minutes,
    provisionMs: lease.provision_ms,
  };
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`OpenTry API listening on :${PORT}`);
  console.log(`catalog: ${[...catalog.keys()].join(', ')}`);
});
