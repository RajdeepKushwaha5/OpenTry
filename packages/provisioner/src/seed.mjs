/**
 * Trial seeding.
 *
 * THE PROBLEM
 * A freshly provisioned app opens on a setup wizard or an empty dashboard.
 * A visitor evaluating software in a 30-minute window should not spend the
 * first five of them creating an admin account and clicking Next. An empty
 * screen also makes real infrastructure look fake — the single most common
 * reaction to a blank Metabase is "is this actually working?".
 *
 * HOW
 * Seed steps are plain HTTP requests run against the trial's PUBLIC URL after
 * the behaviour checks pass and before the trial is released. Public, because
 * the controller lives in a different Zerops project and private networks do
 * not cross project boundaries — there is no way to reach the app internally.
 *
 * Steps can capture values from a response and use them in later steps, which
 * is required by real setup APIs: Metabase, for instance, hands out a
 * single-use setup token that must be echoed back to create the first user.
 *
 * FAILURE POLICY
 * Seeding is best-effort by default. A trial that works but looks empty is
 * still a working trial; failing the whole provision because a convenience
 * step 404'd would trade something valuable for something cosmetic. A step
 * may opt into `required: true` when the trial is genuinely useless without it.
 */

import { assertLocalPath, resolveOnTrial } from '../../shared/src/local-path.mjs';

/** A positive, finite millisecond count — or the default, never NaN. */
function boundedMs(value, ceiling, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, ceiling);
}

/** Capture names that would poison the scope object rather than fill it. */
const UNSAFE_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

/** Resolve ${var} references against captured values and trial credentials. */
function interpolate(value, vars) {
  if (typeof value === 'string') {
    return value.replace(/\$\{(\w+)\}/g, (m, k) => (Object.hasOwn(vars, k) ? String(vars[k]) : m));
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, vars));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v, vars)]));
  }
  return value;
}

/** Read a dotted path out of a JSON body: "a.b.0.c". */
function pick(obj, path) {
  return path.split('.').reduce((cur, key) => (cur == null ? cur : cur[key]), obj);
}

/**
 * Run a manifest's seed steps against a live trial.
 *
 * @param {object} args
 * @param {string} args.baseUrl     the trial's public URL
 * @param {Array}  args.steps       normalised seed steps
 * @param {object} args.vars        starting variables (generated credentials)
 * @param {(e:object)=>void} args.emit
 * @returns {Promise<{ran:number, failed:number, skipped:boolean}>}
 */
export async function runSeed({ baseUrl, steps = [], vars = {}, emit = () => {} }) {
  if (!steps.length) return { ran: 0, failed: 0, skipped: true };

  // Null-prototype: captured names come from a manifest, and a plain object
  // would resolve ${constructor} to something inherited rather than captured.
  const scope = Object.assign(Object.create(null), vars);
  let ran = 0;
  let failed = 0;

  for (const step of steps) {
    const label = step.name;
    emit({ step: `seed:${label}`, status: 'running', message: label });

    try {
      // Resolved and origin-checked here, not only at parse time: `path` is
      // interpolated with captured values, so a response body could otherwise
      // steer the request somewhere the parsed manifest never mentioned.
      const url = resolveOnTrial(interpolate(step.path, scope), baseUrl, `seed "${label}"`);
      const body = step.body ? interpolate(step.body, scope) : undefined;

      const res = await fetch(url, {
        method: step.method,
        headers: {
          accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...interpolate(step.headers ?? {}, scope),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(step.timeoutMs),
      });

      const text = await res.text();
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }

      if (!step.expectStatus.includes(res.status)) {
        throw new Error(
          `expected ${step.expectStatus.join('/')} but got ${res.status}` +
            (typeof parsed === 'string' ? `: ${parsed.slice(0, 120)}` : ''),
        );
      }

      // Capture values for later steps (setup tokens, session ids, record ids).
      for (const [name, path] of Object.entries(step.capture ?? {})) {
        const value = pick(parsed, path);
        if (value === undefined) throw new Error(`could not capture "${name}" from ${path}`);
        scope[name] = value;
      }

      ran++;
      emit({ step: `seed:${label}`, status: 'ok', message: label });
    } catch (err) {
      failed++;
      if (step.required) {
        emit({ step: `seed:${label}`, status: 'error', message: `${label} — ${err.message}` });
        throw new Error(`Required seed step "${label}" failed: ${err.message}`);
      }
      // Best effort: note it and carry on. A plain trial beats no trial.
      emit({
        step: `seed:${label}`,
        status: 'ok',
        message: `${label} — skipped (${err.message})`,
      });
    }
  }

  return { ran, failed, skipped: false };
}

/** Validate and normalise the `seed:` block of a manifest. */
export function normaliseSeedStep(step, i) {
  const name = String(step.name ?? `seed ${i + 1}`);
  const method = String(step.method ?? 'POST').toUpperCase();
  if (!['GET', 'POST', 'PUT', 'PATCH'].includes(method)) {
    throw new Error(`seed[${i}] "${name}": unsupported method ${method}`);
  }
  if (!step.path) throw new Error(`seed[${i}] "${name}": path is required`);
  assertLocalPath(String(step.path), `seed[${i}] "${name}"`);

  for (const key of Object.keys(step.capture ?? {})) {
    if (UNSAFE_NAMES.has(key)) {
      throw new Error(`seed[${i}] "${name}": unsafe capture name "${key}"`);
    }
  }

  // Never let a bad value become NaN here: a step whose expected status is NaN
  // can never pass, and it reports as an unexpected response rather than as the
  // manifest error it is.
  let expectStatus = [200, 201, 202, 204];
  if (step.expectStatus != null) {
    const list = (Array.isArray(step.expectStatus) ? step.expectStatus : [step.expectStatus]).map(Number);
    if (!list.length || list.some((n) => !Number.isInteger(n) || n < 100 || n > 599)) {
      throw new Error(`seed[${i}] "${name}": expectStatus must be HTTP status codes`);
    }
    expectStatus = list;
  }

  return {
    name,
    method,
    path: String(step.path),
    headers: step.headers ?? {},
    body: step.body,
    capture: step.capture ?? {},
    expectStatus,
    required: step.required === true,
    timeoutMs: boundedMs(step.timeoutMs, 60_000, 20_000),
  };
}
