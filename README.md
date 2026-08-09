# OpenTry

**Disposable, private evaluation environments for open-source software.**

OpenTry helps developers evaluate self-hosted applications without creating a cloud account, installing Docker, or sharing a polluted public demo. One click hands the visitor an isolated application, managed database, public URL, and temporary admin login; after 30 minutes, the entire Zerops project is destroyed.

### [Launch OpenTry →](https://api-2d72-3000.prg1.zerops.app)  ·  [Watch the 3-minute demo →](https://www.youtube.com/watch?v=IE8_swBjaV4)

![OpenTry: claim a real disposable trial in seconds, then destroy it](docs/preview.svg)

<sub>Illustration of the real API calls and responses, not a screen recording. The live state is below.</sub>

**Warm right now** — these badges are served by the running control plane and change with the pool:

[![Metabase](https://api-2d72-3000.prg1.zerops.app/badge/metabase.svg)](https://api-2d72-3000.prg1.zerops.app)
[![n8n](https://api-2d72-3000.prg1.zerops.app/badge/n8n.svg)](https://api-2d72-3000.prg1.zerops.app)
[![Umami](https://api-2d72-3000.prg1.zerops.app/badge/umami.svg)](https://api-2d72-3000.prg1.zerops.app)
[![Vikunja](https://api-2d72-3000.prg1.zerops.app/badge/vikunja.svg)](https://api-2d72-3000.prg1.zerops.app)

| | |
|---|---|
| **Live application** | <https://api-2d72-3000.prg1.zerops.app> |
| **Demo video** | <https://www.youtube.com/watch?v=IE8_swBjaV4> |
| **Source** | <https://github.com/RajdeepKushwaha5/OpenTry> |
| **Live pool state** | [`/api/pool`](https://api-2d72-3000.prg1.zerops.app/api/pool) — warm trials right now |
| **Live metrics** | [`/api/metrics`](https://api-2d72-3000.prg1.zerops.app/api/metrics) — real provisioning times and estimated spend |
| **Platform findings** | [FINDINGS.md](FINDINGS.md) — eighteen undocumented Zerops behaviours |

Built for [The Zerops Challenge](https://www.wemakedevs.org/hackathons/zerops).

> OpenTry is not a simulated sandbox. Every trial is a real, separately networked Zerops project. When a warm trial is available, handoff takes seconds; provisioning its replacement continues in the background.

## Why OpenTry exists

Finding a promising open-source project is easy. Evaluating it is not.

A prospective user usually has three options:

- use a shared demo that is read-only, preconfigured, or already modified by strangers;
- install Docker, study the deployment guide, and debug the stack locally;
- deploy the application and its dependencies to a cloud account before deciding whether it is useful.

That setup cost causes potential users to leave before experiencing the product. Maintainers can run a permanent public demo, but then they pay continuously and must defend a shared instance from abuse.

OpenTry moves that work to disposable infrastructure. The visitor gets a private evaluation environment; the maintainer gets a demo that exists only while someone is using it.

## Try the core workflow

1. Open the [live application](https://api-2d72-3000.prg1.zerops.app).
2. Choose Umami, Metabase, Vikunja, or n8n.
3. Open the assigned URL and use the generated login.
4. Watch the lease countdown and live pool replacement.
5. Destroy the environment early or let its 30-minute lease expire.

The page exposes the real warm-pool state, provisioning timeline, health metrics, and estimated spend. If no warm instance is available, it says so and shows the replacement being built rather than hiding the wait behind an indefinite spinner.

## This is not another deploy button

| | Traditional deploy button | OpenTry |
|---|---|---|
| Intended user | Someone ready to deploy | Someone still evaluating |
| Cloud account required | Yes | No |
| Environment owner | User | OpenTry operator |
| Lifetime | Permanent until removed | 30-minute lease |
| Cleanup | Manual | Automatic and tag-guarded |
| Demo state | Often shared | Isolated per visitor |
| Cost model | Runs continuously | Operator pays only for temporary usage |

## Why Zerops is essential

OpenTry does not merely happen to be hosted on Zerops. Zerops' programmable project lifecycle is the product primitive.

- **A whole project per visitor.** The controller renders Import YAML and calls the Zerops project API. Each trial receives its own application service, managed dependencies, private network, L7 routing, TLS endpoint, and generated credentials.
- **Infrastructure described in one document.** A catalog manifest becomes a complete project containing Docker or native runtimes, PostgreSQL, caches, search engines, messaging, or object storage.
- **Per-minute billing.** Temporary infrastructure is economically viable because services are billed for the time they exist. A representative two-service trial is estimated at roughly `$0.0086` for 30 minutes at published list prices; the same maximum allocation is about `$12.40` for 30 days.
- **Managed services without plumbing.** Applications connect to databases through Zerops-generated environment references such as `${db_connectionString}`.
- **Real deployment verification.** OpenTry waits for platform state, enables the public subdomain, checks actual HTTP behavior, seeds the application, and only then releases it.
- **One API for creation and cleanup.** The same control plane imports a project, observes it, and deletes it after the lease.

The platform-specific behavior learned while building this is documented in [FINDINGS.md](FINDINGS.md).

## Catalog

The current catalog demonstrates the same product with four different applications:

| Application | Trial infrastructure | Prepared experience | Risk tier |
|---|---|---|---|
| **Umami** | Docker + managed PostgreSQL | Signed in with a demo website registered | Standard |
| **Metabase** | Docker + managed PostgreSQL | Signed in with the Sample Database available | Elevated |
| **Vikunja** | Docker + managed PostgreSQL | Signed in with a project and task on the board | Standard |
| **n8n** | Docker + managed PostgreSQL | Signed in as the temporary owner | Elevated |

Provisioning time varies with Docker VM boot, image pulls, placement, and cache state. Observed runs have ranged from several minutes to roughly twelve minutes. The warm pool pays that latency before the visitor arrives, so a ready instance can be claimed in seconds.

Elevated applications can make arbitrary outbound requests or execute workflows. They are withheld by default in code and require an explicit operator opt-in.

## Evidence that it works

OpenTry has no probabilistic model to evaluate against a labeled dataset. Its equivalent evidence is deterministic safety testing, schema validation, real-infrastructure acceptance runs, and production lifecycle metrics.

### Automated tests

The portable suite uses Node's built-in test runner:

```bash
npm test
```

It covers:

- manifest parsing, service-family rules, TTL and resource ceilings;
- hostile manifest paths, forbidden environment keys, and Docker port collisions;
- proof-of-work signatures, expiry, replay, difficulty, and wrong-app reuse;
- fixed and autoscaled resource cost calculations;
- seed interpolation, capture behavior, optional and required failures;
- application policy and emergency kill-switch behavior;
- alert transitions and recovery behavior.

The atomic claim behavior needs a real PostgreSQL database because `FOR UPDATE SKIP LOCKED` and partial unique indexes cannot be faithfully tested with an in-memory substitute:

```bash
DATABASE_URL=postgresql://postgres:password@127.0.0.1:5432/opentry_test npm run test:db
```

Without `DATABASE_URL`, that suite prints an explicit skip warning. A verified PostgreSQL 16 run sent twenty simultaneous claims to five warm leases: exactly five distinct leases were returned, while one visitor racing eight requests received exactly one lease.

### Catalog validation

Every catalog entry is rendered and checked against Zerops' published Import YAML JSON Schema:

```bash
npm run catalog:check
npm run catalog:check -- --show n8n
```

The second command prints the exact post-clamping YAML that Zerops would receive. Service-type differences between the public schema and the live API are surfaced as warnings instead of silently ignored; the working forms are recorded in [FINDINGS.md](FINDINGS.md).

### End-to-end go/no-go

The go/no-go test spends real Zerops credit. It imports a trial project, waits for its services, enables its route, verifies application behavior, tests the deletion guard, and removes the project:

```bash
npm run gonogo -- --app hello
npm run gonogo -- --app umami
```

Use `npm run gonogo:keep -- --app <slug>` to inspect the resulting project manually, then `npm run gonogo:cleanup` to remove tagged strays.

### Monitoring

OpenTry derives operational metrics from its PostgreSQL lease history instead of adding a separate observability service:

- provisioning attempts, successes, failures, and claim count;
- p50, p95, and slowest provisioning time by application;
- current state and global capacity usage;
- estimated destroyed and still-open infrastructure cost;
- recent failure reasons.

Useful endpoints:

| Endpoint | Purpose |
|---|---|
| [`/health`](https://api-2d72-3000.prg1.zerops.app/health) | Process liveness |
| [`/api/health/deep`](https://api-2d72-3000.prg1.zerops.app/api/health/deep) | Provisioning-aware health; returns `503` when unhealthy |
| [`/api/metrics`](https://api-2d72-3000.prg1.zerops.app/api/metrics) | Operational snapshot and estimated spend |
| [`/api/pool`](https://api-2d72-3000.prg1.zerops.app/api/pool) | Warm and provisioning capacity by app |
| [`/api/pool/building`](https://api-2d72-3000.prg1.zerops.app/api/pool/building) | The trial currently being provisioned, so the UI can stream its timeline |
| [`/api/catalog`](https://api-2d72-3000.prg1.zerops.app/api/catalog) | Offered apps, plus withheld ones and the reason |

`/api/health/deep` reports the health of the **last ten finished provisions**, not the window average. A health probe is asked "is provisioning working now"; a burst of failures that has since been fixed should stop setting off alarms once the following attempts succeed, and a window average cannot express that.

The controller can also send edge-triggered webhook alerts when health degrades and when it recovers.

### For maintainers

Two endpoints exist for people who want to put OpenTry on their own project:

| Endpoint | Purpose |
|---|---|
| [`/badge/umami.svg`](https://api-2d72-3000.prg1.zerops.app/badge/umami.svg) | Live README badge reflecting real warm-pool state |
| [`/api/apps/umami/embed`](https://api-2d72-3000.prg1.zerops.app/api/apps/umami/embed) | Ready-made badge and link snippets for a README |

Badges are served outside `/api` so a popular README cannot trip the rate limiter and show every visitor a broken image.

## Architecture

OpenTry uses two isolation layers: one long-lived control-plane project and one disposable project per trial.

```mermaid
flowchart LR
    V[Anonymous visitor] -->|HTTPS| API[Public API + web]
    API -->|leases, claims, metrics| DB[(Control PostgreSQL)]
    C[Private controller] -->|pool + reaper state| DB
    C -->|Bearer token / Zerops REST API| Z[Zerops control plane]
    Z --> T1[Disposable trial project]
    T1 --> APP[Application service]
    T1 --> TDB[(Managed database)]
    V -->|temporary URL + login| APP
    C -. verify and seed over public URL .-> APP
    C -->|tag-guarded delete on expiry| Z
```

### Control plane

| Service | Public | Zerops token | Responsibility |
|---|---:|---:|---|
| `api` | Yes | No | UI, catalog, atomic claims, recovery, SSE, metrics |
| `controller` | No ports | Yes | Warm pool, provisioning, verification, reaping, alerts |
| `db` | No | No | Durable leases, timelines, rate-limit buckets, audit history |

The public request handler never receives the Zerops token. A visitor asking to destroy a trial only expires an owned lease in PostgreSQL; the private reaper performs the actual project deletion after checking its ownership tag.

### Lease lifecycle

```mermaid
stateDiagram-v2
    [*] --> PROVISIONING: pool needs capacity
    PROVISIONING --> READY_UNCLAIMED: services + URL + checks + seed pass
    PROVISIONING --> FAILED: import or verification fails
    READY_UNCLAIMED --> CLAIMED: atomic visitor claim
    READY_UNCLAIMED --> DESTROYING: warm project becomes stale
    CLAIMED --> DESTROYING: TTL or early destroy
    FAILED --> DESTROYING: cleanup
    DESTROYING --> DESTROYED: tagged Zerops project removed
```

Claims use one PostgreSQL statement with `FOR UPDATE SKIP LOCKED`. Concurrent visitors lock different warm rows, while a partial unique index prevents one visitor from owning multiple active leases.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the detailed reasoning and failure model.

## Safety model

Anonymous infrastructure cannot be made safe with one control, so OpenTry layers several:

- **Separate projects:** untrusted trial software never shares the control plane's private network.
- **Credential boundary:** only the private controller holds the Zerops token.
- **Tag-guarded deletion:** the client re-fetches a project and refuses deletion unless it carries `OPENTRY_EPHEMERAL`.
- **Hard lifetime:** claimed trials expire after 30 minutes; unused warm projects rotate.
- **Global ceiling:** the controller stops creating projects at the configured account-wide limit.
- **One active lease per fingerprint:** enforced by PostgreSQL, not only application code.
- **Proof of work:** signed, short-lived Hashcash-style challenges raise the cost of automated claims.
- **Manifest ceilings:** service count, CPU, RAM, disk, object storage, containers, HA mode, TTL, ports, and environment keys are constrained before import.
- **Policy tiers:** applications capable of outbound requests or code execution are disabled unless the operator opts in.
- **Kill switch:** `OPENTRY_DISABLED_APPS` withdraws catalog entries without a code deployment.
- **Orphan reaping:** tagged projects not represented by a live lease are removed after a grace period.

No raw IP address is stored. The API keeps only a deployment-salted hash of network and user-agent information. This is a soft anonymous-abuse control, not proof of identity; the global project ceiling remains the financial safety boundary.

## Quickstart

### Prerequisites

- Node.js 20 or newer
- npm
- PostgreSQL for the API/controller and database-backed concurrency tests
- a Zerops account and Personal Access Token for real provisioning
- a public Git repository when deploying through `buildFromGit`

### Install and validate

```bash
git clone https://github.com/RajdeepKushwaha5/OpenTry.git
cd OpenTry
npm install
cp .env.local.example .env.local
npm test
npm run catalog:check
```

On Windows PowerShell, use `Copy-Item .env.local.example .env.local` instead of `cp`.

Add your Personal Access Token to `.env.local` only if you intend to provision real projects:

```dotenv
ZEROPS_TOKEN=
DATABASE_URL=postgresql://user:password@127.0.0.1:5432/opentry
```

`.env.local` is ignored by Git. The token grants project-level creation and deletion authority; use a dedicated Zerops account for public deployments when possible.

## Local development

Start PostgreSQL first, then run the public API and private controller in separate terminals:

```bash
# Optional local PostgreSQL with Docker; any PostgreSQL 16 instance also works
docker run -d --name opentry-pg -p 55432:5432 -e POSTGRES_PASSWORD=password -e POSTGRES_DB=opentry postgres:16-alpine

# Put this value in .env.local
DATABASE_URL=postgresql://postgres:password@127.0.0.1:55432/opentry
```

The application creates its lease tables and indexes automatically on startup.

```bash
npm run dev:api
npm run dev:controller
```

The API is available at `http://localhost:3000`. The controller talks to the real Zerops API and can spend credit. For frontend or read-only API work, run only `npm run dev:api`; pool provisioning will remain inactive.

### Common problems

| Symptom | Likely cause |
|---|---|
| API exits during startup | PostgreSQL is unavailable or `DATABASE_URL` is wrong |
| Controller exits with “No Zerops token” | `ZEROPS_TOKEN`/`OPENTRY_ZEROPS_TOKEN` is missing |
| Runtime remains `READY_TO_DEPLOY` | `zeropsSetup` does not match, or no deployment was triggered |
| Docker service is active but URL does not answer | Image listen port differs, or it binds host port 80/443 |
| Public access initially returns an HTTP-port error | Zerops route registration is still converging; OpenTry retries it |
| Deployed code looks stale | Zerops built the Git remote, not uncommitted local changes |
| Concurrency suite is skipped | Provide a real PostgreSQL `DATABASE_URL` |

The platform-specific versions of these problems, their reproductions, and the working solutions are in [FINDINGS.md](FINDINGS.md).

## Configuration

### Required

| Variable | Scope | Description |
|---|---|---|
| `DATABASE_URL` | API + controller | PostgreSQL connection string; Zerops supplies `${db_connectionString}` |
| `OPENTRY_ZEROPS_TOKEN` | Controller | Personal token used to create and delete trial projects |
| `OPENTRY_VISITOR_SALT` | Project | Shared salt for anonymous fingerprints and proof-of-work signing fallback |

Locally, `ZEROPS_TOKEN` is accepted as an alternative to `OPENTRY_ZEROPS_TOKEN`.

### Operational controls

| Variable | Default | Description |
|---|---:|---|
| `OPENTRY_WARM_PER_APP` | `1` | Finished leases kept ready per offered application |
| `OPENTRY_MAX_CONCURRENT_TRIALS` | `6` | Account-wide live-project ceiling |
| `OPENTRY_RECONCILE_MS` | `20000` | Warm-pool reconciliation interval |
| `OPENTRY_ALLOW_ELEVATED` | off | Enables apps with outbound-request or code-execution capabilities |
| `OPENTRY_DISABLED_APPS` | empty | Comma-separated emergency catalog kill switch |
| `OPENTRY_POW_SECRET` | visitor salt | Dedicated proof-of-work signing secret |
| `OPENTRY_RATE_MAX` | `30/min` | Write/expensive-request limit per fingerprint |
| `OPENTRY_RATE_POLL_MAX` | `240/min` | Read-only polling allowance per fingerprint |
| `OPENTRY_MAX_STREAMS_PER_VISITOR` | `4` | Concurrent SSE streams per fingerprint |
| `OPENTRY_MAX_STREAMS_TOTAL` | `40` | API-process-wide SSE ceiling |
| `OPENTRY_TRUSTED_PROXY_HOPS` | `1` | Trusted reverse-proxy hops in `X-Forwarded-For` |
| `OPENTRY_ALERT_WEBHOOK` | unset | Optional degradation/recovery webhook |
| `OPENTRY_ALERT_INTERVAL_MS` | `120000` | Health-alert evaluation interval |

Published price overrides are available as `PRICE_SHARED_CPU_CORE_30D`, `PRICE_DEDICATED_CPU_CORE_30D`, `PRICE_RAM_PER_GB_30D`, and `PRICE_DISK_PER_GB_30D`. All displayed costs remain estimates, not invoice data.

## Deployment

The recommended deployment uses [zerops-import.yaml](zerops-import.yaml) to create the long-lived control plane and [zerops.yaml](zerops.yaml) to build and run its API and controller setups.

```bash
npm install
npm run deploy:dry
npm run deploy
```

The deployment helper:

1. checks that the working tree is committed and pushed;
2. injects the Personal Access Token into the manifest in memory;
3. imports the control-plane project;
4. waits for PostgreSQL, the controller, and the API;
5. enables the API subdomain and verifies `/health`;
6. prints the public URL while the controller begins warming trials.

To ship a change to a control plane that is already running, use `npm run redeploy`. `npm run deploy` deliberately refuses to touch an existing project, so without this the only route was deleting and recreating it — discarding the database, every live trial, and the public URL:

```bash
npm run redeploy                      # rebuild api + controller from the pushed commit
npm run redeploy -- --service api     # rebuild one service
```

Both deploy commands refuse to run against an uncommitted or unpushed working tree, because Zerops builds from GitHub: a pipeline triggered on local-only work rebuilds the previous commit and reports success.

Environment variables come from the import manifest and are applied when the project is **created**. Editing `zerops-import.yaml` and rebuilding does not change them on a running deployment — set those through the Zerops GUI or API and restart the service.

OpenTry currently has no GitHub Actions workflow. Deployment is manual through `npm run deploy` or Zerops' own pipeline controls; tests do not automatically gate pushes. This is deliberate documentation of the current state, not a claim of CI/CD that the repository does not contain.

See [DEPLOY.md](DEPLOY.md) for token scope, repository visibility, staging names, safe redeployment, and public-operation guidance.

## Adding an application

Create `catalog/<slug>/opentry.yaml`. A manifest describes the product, temporary credentials, safety capabilities, services, behavior checks, and optional seed requests:

```yaml
version: 1

app:
  slug: example
  name: Example
  tagline: A concrete description of what the visitor can evaluate
  capabilities:
    outboundHttp: false
    codeExecution: false

trial:
  ttlMinutes: 30
  entry: { service: app, port: 3000 }

infra:
  services:
    - hostname: db
      type: postgresql@16
      mode: NON_HA
    - hostname: app
      type: nodejs@22

verify:
  - name: Application responds
    kind: http
    path: /health
```

Then validate and perform a real disposable deployment:

```bash
npm run catalog:check -- --show example
npm run gonogo -- --app example
```

Adding a manifest to the repository is a reviewed operation. The public validation endpoint renders and checks submitted YAML but cannot install it or spend infrastructure credit.

## Project structure

```text
catalog/                      one reviewed opentry.yaml per application
fixtures/                     minimal real-infrastructure probes
packages/
  api/src/                    public HTTP API, SSE, badges, static UI
  controller/src/             lease store, warm pool, reaper, metrics, alerts
  provisioner/src/            Zerops client, lifecycle, seeding, cost model
  shared/src/                 catalog, policy, manifest and schema validation
  web/public/                 dependency-free HTML/CSS/JavaScript frontend
scripts/
  catalog-check.mjs           offline manifest and Import YAML validation
  gonogo.mjs                  real create → verify → delete acceptance test
  deploy.mjs                  initial control-plane deployment
  redeploy.mjs                controlled rebuild of an existing deployment
zerops-import.yaml            control-plane infrastructure definition
zerops.yaml                   API and controller build/run definitions
ARCHITECTURE.md               detailed boundaries, lifecycle and trade-offs
FINDINGS.md                   observed Zerops API and platform behavior
DEPLOY.md                     deployment and operations guide
```

## Decisions and trade-offs

### Warm capacity instead of making visitors wait

Docker VM provisioning and image pulls take minutes. OpenTry keeps one completed trial per offered app and immediately replaces a claimed lease. The trade-off is idle cost; the benefit is that the user experiences the application before losing interest.

### Separate projects instead of one multitenant project

A single project would be cheaper and faster, but anonymous trial software would share a network and failure domain with the control plane. Project-per-trial isolation costs more and makes provisioning slower, but it gives the product its strongest security property.

### PostgreSQL coordination instead of in-memory state

Lease ownership, rate limiting, timelines, recovery, and cleanup state survive process restarts. PostgreSQL also provides the locking semantics needed for safe concurrent claims. The downside is that even the frontend/API development path needs a database.

### SSE instead of WebSockets

Provisioning progress is one-way and finite. SSE reconnects automatically, works through the Zerops L7 route, and needs no additional broker. Per-visitor and global stream ceilings protect the database polling loop.

### Reviewed catalog instead of public installation

Anyone may validate a manifest, but only reviewed files in `catalog/` are provisioned. Automatic installation would let anonymous users choose what infrastructure the operator pays for and what code runs with outbound network access.

### Estimated cost instead of pretending it is billing data

Zerops does not expose per-project invoice totals through the API used here. OpenTry calculates an upper-bound estimate from the manifest's declared resources and published prices, labels it as estimated, and keeps the pricing variables configurable.

## Further documentation

- [Architecture and threat model](ARCHITECTURE.md)
- [Deployment and operations](DEPLOY.md)
- [Eighteen Zerops platform findings](FINDINGS.md)
- [Zerops Import YAML reference](https://docs.zerops.io/references/import)
- [Zerops REST API reference](https://docs.zerops.io/references/api)
- [Zerops pricing](https://docs.zerops.io/company/pricing)

---

OpenTry turns “I might try this someday” into a working, private application now—and removes the infrastructure when the evaluation is over.
