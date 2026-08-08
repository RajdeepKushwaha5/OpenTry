# Deploying your own OpenTry

Everything runs on Zerops. You need a Zerops account and this repository — no
Docker, no `zcli`, no CI, no bundler.

---

## 1. Fork or clone this repository

Zerops builds the control plane straight from git, so **the repository must be
reachable by Zerops**. Two options:

- **Public repository** — works immediately, nothing to configure.
- **Private repository** — connect it first in the Zerops GUI under
  *Service detail → Pipelines & CI/CD settings → Connect with a GitHub
  repository*. Without this, the build cannot clone your code.

Then point the manifest at your copy:

```bash
# zerops-import.yaml — two occurrences
buildFromGit: https://github.com/YOUR_ORG/YOUR_REPO
```

## 2. Get a Zerops access token

app.zerops.io → avatar menu → **Access Token Management** → generate.

Use a **Personal** token, not an Integration token. OpenTry creates and
destroys whole projects, which is an organisation-level action; integration
tokens are scoped to existing projects and cannot do it.

```bash
cp .env.local.example .env.local
# paste the token into ZEROPS_TOKEN=
```

`.env.local` is gitignored. The token is never written into any tracked file —
`zerops-import.yaml` keeps a placeholder and substitution happens in memory
only.

## 3. Deploy

```bash
npm install
npm run deploy
```

That creates the project, waits for `db`, `controller` and `api` to come up,
enables public access, waits until the API answers, and prints your URL.

Takes roughly 5–10 minutes, most of it the git build.

```bash
npm run deploy:dry                        # print the manifest, token redacted
npm run deploy -- --name opentry-staging  # deploy a second copy
npm run deploy -- --skip-git-check        # deploy anyway (see below)
```

### Zerops builds from GitHub, not your working copy

`npm run deploy` refuses to run with uncommitted changes, or when your local
commit differs from `origin`. This is not fussiness — deploying unpushed work
silently ships the *previous* commit, and the symptom is a service
crash-looping on an error you already fixed. Commit and push first.

---

## What you get

| Service | Public | Holds the Zerops token |
|---|---|---|
| `api` | Yes | No |
| `controller` | No — declares no ports | Yes |
| `db` (PostgreSQL) | No | — |

The controller immediately starts warming the first trial. That takes several
minutes, so the pool panel reads *provisioning* for a while. This is expected —
it is exactly the delay the product exists to hide from visitors.

---

## Configuration

Set on the `controller` service (or at project scope):

| Variable | Default | What it does |
|---|---|---|
| `OPENTRY_ZEROPS_TOKEN` | — | **Required.** Creates and destroys trial projects. Note the prefix: Zerops reserves `ZEROPS_` for its own variables and rejects imports that define one |
| `OPENTRY_WARM_PER_APP` | `1` | Finished trials kept idling per app |
| `OPENTRY_MAX_CONCURRENT_TRIALS` | `6` | Hard ceiling on live trials — your blast radius |
| `OPENTRY_VISITOR_SALT` | generated | Salt for visitor hashing. Must be **project-scoped** so `api` and `controller` agree |
| `OPENTRY_RECONCILE_MS` | `20000` | How often the pool is topped up |

Raising `OPENTRY_MAX_CONCURRENT_TRIALS` raises your bill. Each live trial costs
roughly **$0.0043 per 30 minutes** at Zerops list prices; the ceiling is what
stands between a bug and a drained account.

---

## Adding an app to the catalog

Create `catalog/<slug>/opentry.yaml`. Validate it offline before deploying —
this catches errors in milliseconds instead of a 6-minute provisioning round
trip:

```bash
npm run catalog:check
npm run catalog:check -- --show <slug>   # see the rendered Zerops Import YAML
```

Then prove it really provisions:

```bash
npm run gonogo -- --app <slug>     # create, verify, destroy for real
npm run gonogo:keep -- --app <slug>  # leave it up to click around
npm run gonogo:cleanup             # remove strays
```

**Docker images are the easy path** — no build step, and most projects publish
one. Copy `catalog/n8n/opentry.yaml` as a starting point. Two rules that are
easy to get wrong and fail silently:

- A Docker service has **no build phase**. Do not add a `build:` section.
- Docker VMs take **fixed** `cpu`/`ram`/`disk`, never `min*`/`max*` ranges.

---

## Safety notes if you run this publicly

The defaults are conservative, but understand them before opening it up:

- Deletion is tag-guarded — a project without `OPENTRY_EPHEMERAL` is never
  touched. Do not weaken this.
- Orphaned projects (controller crashed mid-provision) are reaped after 15
  minutes.
- Manifests are untrusted input: resource requests are clamped downward, and
  SMTP-shaped environment keys are rejected so a trial cannot become a mail
  relay.
- One trial per visitor, identified by a salted hash of IP + user-agent. No raw
  IP is stored.

Run OpenTry in its **own Zerops account** if you can. The token can delete
projects, and although the tag guard prevents that, isolation is cheaper than
trust.

---

## Local development

The API and controller both need PostgreSQL:

```bash
export DATABASE_URL=postgresql://user:pass@localhost:5432/opentry
npm run start:api          # http://localhost:3000
npm run start:controller   # needs ZEROPS_TOKEN; provisions real projects
```

The controller talks to real Zerops and spends real credit. To work on the
frontend or API alone, run only `start:api` — the UI degrades gracefully with
an empty pool.
