/**
 * One rule, in one place: a path supplied by a manifest may only ever address
 * the trial itself.
 *
 * Both things OpenTry does with a manifest-supplied path resolve it against the
 * trial's URL:
 *
 *   verify checks   new URL(check.path, trialUrl)   -> lifecycle.mjs
 *   seed steps      new URL(step.path,  trialUrl)   -> seed.mjs
 *
 * `new URL(path, base)` discards the base entirely when `path` turns out to be
 * absolute, so the wrong string here is not a path under the trial — it is a
 * different host. That matters most for seeding, which interpolates the trial's
 * generated admin credentials into bodies and headers: the controller would
 * post them to a third party, from inside the control plane. A verify check
 * leaks less but still turns the controller into an open request proxy.
 *
 * WHY THIS IS NOT A REGEX
 * It was, and the regex was wrong. `/^\/(?!\/)/` — one slash, not two — reads
 * as an airtight description of "a local path" and is not one, because the URL
 * parser treats a backslash as a separator too:
 *
 *   new URL('/\\evil.example/x', 'https://trial.example')
 *   // -> https://evil.example/x
 *
 * That string starts with exactly one forward slash, so it passed. The lesson
 * is not "also reject backslashes" — it is that hand-written patterns keep
 * losing to the URL parser's real behaviour, and the only reliable way to know
 * where a URL points is to resolve it and look. So: resolve against a canary
 * origin and require the result to still be on it. Resolution is deterministic,
 * so a path that stays on the canary stays on any base, and one that escapes
 * escapes every base.
 */

/** An origin no trial can ever have, used purely as a resolution probe. */
const CANARY = 'https://opentry-local-path-probe.invalid';

/**
 * True when `path` can only ever resolve underneath the URL it is joined to.
 *
 * Two conditions, doing different jobs. The origin check is the security
 * boundary and the only one that matters for safety. The leading slash is an
 * ergonomic rule: `foo/bar` is same-origin and therefore harmless, but it
 * resolves relative to the base's PATH, so what it means depends on a URL the
 * manifest author never sees. Every catalog entry already writes the slash;
 * requiring it turns a silent surprise into a parse error.
 */
export function isLocalPath(path) {
  if (typeof path !== 'string' || !path.startsWith('/')) return false;
  try {
    return new URL(path, CANARY).origin === CANARY;
  } catch {
    return false;
  }
}

/**
 * @param {string} path
 * @param {string} where  context for the error message ("seed[0] \"login\"")
 * @param {(msg:string)=>Error} [wrap] build a domain-specific error
 */
export function assertLocalPath(path, where, wrap = (m) => new Error(m)) {
  if (!isLocalPath(path)) {
    throw wrap(
      `${where}: path must stay on the trial's own origin (got "${String(path).slice(0, 60)}")`,
    );
  }
}

/**
 * Resolve a manifest path against the trial, refusing anything that leaves it.
 *
 * Use this at the point of the request rather than re-deriving the URL, so the
 * string that was checked is the string that gets fetched. The origin is
 * compared after resolution, which also catches a base URL that is itself
 * unexpected.
 *
 * @param {string} path
 * @param {string} baseUrl the trial's public URL
 * @param {string} where   context for the error message
 * @returns {string} absolute URL, guaranteed same-origin with `baseUrl`
 */
export function resolveOnTrial(path, baseUrl, where) {
  const base = new URL(baseUrl);
  let resolved;
  try {
    resolved = new URL(path, base);
  } catch {
    throw new Error(`${where}: "${String(path).slice(0, 60)}" is not a usable path`);
  }
  if (resolved.origin !== base.origin) {
    throw new Error(
      `${where}: path resolves to ${resolved.origin}, which is not the trial (${base.origin})`,
    );
  }
  return resolved.toString();
}
