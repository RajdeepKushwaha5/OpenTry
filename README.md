# OpenTry

**Try any open-source app in seconds. Private, real, disposable — no signup, no Docker.**

**Live: https://api-2c2b-3000.prg1.zerops.app**

Built for [The Zerops Challenge](https://www.wemakedevs.org/hackathons/zerops).

---

## The problem

You find an open-source project you might want to use — n8n, Ghost, Metabase, Plausible. Your options today:

- a **shared public demo**, usually read-only or already trashed by other visitors
- **`docker compose up`** — install Docker, read the docs, wait, debug why it failed
- **deploy it to a server yourself** — an hour of your life

Most people close the tab. Maintainers lose evaluators at the top of the funnel and have no good fix, because a permanent demo costs money forever and gets abused.

## What OpenTry does

A visitor clicks **Try**. About a second later they have their **own private instance** of the app — real application, real managed database, real URL, real admin login — for 30 minutes. Then it destroys itself completely.

It isn't a sandbox or a recording. Each trial is a genuine, isolated Zerops project created from a manifest and torn down by a reaper.

## This is not a deploy button

| | Deploy buttons (Railway / Vercel / Zerops recipes) | OpenTry |
|---|---|---|
| Account needed | Yes | **No** |
| Who pays | You | Nobody — it's temporary |
| Where it goes | Permanently into your account | A throwaway project |
| Cleanup | You remember | Automatic |
| Serves | People who already decided | **People still deciding** |

---

## How Zerops is used

OpenTry is not an app that merely *runs on* Zerops. Zerops' project API **is** the product.

**Trials are real Zerops projects.** Every trial is created with `POST /client/{id}/project/import` from a rendered Import YAML, and destroyed with `DELETE /project/{id}`. Full private network, dedicated L3 firewall, L7 balancer, SSL, managed Postgres — per visitor.

**Per-minute billing makes it viable.** A 30-minute n8n trial costs roughly **$0.0043**. The same stack left running for 30 days would be **$6.15**. Disposable infrastructure is only sane on a platform that bills by the minute and gives you a free Lightweight core per project.

**Two-project isolation.** Trials are untrusted and reachable by anonymous visitors, so they never share a network with the control plane:

```
control plane (long-lived)          each trial (disposable, tagged)
┌────────────────────────┐          ┌──────────────────────────┐
│ api        (public)    │          │ app  (public subdomain)  │
│ controller (private)   │ ───────▶ │ db   (private)           │
│ db         (private)   │  creates └──────────────────────────┘
└────────────────────────┘           destroyed on TTL by the reaper
```

**Behaviour verification, not just deployment.** A trial is only handed over once real checks pass against the live URL — including one that fetches the page and asserts the content is actually there. A green deploy is not proof that anything works.

**Managed service breadth.** A catalog entry declares whatever it needs — Postgres, Valkey, ClickHouse, Meilisearch, object storage — as one line each.

---

## Architecture

### Control plane — 3 services

| Service | Public | Holds Zerops token | Can create/destroy infra |
|---|---|---|---|
| `api` (Node.js) | Yes | **No** | **No** |
| `controller` (Node.js) | No — declares no ports | Yes | Yes |
| `db` (PostgreSQL) | No | — | — |

**This split is the core security decision.** The process that serves HTTP has no credentials, so a bug in request handling cannot provision or delete anything. Destroying a trial only flags a lease row; the reaper performs the deletion. There is exactly one code path that can delete infrastructure, and it is tag-guarded.

### The warm pool

Provisioning measured **~343s** for n8n. Nobody waits six minutes to look at software — that delay is precisely why people don't evaluate self-hosted apps, which is the problem OpenTry exists to solve. So finished trials idle in a pool and are handed over instantly, with a replacement provisioned in the background.

The claim is one atomic statement using `FOR UPDATE SKIP LOCKED`. Two visitors clicking at the same moment get different trials; a SELECT-then-UPDATE would be a race that only appears under exactly the load a demo creates.

### Safety

Free, anonymous, disposable infrastructure needs limits that don't depend on goodwill:

- **Tag-guarded deletion.** `deleteProject` re-fetches the project and refuses unless it carries `OPENTRY_EPHEMERAL`. No delete-by-name, no delete-by-pattern, no bypass flag. The go/no-go asserts the guard rejects a wrong tag on every run.
- **Orphan reaping.** Projects tagged as ours with no lease row (a controller crash between import and DB write) are destroyed after a 15-minute grace period. Without this they'd bill forever, invisibly.
- **Manifests are untrusted.** Catalog entries come from third parties. Every resource request is clamped *downward* — never up. A manifest cannot widen its own ceiling.
- **No mail relay.** SMTP-shaped env keys are rejected at the manifest layer; outbound spam is the dominant abuse vector for free infrastructure.
- **Hard ceilings.** One trial per visitor, 30-minute TTL, global concurrency cap.
- **No raw IPs stored.** Visitors are identified by a salted SHA-256 of IP + user-agent — enough to answer "does this person already have a trial", and nothing else.

---

## The catalog

One file per app. Maintainers add **nothing** to their own repository — the manifest supplies the build config via Zerops' `zeropsYaml`.

```yaml
version: 1
app:
  slug: n8n
  name: n8n
trial:
  ttlMinutes: 30
  entry: { service: app, port: 5678 }
infra:
  services:
    - hostname: db
      type: postgresql@16
      mode: NON_HA
    - hostname: app
      type: docker@26.1
      # ...pull image, run with --network=host
verify:
  - { name: Application responding, kind: http, path: /healthz }
  - { name: Setup screen renders, kind: http, path: /, expectBodyContains: n8n }
```

Validate every manifest offline against Zerops' own published JSON Schema:

```bash
npm run catalog:check
```

---

## Running it

```bash
npm install
cp .env.local.example .env.local   # add a Zerops personal access token

npm run catalog:check              # validate manifests offline
npm run gonogo                     # provision a real trial, verify, destroy it
npm run gonogo -- --app hello      # minimal stack, fastest baseline
npm run gonogo:cleanup             # remove any strays
```

Deploy the control plane:

```bash
zcli project project-import zerops-import.yaml   # set ZEROPS_TOKEN first
```

---

## Platform notes discovered while building

Findings from working against the live API, each of which cost a debugging cycle. Kept here because they are not in the documentation.

| Finding | Detail |
|---|---|
| PAT auth endpoint | Personal access tokens authenticate at `/user/info`. `/auth/info` is session-only and returns 401 |
| Collection shape | Every list response is `{ list, totalCount }` — not `items`, not a bare array |
| Subdomain URL | Returned by **no** endpoint. Compose it: `{service}-{project.zeropsSubdomainHost}-{port}.{region}.zerops.app` |
| Subdomain enabling | `enableSubdomainAccess` in Import YAML did not take effect; call `PUT /service-stack/{id}/enable-subdomain-access` explicitly |
| HTTP port race | A service reports `ACTIVE` ~8s before its port registers; enabling the subdomain 400s with `serviceStackIsNotHttp` until then. Retry |
| `READY_TO_DEPLOY` | Normal while a build runs — but also where a service sits forever if no build was triggered |
| Per-family fields | Databases reject `minContainers` (use `mode`). Object storage rejects `verticalAutoscaling`. Docker VMs reject min/max ranges (use fixed `cpu`/`ram`/`disk`). All three are accepted at import and then fail silently |
| Docker has no build phase | The base list shows `Build: -`. A `build:` section on a Docker service prevents it from ever starting |
| Embedded `zeropsYaml` | `build.base` and `build.deployFiles` must be **arrays**, unlike a repo-level `zerops.yml` |
| Env isolation | Services cannot see each other's variables by default; reference them explicitly (`${db_connectionString}`) |
| Preprocessor scope | `<@generateRandomString>` is evaluated per occurrence — a value two services must share belongs at project scope |

---

## AI use

Claude was used for code generation, debugging and documentation. All architecture decisions, the security model, the two-project isolation design, and every platform finding above came from working against the live API and reading the results.
