/**
 * Minimal Zerops REST client for the OpenTry controller.
 *
 * Every path below was read from the live OpenAPI spec
 * (https://api.app-prg1.zerops.io/api/rest/public/swagger/openapi.yml),
 * not from documentation prose. See docs/api-surface.md.
 *
 * SAFETY: this module can delete projects. `deleteProject` refuses to act
 * unless the caller supplies both the exact project id AND the expected tag,
 * and the project is re-fetched and re-checked immediately before deletion.
 * There is deliberately no "delete by name" or "delete by search" path.
 */

const DEFAULT_BASE = 'https://api.app-prg1.zerops.io/api/rest/public';

export class ZeropsError extends Error {
  constructor(message, { status, body, path, transient = false, cause } = {}) {
    super(message);
    this.name = 'ZeropsError';
    this.status = status;
    this.body = body;
    this.path = path;
    /** True for network/timeout/5xx failures that are worth retrying. */
    this.transient = transient;
    if (cause) this.cause = cause;
  }
}

/**
 * Zerops wraps every collection response as `{ list: [...], totalCount: n }`.
 * Not `items`, not a bare array. Verified against the live API — assuming
 * `items` silently produced empty arrays and cost a debugging cycle.
 */
function unwrapList(res) {
  if (Array.isArray(res)) return res;
  return res?.list ?? res?.items ?? res?.itemList ?? [];
}

export class ZeropsClient {
  /**
   * @param {object} opts
   * @param {string} opts.token      Personal access token. NEVER send to a browser.
   * @param {string} [opts.baseUrl]
   * @param {number} [opts.timeoutMs]
   */
  constructor({ token, baseUrl = DEFAULT_BASE, timeoutMs = 30_000, onRetry } = {}) {
    if (!token) throw new Error('ZeropsClient requires a token');
    this.token = token;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
    this.onRetry = onRetry;
    this._clientId = null;
  }

  /**
   * One HTTP attempt. Wrapped by `request`, which handles retries.
   */
  async #attempt(method, path, body) {
    const url = `${this.baseUrl}${path}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        signal: ctrl.signal,
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });

      const text = await res.text();
      let parsed = null;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      }

      if (!res.ok) {
        throw new ZeropsError(
          `${method} ${path} -> HTTP ${res.status}: ${
            typeof parsed === 'string' ? parsed.slice(0, 400) : JSON.stringify(parsed)?.slice(0, 400)
          }`,
          { status: res.status, body: parsed, path },
        );
      }
      return parsed;
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new ZeropsError(`${method} ${path} timed out after ${this.timeoutMs}ms`, {
          path,
          transient: true,
        });
      }
      // Undici surfaces DNS/TCP/TLS problems as a bare "fetch failed".
      if (!(err instanceof ZeropsError)) {
        throw new ZeropsError(`${method} ${path} -> ${err.message}`, {
          path,
          transient: true,
          cause: err,
        });
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Perform a request, retrying transient failures with exponential backoff.
   *
   * WHY: provisioning holds a connection open for minutes at a time, and a
   * single dropped packet used to fail an entire trial — worse, it could fail
   * the CLEANUP too, orphaning a real project that then billed until the
   * reaper noticed. A network blip must not cost infrastructure.
   *
   * Retried: network errors, timeouts, 429, and 5xx.
   * Never retried: 4xx other than 429 — those are our bug, and repeating a
   * rejected request just wastes time. POSTs are still retried because every
   * mutating call we make is either idempotent or guarded elsewhere (project
   * import is preceded by a duplicate-name check; delete is tag-guarded).
   */
  async request(method, path, body, { retries = 4 } = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await this.#attempt(method, path, body);
      } catch (err) {
        lastErr = err;
        const retryable =
          err.transient === true || err.status === 429 || (err.status >= 500 && err.status < 600);
        if (!retryable || attempt === retries) throw err;

        // 400ms, 800ms, 1.6s, 3.2s — plus jitter so parallel callers spread out.
        const delay = 400 * 2 ** attempt + Math.random() * 250;
        this.onRetry?.({ method, path, attempt: attempt + 1, delay, error: err.message });
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw lastErr;
  }

  // --- identity -----------------------------------------------------------

  /**
   * GET /user/info -> the authenticated user, including the client (org) id.
   *
   * NOTE, learned the hard way: `/auth/info` (operationId getUserInfo in the
   * OpenAPI spec) is SESSION-scoped and returns 401 for a personal access
   * token, even though the spec documents the same Bearer scheme for both.
   * `/user/info` is the endpoint that accepts a PAT. Do not "fix" this back.
   */
  async getUserInfo() {
    return this.request('GET', '/user/info');
  }

  /**
   * The client (organisation) id that owns projects. Every project endpoint is
   * scoped by it, so we resolve it once and cache.
   */
  async getClientId() {
    if (this._clientId) return this._clientId;
    const info = await this.getUserInfo();
    // The shape has moved between API versions; probe the known locations.
    const id =
      info?.clientUserList?.[0]?.clientId ??
      info?.clientUserList?.[0]?.client?.id ??
      info?.clientId ??
      info?.client?.id;
    if (!id) {
      throw new ZeropsError(
        'Could not resolve clientId from /user/info. Response keys: ' +
          Object.keys(info ?? {}).join(', '),
        { body: info },
      );
    }
    this._clientId = id;
    return id;
  }

  // --- projects -----------------------------------------------------------

  /** GET /client/{clientId}/project */
  async listProjects() {
    const clientId = await this.getClientId();
    return unwrapList(await this.request('GET', `/client/${clientId}/project`));
  }

  /** GET /project/{id} */
  getProject(projectId) {
    return this.request('GET', `/project/${projectId}`);
  }

  /**
   * POST /client/{clientId}/project/import
   *
   * Takes the same Import YAML you'd paste into the GUI, as a string.
   * Returns the created project plus the async processes that provision it.
   */
  async importProject(yamlString) {
    const clientId = await this.getClientId();
    return this.request('POST', `/client/${clientId}/project/import`, { yaml: yamlString });
  }

  /** GET /project/{id}/service-stack */
  async listServices(projectId) {
    return unwrapList(await this.request('GET', `/project/${projectId}/service-stack`));
  }

  /** GET /project/{id}/process — async operations in flight for this project. */
  async listProjectProcesses(projectId) {
    return unwrapList(await this.request('GET', `/project/${projectId}/process`));
  }

  /** GET /process/{id} */
  getProcess(processId) {
    return this.request('GET', `/process/${processId}`);
  }

  /** GET /service-stack/{id}/container */
  async listContainers(serviceStackId) {
    return unwrapList(await this.request('GET', `/service-stack/${serviceStackId}/container`));
  }

  /** PUT /service-stack/{id}/restart */
  restartService(serviceStackId) {
    return this.request('PUT', `/service-stack/${serviceStackId}/restart`);
  }

  /** PUT /service-stack/{id}/stop */
  stopService(serviceStackId) {
    return this.request('PUT', `/service-stack/${serviceStackId}/stop`);
  }

  /** PUT /service-stack/{id}/enable-subdomain-access */
  enableSubdomain(serviceStackId) {
    return this.request('PUT', `/service-stack/${serviceStackId}/enable-subdomain-access`);
  }

  /**
   * The Zerops region slug, derived from the API host
   * (`api.app-prg1.zerops.io` -> `prg1`). Subdomain URLs are region-scoped.
   */
  get region() {
    return new URL(this.baseUrl).hostname.match(/app-([a-z0-9]+)\./)?.[1] ?? 'prg1';
  }

  /**
   * Compose a service's public Zerops subdomain URL.
   *
   * VERIFIED against a live project — this is not documented anywhere and the
   * URL is NOT returned by any endpoint. `OutDtoServiceStack` only exposes
   * `subdomainAccess: boolean`; the host fragment lives on the project as
   * `zeropsSubdomainHost` (a short hash such as "2bb8"). The full form is:
   *
   *     https://{serviceName}-{zeropsSubdomainHost}-{port}.{region}.zerops.app
   *     e.g.   https://api-2bb8-3000.prg1.zerops.app
   *
   * Note the port is part of the HOSTNAME, not a `:port` suffix — a service
   * exposing several ports gets several subdomains.
   */
  subdomainUrl({ serviceName, subdomainHost, port }) {
    if (!subdomainHost) return null;
    return `https://${serviceName}-${subdomainHost}-${port}.${this.region}.zerops.app`;
  }

  // --- destructive --------------------------------------------------------

  /**
   * DELETE /project/{id} — guarded.
   *
   * Refuses unless the project, re-fetched at call time, actually carries
   * `requiredTag`. This is the single most dangerous call in the codebase:
   * an unguarded version could delete a user's real project. The guard is not
   * optional and there is no bypass flag.
   *
   * @param {string} projectId    exact id, recorded at creation time
   * @param {string} requiredTag  e.g. 'OPENTRY_EPHEMERAL'
   */
  async deleteProject(projectId, requiredTag) {
    if (!projectId || typeof projectId !== 'string') {
      throw new Error('deleteProject: a concrete projectId is required');
    }
    if (!requiredTag) {
      throw new Error('deleteProject: requiredTag is mandatory — refusing to delete untagged');
    }

    const project = await this.getProject(projectId);
    const tags = project?.tags ?? project?.tagList ?? [];
    if (!Array.isArray(tags) || !tags.includes(requiredTag)) {
      throw new Error(
        `REFUSING TO DELETE project ${projectId}: expected tag "${requiredTag}", ` +
          `found [${(tags ?? []).join(', ') || 'none'}]. This project was not created by OpenTry.`,
      );
    }

    return this.request('DELETE', `/project/${projectId}`);
  }
}

/**
 * Poll until `check()` returns truthy, or time runs out.
 * Calls onTick(elapsedMs, lastValue) between attempts so callers can stream
 * progress to the UI instead of showing a dead spinner.
 */
export async function pollUntil(check, { timeoutMs = 300_000, intervalMs = 3_000, onTick } = {}) {
  const started = Date.now();
  let last;
  for (;;) {
    last = await check();
    if (last) return last;
    const elapsed = Date.now() - started;
    if (elapsed > timeoutMs) {
      throw new Error(`pollUntil: timed out after ${Math.round(elapsed / 1000)}s`);
    }
    onTick?.(elapsed, last);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
