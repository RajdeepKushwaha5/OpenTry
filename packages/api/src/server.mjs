/**
 * OpenTry API — the only publicly reachable service.
 *
 * SECURITY BOUNDARY: this process does NOT hold the Zerops token and cannot
 * create or destroy infrastructure directly. It reads and writes Postgres;
 * the controller does everything else. Claiming a trial is a single atomic
 * UPDATE, and destroying one sets a flag the reaper acts on. The worst a
 * compromised request handler can do is mark rows.
 *
 * Even DELETE only expires a lease row; the private reaper performs teardown.
 */

import express from 'express';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadCatalog, publicCatalog } from '../../shared/src/catalog.mjs';
import { LIMITS } from '../../shared/src/limits.mjs';
import { LeaseStore, visitorFingerprint, LeaseState } from '../../controller/src/store.mjs';
import { issueChallenge, verifySolution, DIFFICULTY } from '../../shared/src/proof-of-work.mjs';
import { renderBadge, badgeSnippets } from './badge.mjs';
import {
  bucketFor,
  canViewTrial,
  canDestroyTrial,
  publicEvent,
  readyPayload,
} from './authz.mjs';
import { parseManifest, renderImportYaml, generateTrialId } from '../../shared/src/manifest.mjs';
import { validateImportYaml } from '../../shared/src/validate-import.mjs';
import { Metrics, Health } from '../../controller/src/metrics.mjs';
import { appPolicy, partitionCatalog, POLICY_REASONS } from '../../shared/src/policy.mjs';
import { estimateCostUsd, formatCost, monthlyEquivalentUsd } from '../../provisioner/src/cost.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PORT = Number(process.env.PORT ?? 3000);

const catalog = await loadCatalog(join(ROOT, 'catalog'));
const store = new LeaseStore();
await store.migrate();

const metrics = new Metrics({ store, catalog });

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));

// -- rate limiting -----------------------------------------------------------
// Backed by Postgres, not process memory. An in-process counter pins the API
// to one container: run two and each enforces its own limit, silently doubling
// the real ceiling. This costs one upsert per request and makes the service
// genuinely horizontally scalable.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = Number(process.env.OPENTRY_RATE_MAX ?? 30);

/**
 * Polling and claiming cannot share a budget.
 *
 * The UI refreshes the pool and the live build every 5s and the ops panel every
 * 20s — 27 requests a minute before the visitor touches anything. Against a
 * single 30/min bucket an idle tab exhausts its own allowance, and the 429 then
 * lands on whatever the visitor does next. That is the Try button, on camera.
 *
 * So the budget is split by what a request costs us. Reads are cheap and mostly
 * self-inflicted by our own polling, and get room for several tabs. Anything
 * that can create infrastructure keeps the strict limit — that is the bucket
 * the ceiling was written for, and proof-of-work sits in front of it too.
 */
const RATE_POLL_MAX = Number(process.env.OPENTRY_RATE_POLL_MAX ?? 240);
const RATE_LIMITS = { strict: RATE_MAX, poll: RATE_POLL_MAX };

async function rateLimit(req, res, next) {
  try {
    const bucket = bucketFor(req, RATE_LIMITS);
    const key = `${bucket.name}:${visitorFingerprint(req)}`;
    const { allowed, retryAfterSeconds } = await store.hitRateLimit(key, {
      windowMs: RATE_WINDOW_MS,
      max: bucket.max,
    });
    if (!allowed) {
      res.set('retry-after', String(retryAfterSeconds));
      return res.status(429).json({ error: 'Too many requests.', retryAfterSeconds });
    }
    next();
  } catch {
    // Fail OPEN. A rate limiter that takes the whole API down when the
    // database hiccups causes more harm than the abuse it prevents — and the
    // real ceilings (one trial per visitor, global concurrency cap) still hold.
    next();
  }
}

setInterval(() => void store.pruneRateLimits(RATE_WINDOW_MS).catch(() => {}), 5 * 60_000).unref?.();

app.use('/api', rateLimit);

// -- routes ------------------------------------------------------------------

app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/api/catalog', (_req, res) => {
  const { offered, withheld } = partitionCatalog(catalog);
  const offeredSlugs = new Set(offered.map((o) => o.manifest.app.slug));
  res.json({
    apps: publicCatalog(catalog).filter((a) => offeredSlugs.has(a.slug)),
    // Shown rather than hidden. An app missing with no explanation looks
    // broken; an app missing WITH a reason explains the security model.
    withheld: withheld.map(({ manifest, policy }) => ({
      slug: manifest.app.slug,
      name: manifest.app.name,
      reason: policy.reason,
      explanation: POLICY_REASONS[policy.reason] ?? policy.reason,
    })),
  });
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
 * README badge, reflecting real pool state.
 *
 * Served outside /api so it is not rate-limited: a popular README would
 * otherwise trip the limiter and show every visitor a broken image. It is a
 * cheap read and reveals nothing sensitive.
 *
 * Cache headers are short and allow stale-while-revalidate — GitHub proxies
 * README images through camo, and without this the badge would freeze at
 * whatever state it had when first fetched.
 */
app.get('/badge/:slug.svg', async (req, res) => {
  const slug = String(req.params.slug ?? '');
  const manifest = catalog.get(slug);

  let state = 'unknown';
  if (manifest && !manifest.app.hidden) {
    try {
      const depth = await store.poolDepth(slug);
      if (depth.ready > 0) state = 'ready';
      else if (depth.provisioning > 0) state = 'building';
      else state = 'empty';
    } catch {
      state = 'unknown';
    }
  }

  res.type('image/svg+xml');
  res.set('cache-control', 'public, max-age=60, stale-while-revalidate=300');
  res.send(renderBadge({ left: 'OpenTry', state }));
});

/**
 * Validate a manifest a maintainer wrote, without provisioning anything.
 *
 * This is the self-service half. Previously adding an app meant opening a pull
 * request and waiting to discover, minutes into a real provision, that a field
 * was in the wrong place. Now a maintainer gets the same checks the catalog
 * loader runs — clamping, per-family field rules, forbidden env keys — plus
 * the rendered Zerops Import YAML validated against Zerops' own published
 * JSON Schema, in milliseconds.
 *
 * Deliberately does NOT install anything. Accepting arbitrary manifests into a
 * live catalog would let a stranger define infrastructure that we then pay
 * for. Validation is safe to expose; installation is a reviewed pull request,
 * and this endpoint produces everything that review needs.
 */
app.post('/api/manifests/validate', async (req, res) => {
  const source = typeof req.body?.manifest === 'string' ? req.body.manifest : '';
  if (!source.trim()) return res.status(400).json({ error: 'Send { manifest: "<yaml>" }' });
  if (source.length > 64_000) return res.status(413).json({ error: 'Manifest too large.' });

  let manifest;
  try {
    manifest = parseManifest(source, { source: 'submitted' });
  } catch (err) {
    return res.json({
      valid: false,
      stage: 'manifest',
      errors: [{ path: err.path ?? null, message: err.message }],
    });
  }

  const { yaml } = renderImportYaml(manifest, { trialId: generateTrialId() });
  const schema = await validateImportYaml(yaml).catch((err) => ({
    valid: true,
    errors: [],
    warnings: [`schema check unavailable: ${err.message}`],
  }));

  res.json({
    valid: schema.valid,
    stage: schema.valid ? 'ok' : 'schema',
    app: {
      slug: manifest.app.slug,
      name: manifest.app.name,
      capabilities: manifest.app.capabilities,
      ttlMinutes: manifest.trial.ttlMinutes,
      services: manifest.services.map((sv) => ({ hostname: sv.hostname, type: sv.type })),
      checks: manifest.verify.map((v) => v.name),
      seedSteps: manifest.seed.length,
    },
    // What the platform will actually receive, after clamping — so a
    // maintainer can see exactly what their request was reduced to.
    renderedYaml: yaml,
    errors: schema.errors.map((message) => ({ message })),
    warnings: schema.warnings,
    // Elevated-risk entries will be withheld unless the operator opts in.
    // Better to learn that here than after a pull request.
    policyNote:
      manifest.app.capabilities.level === 'elevated'
        ? 'This app declares outbound network access, so most deployments will ' +
          'withhold it unless OPENTRY_ALLOW_ELEVATED is set. Declare ' +
          'capabilities.outboundHttp: false if that is not accurate.'
        : null,
    nextStep: `Open a pull request adding catalog/${manifest.app.slug}/opentry.yaml`,
  });
});

/** Copy-paste snippets for a maintainer's README. */
app.get('/api/apps/:slug/embed', (req, res) => {
  const slug = String(req.params.slug ?? '');
  const manifest = catalog.get(slug);
  if (!manifest || manifest.app.hidden) {
    return res.status(404).json({ error: `Unknown app "${slug}"` });
  }
  // Take the host from the proxy headers so snippets carry the public URL,
  // but force https for anything that is not local.
  //
  // Zerops' L7 balancer terminates TLS and forwards the internal hop as
  // x-forwarded-proto: http, so trusting that header produced http:// badge
  // URLs — which GitHub blocks as mixed content, leaving maintainers with a
  // broken image in their README.
  const host = req.headers['x-forwarded-host'] ?? req.headers.host ?? '';
  const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(host);
  const proto = isLocal ? 'http' : 'https';
  res.json(badgeSnippets({ origin: `${proto}://${host}`, slug, appName: manifest.app.name }));
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
  const policy = appPolicy(manifest);
  if (!policy.offered) {
    return res.status(403).json({
      error: POLICY_REASONS[policy.reason] ?? 'Not available.',
      reason: policy.reason,
    });
  }
  const bits =
    manifest.app.capabilities.level === 'elevated' ? DIFFICULTY.elevated : DIFFICULTY.standard;
  res.json(issueChallenge(slug, bits));
});

/**
 * Operational snapshot: failure rate, provisioning percentiles, spend, and
 * whatever is stuck right now.
 *
 * Public, deliberately. It exposes no credentials, no project ids and no
 * visitor data — and a system that spends money on its own behalf should be
 * auditable by the people using it. It also means the demo can show that the
 * numbers are real rather than asserted.
 */
app.get('/api/metrics', async (req, res) => {
  const windowHours = Math.min(Math.max(Number(req.query.hours) || 24, 1), 168);
  try {
    res.json(await metrics.snapshot({ windowHours }));
  } catch (err) {
    res.status(500).json({ error: `Could not build metrics: ${err.message}` });
  }
});

/**
 * Liveness for an uptime monitor: 200 when healthy, 503 when provisioning is
 * failing. /health only proves the process is up, which is exactly the kind of
 * green tick that hides a broken system.
 */
app.get('/api/health/deep', async (_req, res) => {
  try {
    const snap = await metrics.snapshot({ windowHours: 6 });
    const ok = snap.health === Health.OK || snap.health === Health.IDLE;
    res.status(ok ? 200 : 503).json({
      status: snap.health,
      failureRate: snap.failureRate,
      inUse: snap.capacity.inUse,
      ceiling: snap.capacity.ceiling,
    });
  } catch (err) {
    res.status(503).json({ status: 'unknown', error: err.message });
  }
});

/** Claim a warm trial. */
app.post('/api/trials', async (req, res) => {
  const slug = String(req.body?.app ?? '');
  const manifest = catalog.get(slug);
  const policy = appPolicy(manifest);
  if (!policy.offered) {
    return res.status(403).json({
      error: POLICY_REASONS[policy.reason] ?? 'Not available.',
      reason: policy.reason,
    });
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

/**
 * Recover the visitor's live trial.
 *
 * Closing the tab used to strand a trial: it kept running, and billing, with
 * no way back to its URL or credentials until the TTL expired. Since a visitor
 * may only hold one at a time, that also locked them out of claiming another.
 *
 * No cookie needed — the same salted fingerprint that enforces the one-trial
 * limit identifies them here.
 */
app.get('/api/trials/mine', async (req, res) => {
  const lease = await store.hasActiveTrial(visitorFingerprint(req));
  if (!lease) return res.json({ trial: null });
  // hasActiveTrial returns a narrow projection; fetch the full row so the
  // browser gets credentials and provisioning time back too.
  const full = await store.getLease(lease.id);
  res.json({ trial: full ? shape(full) : null });
});

app.get('/api/trials/:id', async (req, res) => {
  const lease = await store.getLease(req.params.id);
  if (!lease) return res.status(404).json({ error: 'Unknown trial' });

  // Ownership check. `shape()` includes the URL and the generated admin
  // password, and trial ids are not secret — /api/pool/building publishes the
  // id of whatever is being provisioned. Without this, anyone could read that
  // id and collect the credentials of a warm trial before a visitor claimed it.
  if (!canViewTrial(lease, visitorFingerprint(req))) {
    return res.status(403).json({ error: 'Not your trial' });
  }
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
/**
 * Concurrent stream budget.
 *
 * Each stream polls the database every 1.5s for as long as it stays open, and
 * the pg pool holds eight connections. The rate limiter counts the one request
 * that opens a stream, not the minutes of querying that follow, so a handful of
 * held-open connections can starve claims and ordinary API calls. The building
 * lease id is public, so this costs an attacker no account and no proof of work.
 *
 * Two ceilings: a few per visitor (a real person has one tab, maybe three), and
 * a global one comfortably under the pool so provisioning always has room.
 */
const MAX_STREAMS_PER_VISITOR = Number(process.env.OPENTRY_MAX_STREAMS_PER_VISITOR ?? 4);
const MAX_STREAMS_TOTAL = Number(process.env.OPENTRY_MAX_STREAMS_TOTAL ?? 40);
const openStreams = new Map(); // visitor fingerprint -> count
let openStreamsTotal = 0;

app.get('/api/trials/:id/events', async (req, res) => {
  const lease = await store.getLease(req.params.id);
  if (!lease) return res.status(404).json({ error: 'Unknown trial' });

  const who = visitorFingerprint(req);
  const mine = openStreams.get(who) ?? 0;
  if (mine >= MAX_STREAMS_PER_VISITOR || openStreamsTotal >= MAX_STREAMS_TOTAL) {
    res.set('retry-after', '10');
    return res.status(429).json({ error: 'Too many open streams.', retryAfterSeconds: 10 });
  }
  openStreams.set(who, mine + 1);
  openStreamsTotal++;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    openStreamsTotal--;
    const n = (openStreams.get(who) ?? 1) - 1;
    if (n > 0) openStreams.set(who, n);
    else openStreams.delete(who);
  };
  res.on('close', release);

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

  try {
    while (!closed) {
      const events = await store.listEvents(req.params.id, lastId);
      for (const e of events) {
        lastId = e.id;
        // Only the human-readable timeline. Event metadata carries internal
        // project ids and URLs the controller recorded; none of it is public.
        send(e.id, 'step', publicEvent(e));
      }

      const current = await store.getLease(req.params.id);
      if (current && ['READY_UNCLAIMED', 'CLAIMED'].includes(current.state)) {
        // This stream is public — the UI watches the pool backfill so visitors
        // can see real provisioning happen. A warm trial has NOT been claimed,
        // so its URL and generated password must not travel down it. Claiming
        // through POST /api/trials is the only way to receive them.
        send(lastId + 1, 'ready', readyPayload(current, visitorFingerprint(req), shape));
        break;
      }
      if (current && ['FAILED', 'DESTROYED'].includes(current.state)) {
        send(lastId + 1, 'failed', { error: current.error ?? 'Trial ended' });
        break;
      }

      res.write(': keep-alive\n\n'); // comment frame keeps intermediaries honest
      await new Promise((r) => setTimeout(r, 1500));
    }
  } finally {
    // A throw in the loop (a database blip) must not leak a slot: the counter
    // would only ever climb, and the cap would eventually refuse everyone.
    release();
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

  if (lease.state === LeaseState.DESTROYED) {
    return res.json({ destroyed: true, alreadyDestroyed: true });
  }

  // Only a trial you hold. The old guard was `lease.visitor_hash && ...`, which
  // skipped entirely for PROVISIONING and READY_UNCLAIMED leases, because those
  // have no visitor yet — and their ids are public via /api/pool/building. A
  // stranger could expire the warm pool.
  //
  // It did not even do what it claimed: findReapable honours expires_at only
  // for CLAIMED leases, so setting it on a warm one destroyed nothing while
  // still returning `destroyed: true` and a cost receipt for someone else's
  // trial. Reporting a teardown that did not happen is its own bug.
  if (!canDestroyTrial(lease, visitorFingerprint(req))) {
    return res.status(403).json({ error: 'Not your trial' });
  }

  // Expire it immediately; the reaper collects it on its next sweep.
  await store.pool.query(`UPDATE leases SET expires_at = now() - interval '1 minute' WHERE id = $1`, [
    lease.id,
  ]);

  // Compute the receipt here rather than waiting for the reaper: the visitor
  // is looking at the screen now, and the reaper runs up to 30s later.
  const manifest = catalog.get(lease.app_slug);
  const lifetimeMs = Date.now() - new Date(lease.created_at).getTime();
  const cost = manifest ? estimateCostUsd(manifest.services, lifetimeMs) : null;

  res.json({
    destroyed: true,
    sweepWithinSeconds: LIMITS.reaperIntervalMs / 1000,
    lifetimeMs,
    estimatedCostUsd: cost,
    estimatedCostLabel: cost == null ? null : formatCost(cost),
    // The comparison that makes the number mean something.
    monthlyEquivalentUsd: manifest ? monthlyEquivalentUsd(manifest.services) : null,
    removed: ['containers', 'database', 'storage', 'credentials', 'routes'],
  });
});

// -- static frontend ---------------------------------------------------------
app.use(express.static(join(ROOT, 'packages', 'web', 'public'), { index: 'index.html' }));

/** Never leak internal shapes (visitor_hash, project_id) to a browser. */
function shape(lease) {
  return {
    id: lease.id,
    app: lease.app_slug,
    appName: catalog.get(lease.app_slug)?.app.name ?? lease.app_slug,
    firstSteps: catalog.get(lease.app_slug)?.app.firstSteps ?? [],
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
