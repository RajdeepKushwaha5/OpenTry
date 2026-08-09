# Field notes from building on Zerops

Eighteen behaviours found while building [OpenTry](https://github.com/RajdeepKushwaha5/OpenTry),
which creates and destroys real Zerops projects on demand. None of them are in
the documentation. Each one cost a debugging cycle, and most of them cost that
cycle **because the platform accepted the input and then failed quietly** —
the import succeeds, the service reports healthy, and nothing works.

Written up for the Zerops team as much as for anyone else. Every claim here was
observed against the live API, and the fix that worked is included.

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

`GET /auth/info` (operationId `getUserInfo`) returns **401** for a personal
access token. The endpoint that accepts a PAT is `GET /user/info`.

The OpenAPI spec documents one security scheme — `httpAuthorizationHeaderBearer`
— for both, so there is no way to tell them apart from the spec. The first
assumption is that the token is bad.

```
GET /auth/info  →  401 {"error":{"code":"notAuthorized"}}
GET /user/info  →  200 {..., clientUserList:[{clientId: "..."}]}
```

**Suggestion:** note the session-only scope on `/auth/info`, or return an error
code that distinguishes "wrong credential type" from "invalid credential".

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

Only the database case produces a clear error:

```
db.minContainers: ["setting min containers not supported"]
```

Sending min/max ranges to a **Docker** service is accepted at import, and the
VM then never initialises. There is no error anywhere — the service simply sits
in `CREATING`.

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

### 8. Custom env vars cannot start with `ZEROPS_`

```
userDataZeropsPrefixForbidden: Custom env variables with 'ZEROPS_' prefix are forbidden.
```

Clear error, correctly rejected — noted only because `ZEROPS_TOKEN` is the
obvious name for a Zerops token and nothing warns you until import time.

### 9. Env keys collide case-insensitively with generated ones

Declaring `HOSTNAME` fails the entire import:

```
[userDataDuplicateKey] UserData key 'HOSTNAME' is not unique in service stack frame of reference
```

Zerops generates a lowercase `hostname` for every service, and the uniqueness
check ignores case. `HOSTNAME` is a very common Docker env var — Umami, among
others, expects it. Workaround: pass it inline in the `docker run` command
instead of declaring it on the service.

### 10. The YAML preprocessor reads comments

Writing the random-string generator's literal syntax inside a `#` comment — to
*explain* it — fails the import:

```
yamlPreprocessingError: variable [] not found
```

The preprocessor does not skip comments. Documenting a preprocessor directive
in the file that uses it is a natural thing to do, and it breaks the file.

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
confidently wrong diagnosis. We now allow 420s for VMs and 150s for containers.

The docs do mention VMs boot slower; they do not give an order of magnitude,
and that is the number you need to build a timeout.

### 16. Image size dominates provisioning time

Stirling PDF's image (~2.5 GB, bundling LibreOffice and OCR) exceeded a
12-minute ceiling on the pull alone. Umami (~200 MB) provisions in 264s
end-to-end including a managed Postgres.

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

## Measured provisioning times

Full end-to-end, from `POST .../project/import` to a URL serving verified
traffic, including a managed PostgreSQL:

| App | Shape | Time |
|---|---|---|
| Umami | Docker + Postgres | **264s** |
| Metabase | Docker + Postgres (JVM) | **264s** |
| Vikunja | Docker + Postgres | **265s** |
| n8n | Docker + Postgres | **310s** |
| Node.js recipe | native runtime + Postgres | **296s** |

A native runtime built from git is **not** faster than pulling a Docker image —
`npm install` in the build pipeline costs about what an image pull does.

---

## What worked well

Worth saying, since the rest of this is a list of problems:

- **`POST /client/{id}/project/import`** is the reason this project exists. Being
  able to declare a private network, a managed database, a runtime, TLS and
  routing in one YAML and get it all back in under five minutes is not
  something we found elsewhere at this price.
- **Project tags** are first-class and queryable, which is what makes a
  tag-guarded delete safe enough to run unattended.
- **Per-minute billing with a free Lightweight core** is what makes disposable
  infrastructure economically real. A 30-minute trial costs about **$0.004**.
- **The published import JSON Schema** catches most manifest errors offline in
  milliseconds. It deserves to be more prominent — it would have prevented
  entries 5 and 7 above.
- **Error messages, when they exist, are excellent.** `serviceStackIsNotHttp`
  and `userDataDuplicateKey` told us exactly what was wrong. The problem is not
  error quality; it is the cases that return 2xx.

---

*Compiled while building OpenTry for The Zerops Challenge, August 2026.
Happy to turn any of this into issues or documentation PRs.*
