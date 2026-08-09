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
 * `new URL(path, base)` discards the base entirely when `path` is absolute, so
 * `https://attacker.example/collect` is not a path under the trial — it is a
 * different host. That matters more for seeding than for verification, because
 * seed steps interpolate the trial's generated admin credentials into bodies
 * and headers: the controller would post them to a third party from inside the
 * control plane. A verify check leaks less, but it still turns the controller
 * into an open request proxy, which is not a thing to leave lying around.
 *
 * Protocol-relative `//host/x` does the same thing without a scheme, which is
 * what the negative lookahead is for — it is the form people forget.
 *
 * This is deliberately a whitelist of one shape: a single leading slash. Every
 * legitimate check and seed step in the catalog is already written that way.
 */

/** True when `path` can only resolve underneath the URL it is joined to. */
export function isLocalPath(path) {
  return typeof path === 'string' && /^\/(?!\/)/.test(path);
}

/**
 * @param {string} path
 * @param {string} where  context for the error message ("seed[0] \"login\"")
 * @param {(msg:string)=>Error} [wrap] build a domain-specific error
 */
export function assertLocalPath(path, where, wrap = (m) => new Error(m)) {
  if (!isLocalPath(path)) {
    throw wrap(`${where}: path must be local and start with "/" (got "${String(path).slice(0, 60)}")`);
  }
}
