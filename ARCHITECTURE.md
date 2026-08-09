# Architecture

How OpenTry works, and why it is built this way. Written to be read in ten
minutes by someone who has never seen the code.

---

## The shape of the thing

Two kinds of Zerops project, and keeping them apart is the central decision.

```
CONTROL PLANE (one, long-lived)          TRIAL (one per visitor, disposable)
┌────────────────────────────┐           ┌──────────────────────────────┐
│  api          public       │           │  app    public subdomain     │
│  controller   no ports     │  creates  │  db     private              │
│  db           private      │  ───────▶ │  ...whatever the manifest    │
└────────────────────────────┘           │        declares              │
                                         └──────────────────────────────┘
                                          tagged OPENTRY_EPHEMERAL
                                          destroyed on TTL by the reaper
```

A trial is untrusted: it runs third-party software and an anonymous stranger
has admin on it for thirty minutes. It must never share a private network with
the database that holds our leases or the process that holds our Zerops token.
Separate projects give that for free — Zerops private networks do not cross
project boundaries.

That boundary also creates a constraint worth knowing about: **the controller
cannot reach a trial internally.** Behaviour checks and seeding both run
against the trial's *public* URL, because there is no other route.

---

## Who can do what

| Service | Public | Holds the Zerops token | Can create/destroy infrastructure |
|---|---|---|---|
| `api` (Node.js) | yes | **no** | **no** |
| `controller` (Node.js) | no — declares no ports | yes | yes |
| `db` (PostgreSQL 16) | no | — | — |

This is the security model in one table. The process that parses HTTP requests
from the internet has no credentials. A bug in request handling cannot
provision or delete anything, because the code that can do those things is in a
different process that the internet cannot reach.

A service with **no `ports:` block cannot be exposed publicly even by
accident** — that is why the controller declares none.

---

## The lease lifecycle

```
                      ┌──────────────┐
   pool reconcile ───▶│ PROVISIONING │
                      └──────┬───────┘
                             │ services up, URL live, checks pass, seeded
                      ┌──────▼─────────┐
                      │ READY_UNCLAIMED│  ← idling, costing ~$0.0001/min
                      └──────┬─────────┘
                             │ visitor claims (2s)
                      ┌──────▼───────┐
                      │   CLAIMED    │  ← 30-minute TTL
                      └──────┬───────┘
                             │ TTL expires, or visitor destroys
                      ┌──────▼───────┐      ┌───────────┐
                      │  DESTROYING  │─────▶│ DESTROYED │
                      └──────────────┘      └───────────┘

   any failure ─────▶ FAILED (partial project destroyed on the way out)
```

Every row is written to Postgres **before** the work it describes. The project
id in particular is recorded the instant `importProject` returns, before we
wait for services — so a controller crash mid-provision still leaves something
the reaper can find and destroy.

---

## Why a warm pool

Provisioning takes **700–750 seconds** against the live platform, measured
2026-08-09 — up from 264–310s when the catalog was first built, on identical
manifests. Nobody waits twelve minutes to look at a piece of software; nobody
waited five either.

That delay is not incidental — it *is* the problem OpenTry exists to solve. It
is exactly why people do not evaluate self-hosted software. So we pay it in
advance and keep finished trials idling.

Handover is **2.0 seconds**. Claiming one immediately triggers a background
backfill.

### What the drift cost us, and why it is recorded here

The numbers moved, and the timeout did not move with them. `provisionTimeoutMs`
was 12 minutes, chosen against the original 264–310s with what looked like
generous headroom. Once real completion times reached 749s, that 720s ceiling
sat *inside* the normal spread — and behaved exactly as you would expect,
failing 60% of provisions with `pollUntil: timed out after 721s` while the
successes finished at 749s.

A limit that close to the median is not a timeout, it is a coin toss. It is now
20 minutes. The lesson is not "pick a bigger number" but that a timeout derived
from one measurement quietly becomes wrong when the thing it measures changes,
and nothing tells you — the failures look like infrastructure problems, not
like a stale constant.

### The claim has to be atomic

Two visitors clicking at the same instant must never get the same trial. The
claim is a single statement:

```sql
UPDATE leases SET state = 'CLAIMED', ...
 WHERE id = (
   SELECT id FROM leases
    WHERE state = 'READY_UNCLAIMED' AND app_slug = $1
    ORDER BY ready_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT 1)
RETURNING *
```

`SKIP LOCKED` means a concurrent transaction takes the *next* row instead of
blocking on the same one. A SELECT-then-UPDATE here would be a race that only
appears under exactly the load a demo produces.

A partial unique index closes the other half — one visitor racing themselves
gets exactly one trial, and the unique violation is caught and turned into
"here is the trial you already have".

**Verified against PostgreSQL 16:** twenty simultaneous claims against five warm
trials hand out exactly five, all distinct.

---

## Safety

Free, anonymous, disposable infrastructure needs limits that do not depend on
anyone's goodwill.

**Tag-guarded deletion.** `deleteProject` re-fetches the project and refuses
unless it carries `OPENTRY_EPHEMERAL`. No delete-by-name, no delete-by-pattern,
no bypass flag. There is exactly **one** code path that can delete
infrastructure, and the go/no-go asserts it rejects a wrong tag on every run.

**Orphan reaping.** A project tagged as ours with no lease row — the signature
of a crash between import and database write — is destroyed after a 15-minute
grace period. Without this it would bill forever with nothing pointing at it.

**Manifests are untrusted.** Catalog entries come from third parties. Every
resource request is clamped *downward*, never up. A manifest cannot widen its
own ceiling.

**No mail relay.** SMTP-shaped env keys are rejected at parse time. Outbound
spam is the dominant abuse vector for free infrastructure.

**Hard ceilings.** One trial per visitor, 30-minute TTL, global concurrency cap.

**No raw IPs stored.** Visitors are a salted SHA-256 of IP + user-agent — enough
to answer "does this person already have a trial", and nothing else.

**That identity is a speed bump, not a boundary — deliberately.** The IP half
cannot be forged: `X-Forwarded-For` is read from the trusted proxy hop inward,
so a caller who sends their own header does not get a new identity out of it.
The user-agent half is entirely theirs, so changing it *does* mint a fresh
one-trial allowance and a fresh rate-limit budget. Closing that properly means
accounts, and accounts are the thing OpenTry exists to avoid — the whole point
is that you can evaluate software without signing up for anything. So the
per-visitor limits are sized as friction for ordinary use, and the ceilings
that actually bound cost are global: total concurrent trials, proof of work on
every claim, and a 30-minute TTL. Anyone describing per-visitor limits as
enforcement is overstating them.

### The gap we could not close

**Zerops has no egress filtering.** Its firewall is inbound only, so a trial
cannot be network-isolated. An app that can make arbitrary outbound requests —
n8n, by design — is an open proxy in anonymous hands for the length of its
lease.

This is unfixable at the network layer, so it is a policy decision instead:

- Manifests **declare their capabilities**, and the default assumes the worst.
- **Elevated-risk apps are off** unless an operator sets `OPENTRY_ALLOW_ELEVATED`.
- Proof-of-work is priced by risk tier (18 bits standard, 21 elevated).
- A **kill switch** (`OPENTRY_DISABLED_APPS`) is read on every request, so an app
  can be withdrawn with an env change and a reload rather than a redeploy.

Proof-of-work makes *volume* expensive. It does not make a single abusive
request impossible, and nothing at the product layer can.

---

## Verification, not just deployment

A trial is released only after real checks pass against its live URL:

```yaml
verify:
  - { name: Database reachable,     kind: tcp,  service: db, port: 5432 }
  - { name: Application responding, kind: http, path: /api/health }
  - { name: Setup screen renders,   kind: http, path: /, expectBodyContains: Metabase }
```

The third one matters most. A health endpoint proves a process is listening;
asserting real page content proves the application *works*. A deploy tool would
have called Excalidraw green — service `ACTIVE`, URL resolving — when nothing
was answering at all.

`tcp` checks assert on Zerops service state rather than dialling a socket,
because of the network boundary described above. That is a real limitation,
documented rather than hidden.

---

## Seeding

Apps open on setup wizards and empty dashboards. A visitor with thirty minutes
should not spend five creating an account, and an unconfigured wizard makes
real infrastructure look like a broken demo.

Seed steps are HTTP requests run after verification, before release. They can
capture a value from one response and use it in the next — real setup APIs
require it, and Metabase will not create its first user without echoing back a
single-use token it generates at boot.

Failure is **best-effort by default**: a trial that works but looks plain still
beats no trial. A step can opt into `required: true`.

---

## Cost

Computed from Zerops' published list prices — there is no public per-project
billing API, so every surface that shows this labels it *estimated*.

| | |
|---|---|
| 30-minute trial | **~$0.0086** |
| Same stack left running 30 days | **~$12.40** |

Estimates take the largest value each service declares — Docker services use
fixed `cpu`/`ram`/`disk` where everything else uses `min`/`max` ranges — so the
figure on screen never under-reports. Reading only the ranges, as this did
originally, priced every Docker service at a fallback and halved the total.

That ratio is the product's whole economic argument: a maintainer's permanent
public demo costs about twelve dollars a month forever, and this costs
under a penny and deletes itself.

---

## Operations

`/api/metrics` answers four questions, each one SQL aggregate over rows that
already exist — no time-series store, no new dependency:

- Is provisioning working? — failure rate, recent errors with reasons
- Is it getting slower? — p50 / p95 / slowest, per app
- What is this costing? — recorded spend plus a live estimate for what is running
- Is anything stuck? — live state against the ceiling

`/api/health/deep` returns **503 when provisioning is failing**. Plain `/health`
only proves the process is up, which is exactly the green tick that hides a
broken system.

Alerts fire **on change, not on every sweep** — a 30-second loop would otherwise
emit 120 identical alerts an hour, and an alert you learn to ignore is worse
than no alert. Recovery is an event too.

---

## What runs where

```
packages/
  shared/       manifest parse → validate → clamp → render Import YAML
                policy, proof-of-work, logos, catalog loader
                offline validation against Zerops' published JSON Schema
  provisioner/  Zerops REST client (retrying, tag-guarded delete)
                lifecycle, behaviour verification, seeding, cost model
  controller/   warm pool, reaper, metrics, alerts, Postgres lease store
  api/          HTTP: catalog, claim, SSE timeline, badges, validation
  web/          one HTML file, no bundler
catalog/        one opentry.yaml per app
fixtures/       timing probe, deliberately not in the catalog
```

The frontend has **no build step** — plain HTML, CSS and JS served by the API
from its own origin. That removes a bundler from the deploy path, removes CORS
entirely, and keeps builds under thirty seconds. For one page with five fetch
calls, a framework would have bought nothing.

---

## Testing

**97 tests**, on Node's built-in runner, no new dependencies.

The suite deliberately covers only things whose correctness cannot be
established by reading them: resource clamping (a security property), every
proof-of-work attack path, the cost arithmetic, seeding's failure behaviour,
alert edge-triggering, and the claim race.

The concurrency tests need a real PostgreSQL — `SKIP LOCKED` and partial unique
indexes are not faithfully emulated in memory, and a test passing against a
fake would be worse than none. They **skip loudly** without `DATABASE_URL`,
because a silently skipped safety test reads as a passing one.

---

See [FINDINGS.md](FINDINGS.md) for sixteen undocumented platform behaviours
discovered building this, and [DEPLOY.md](DEPLOY.md) to run your own.
