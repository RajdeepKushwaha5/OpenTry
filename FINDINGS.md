# Field notes from building on Zerops

Eighteen behaviours found while building [OpenTry](https://github.com/RajdeepKushwaha5/OpenTry),
which creates and destroys real Zerops projects on demand. None of them are in
the documentation. Each one cost a debugging cycle, and most of them cost that
cycle **because the platform accepted the input and then failed quietly** —
the import succeeds, the service reports healthy, and nothing works.

Written up for the Zerops team as much as for anyone else. Every claim here was
observed against the live API, and the fix that worked is included.

**Re-verified 10 August 2026.** Findings 1, 2, 3, 5, 8, 9, 10, 13, 17 and 18
were re-tested against the live API and the exact responses are quoted below.
Doing that corrected four of them — see 1, 5, 8 and 10 — and the measured
provisioning times had moved far enough to be worth a section of their own.

---

## The pattern worth fixing first

Nine of these eighteen share one shape:

> **The API accepts something invalid, returns 2xx, and the failure surfaces
> minutes later as a service that is stuck, silent, or unreachable.**

On a platform where the feedback loop is a 5-minute provision, a silent
rejection costs far more than a loud one. A 400 with a message would have
turned most of the entries below into ten-second fixes.

---

## Authentication

### 1. Personal access tokens do not work on `/auth/info`

`GET /auth/info` (operationId `getUserInfo`) refuses a personal access token.
The endpoint that accepts a PAT is `GET /user/info`.

```
GET /auth/info  →  403 {"error":{"code":"notAllowedForApplicationToken"}}
GET /user/info  →  200 {..., clientUserList:[{clientId: "..."}]}
```

The OpenAPI spec documents one security scheme — `httpAuthorizationHeaderBearer`
— for both, so there is nothing in the spec to suggest one of them will not
take your token. The operationId makes it worse: `getUserInfo` sits on
`/auth/info`, not on `/user/info`.

**Credit where due:** the error code is good. `notAllowedForApplicationToken`
says exactly what is wrong, which is more than most APIs manage. The gap is in
the spec, not the response.

**Suggestion:** note the session-only scope on `/auth/info` in the reference.

---

## API shape

### 2. Collections are `{ list, totalCount }`

Not `items`, not a bare array. Nothing in the docs shows a collection response
body, so the natural guess (`items`) produces an empty array rather than an
error — meaning the bug appears as "no projects exist" rather than "you read
the wrong field".

### 3. The subdomain URL is not returned by any endpoint

`OutDtoServiceStack` exposes only `subdomainAccess: boolean`. The host fragment
lives on the **project** as `zeropsSubdomainHost` (a short hash such as `2bb8`).
The URL has to be composed, and the port is part of the hostname:

```
https://{serviceName}-{project.zeropsSubdomainHost}-{port}.{region}.zerops.app
https://api-2bb8-3000.prg1.zerops.app
```

This is not documented anywhere we could find, and had to be reverse-engineered
by provisioning a project and inspecting both objects.

**Suggestion:** return the composed URL on the service object once subdomain
access is enabled. It is the single most-wanted value after a deploy.

---

## Import YAML

### 4. `enableSubdomainAccess: true` did not take effect

Set in the import manifest, the service came up with `subdomainAccess: false`
and no public HTTP routing. Calling
`PUT /service-stack/{id}/enable-subdomain-access` afterwards worked.

We now always call it explicitly rather than trusting the manifest field.

### 5. Three service families accept each other's resource fields, then misbehave

This one cost the most time, because each variant looks like the others.

| Family | Rejects | Wants |
|---|---|---|
| Databases | `minContainers` / `maxContainers` | `mode: HA \| NON_HA` |
| Object storage | `verticalAutoscaling` entirely | `objectStorageSize` |
| Docker (VM) | min/max **ranges** | fixed `cpu`, `ram`, `disk` |

Only the database case produces a clear error, and even then the useful part is
buried two levels down. The top-level message is generic:

```json
{ "code": "projectImportInvalidParameter", "message": "Invalid parameter provided.",
  "meta": [ { "metadata": {
      "db.minContainers": ["setting min containers not supported"],
      "hostname": ["db"] } } ] }
```

Read only `error.message` — the obvious thing to log — and you learn nothing.

Sending min/max ranges to a **Docker** service is accepted at import, and the
VM then never initialises. There is no error anywhere: the service sits in
`READY_TO_DEPLOY` until something else times out.

### 6. Docker services have no build phase, and a `build:` section breaks them

The base list shows `Build: -` for Docker, and the docs say "base cannot be
docker — build phase runs in containers, not VMs". What is not said is that
including a `build:` section at all leaves the service stuck in
`READY_TO_DEPLOY` indefinitely, with no error.

The official `recipe-docker` has no build section. That example is the
documentation for this.

### 7. Inside an embedded `zeropsYaml`, `base` and `deployFiles` must be arrays

A repo-level `zerops.yml` accepts strings:

```yaml
build:
  base: nodejs@22
  deployFiles: ./dist
```

The same content embedded in an import manifest's `zeropsYaml` must be arrays.
Strings are accepted by the import endpoint and then **no build is ever
triggered**. Validating against Zerops' own published JSON Schema catches this
in milliseconds; the API does not.

### 8. `ZEROPS_`-prefixed keys are rejected in `envSecrets` — but accepted in `envVariables`

```
userDataZeropsPrefixForbidden: Custom env variables with 'ZEROPS_' prefix are forbidden.
```

Clear error, correctly rejected, and noted mainly because `ZEROPS_TOKEN` is the
obvious name for a Zerops token and nothing warns you until import time.

The part worth reporting is the inconsistency. That rejection fires for
`envSecrets`. The **same key in `envVariables` imports without complaint** — we
retested both deliberately. Whichever behaviour is intended, the two blocks
disagree about a rule described as a global prohibition.

### 9. Env keys collide case-insensitively with generated ones

Declaring `HOSTNAME` fails the entire import:

```
[userDataDuplicateKey] UserData key 'HOSTNAME' is not unique in service stack frame of reference
```

Zerops generates a lowercase `hostname` for every service, and the uniqueness
check ignores case. `HOSTNAME` is a very common Docker env var — Umami, among
others, expects it. Workaround: pass it inline in the `docker run` command
instead of declaring it on the service.

Same split as finding 8: this fires for `envSecrets`, while `HOSTNAME` in
`envVariables` is accepted at import.

### 10. The YAML preprocessor evaluates directives inside `#` comments

Writing a preprocessor directive inside a comment — to *explain* it — is parsed
as a directive. A well-formed one is evaluated silently, so you never notice. A
malformed one fails the whole import:

```
# SALT: <@generateRandomString>          <-- no argument, inside a comment
yamlPreprocessingError: variable [] not found
```

The response metadata says plainly what happened:

```json
{ "item": "generateRandomString", "itemType": "function",
  "positionLine": "5", "positionColumn": "33", "positionNear": "g>" }
```

Line 5, column 33 is **inside the comment**. Documenting a preprocessor
directive in the file that uses it is a natural thing to do, and it breaks the
file — with an error that never mentions comments.

**Suggestion:** skip `#` comments in the preprocessing pass, or say in the
reference that they are evaluated.

### 11. The preprocessor evaluates per occurrence

`<@generateRandomString(<32>)>` declared on two services yields two **different**
values. For a secret two services must share (a signing salt, a shared token),
this silently produces a mismatch. It belongs at project scope, which every
service inherits.

---

## Runtime

### 12. `READY_TO_DEPLOY` is both normal and terminal

A runtime created with `buildFromGit` sits in `READY_TO_DEPLOY` while its build
runs, then flips to `ACTIVE`. It also sits there **forever** if no build was
triggered — for example when the repo's `zerops.yml` declares a `setup:` name
that does not match the service hostname.

The two are indistinguishable from the status alone. Our first encounter cost
eight minutes of watching a service that was never going to change.

### 13. A service reports `ACTIVE` ~8 seconds before its HTTP port registers

Calling `enable-subdomain-access` in that window returns:

```
400 serviceStackIsNotHttp: Service stack is not http or https
```

`ports` is still `[]` while `requestedPorts` already holds the entry. Retrying
for ~10s resolves it. Worth noting because `ACTIVE` reads as "ready for
anything".

### 14. Port 80 under `--network=host` collides with the project's L7 balancer

**The most misleading failure we hit.** A Docker container bound to port 80
(or 443) with host networking conflicts with the project's own balancer. The
result:

- service status: `ACTIVE`
- subdomain: resolves
- HTTP: nothing, ever

Every signal says healthy. This cost us two catalog candidates — Excalidraw and
IT-Tools — before we understood it. Both are nginx images that bind 80 and
ignore any port override, so this rules out a whole class of common images.

**Suggestion:** reject port 80/443 on a Docker service at import time. It can
never work.

### 15. Docker VM boot is slow enough to look broken

A Docker service can sit in `READY_TO_DEPLOY` for several minutes on a full
kernel boot. Our stuck-detector originally fired at 150s and produced a
confidently wrong diagnosis. We now allow 600s for VMs and 150s for containers.

The docs do mention VMs boot slower; they do not give an order of magnitude,
and that is the number you need to build a timeout.

### 16. Image size dominates provisioning time

Stirling PDF's image (bundling LibreOffice and OCR) exceeded a 12-minute
ceiling on the pull alone and never started. Umami, at a couple of hundred MB,
provisions end-to-end including a managed Postgres — see the measured times
below.

For anything provisioning on demand, image size is the number to optimise.

### 17. A missing `buildFromGit` is reported as `serviceStackNotFound`

`PUT /service-stack/{id}/trigger-pipeline` is how you rebuild an already
deployed service. Called with an empty body against a service that plainly
exists — same id `GET /project/{id}/service-stack` had just returned, status
`ACTIVE` — it answers:

```
HTTP 400 {"error":{"code":"serviceStackNotFound","message":"Service stack not found."}}
```

The service stack is found. The missing field is `buildFromGit`, which is
documented as optional and nullable in the OpenAPI schema:

```json
{ "buildFromGit": "https://github.com/owner/repo" }   // required in practice
```

We went looking for a deleted service, re-listed the project, and compared ids
before thinking to vary the body. An error naming the wrong object is more
expensive than a vague one, because it sends you somewhere specific.

Two suggestions: report the missing field, and mark `buildFromGit` required for
a service that has previously built from git.

### 18. Environment variables are import-time, and a rebuild does not re-read them

`envVariables` in an Import YAML are applied when the project is **created**.
Editing the manifest and triggering a rebuild — even a full pipeline rebuild
from git — leaves the running services with whatever they were imported with.

This is reasonable once you know it, and invisible until you do. We moved a
concurrency ceiling from service scope to project scope, redeployed, and watched
the API keep reporting the old value while the controller used the new one. The
YAML in the repository and the behaviour of the deployment had silently
diverged, and nothing in the rebuild output suggested it.

To change one on a running deployment:

```
POST /project/{id}/env      { "key": "...", "content": "..." }
PUT  /project-env/{id}      { "key": "...", "content": "..." }   # update existing
```

then restart the services that read it. Note `GET /project/{id}/env` is **405**;
listing project variables is not the inverse of creating them.

Suggestion: a note in the Import YAML reference saying which fields are
creation-only, and a warning when a rebuild is triggered against a manifest
whose variables differ from the deployed set.

---

## Measured provisioning times, and a warning about them

Full end-to-end, from `POST .../project/import` to a URL serving verified
traffic, including a managed PostgreSQL.

**These numbers moved substantially during the build, on unchanged manifests.**
Both sets are real; the second is what the platform does now.

| App | Shape | First measured (7 Aug) | Now (10 Aug, p50 / p95) |
|---|---|---|---|
| Umami | Docker + Postgres | 264s | **732s** / 766s |
| Metabase | Docker + Postgres (JVM) | 264s | **726s** / 794s |
| Vikunja | Docker + Postgres | 265s | **755s** / 1001s |
| n8n | Docker + Postgres | 310s | **666s** / 741s |
| Node.js recipe | native runtime + Postgres | 296s | not re-measured |

Roughly 2.4x slower, three days apart, same manifests. We have no visibility
into why — it could be regional load, image-registry throughput, or scheduling.

**This is the finding, not a footnote.** Our provisioning timeout was 12
minutes, chosen against the first column with what looked like generous
headroom. Once real completion times reached 749s, a 720s ceiling sat *inside*
the normal spread and behaved exactly as you would expect — it failed 60% of
provisions with `pollUntil: timed out after 721s` while the successes were
finishing at 749s. Every one of those looked like an infrastructure fault. It
was a stale constant.

If you build anything with a timeout against Zerops provisioning, derive it
from a recent measurement and leave real headroom. Ours is now 20 minutes, and
vikunja's p95 of 1001s says that is not excessive.

A native runtime built from git is **not** faster than pulling a Docker image —
`npm install` in the build pipeline costs about what an image pull does.

---

## What worked well

Worth saying, since the rest of this is a list of problems:

- **`POST /client/{id}/project/import`** is the reason this project exists. Being
  able to declare a private network, a managed database, a runtime, TLS and
  routing in one YAML and get it all back — currently in about twelve minutes —
  is not something we found elsewhere at this price.
- **Project tags** are first-class and queryable, which is what makes a
  tag-guarded delete safe enough to run unattended.
- **Per-minute billing with a free Lightweight core** is what makes disposable
  infrastructure economically real. A 30-minute trial costs about **$0.0086**,
  estimated from published list prices.
- **The published import JSON Schema** catches most manifest errors offline in
  milliseconds. It deserves to be more prominent — it would have prevented
  entries 5 and 7 above.
- **Error messages, when they exist, are excellent.** `serviceStackIsNotHttp`
  and `userDataDuplicateKey` told us exactly what was wrong. The problem is not
  error quality; it is the cases that return 2xx.

---

*Compiled while building OpenTry for The Zerops Challenge, August 2026.
Happy to turn any of this into issues or documentation PRs.*
