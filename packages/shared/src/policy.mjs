/**
 * Runtime policy: which apps a deployment is willing to hand to strangers.
 *
 * THE PROBLEM THIS EXISTS FOR
 * Zerops' firewall is inbound only. There is no egress filtering, so a trial
 * cannot be network-isolated, and an app that can make arbitrary outbound
 * requests is — in anonymous hands, with no signup — an open proxy on a
 * 30-minute lease. n8n is precisely that by design.
 *
 * Proof-of-work makes volume expensive. It does not make a single abusive
 * request impossible, and nothing at the product layer can. So the remaining
 * control is a policy decision, and the safe default is to not offer those
 * apps at all:
 *
 *   ELEVATED-RISK APPS ARE OFF BY DEFAULT.
 *
 * An operator who understands the trade can switch them on with
 * OPENTRY_ALLOW_ELEVATED=true. Making that an explicit, documented choice is
 * the honest design: it is a decision someone should have to make on purpose,
 * not one they inherit from a default.
 *
 * There is also a KILL SWITCH. OPENTRY_DISABLED_APPS takes a comma-separated
 * list of slugs to withdraw immediately. It is read on every request rather
 * than cached, so pulling an app is an env-var change and a service reload —
 * no redeploy, no code change, seconds rather than minutes. If a catalog entry
 * turns out to be abusable at 2am, that matters more than elegance.
 */

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v ?? '').trim());

/** Slugs withdrawn by the operator, read fresh each call. */
export function disabledApps(env = process.env) {
  return new Set(
    String(env.OPENTRY_DISABLED_APPS ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function elevatedAllowed(env = process.env) {
  return truthy(env.OPENTRY_ALLOW_ELEVATED);
}

/**
 * Can this app be offered right now?
 * @returns {{offered: boolean, reason: string|null}}
 */
export function appPolicy(manifest, env = process.env) {
  if (!manifest) return { offered: false, reason: 'unknown-app' };
  if (manifest.app.hidden) return { offered: false, reason: 'hidden' };

  if (disabledApps(env).has(manifest.app.slug.toLowerCase())) {
    return { offered: false, reason: 'disabled-by-operator' };
  }

  if (manifest.app.capabilities.level === 'elevated' && !elevatedAllowed(env)) {
    return { offered: false, reason: 'elevated-risk-not-enabled' };
  }

  return { offered: true, reason: null };
}

/** Human explanation, for the catalog UI and API errors. */
export const POLICY_REASONS = Object.freeze({
  'unknown-app': 'No such app.',
  hidden: 'Not publicly listed.',
  'disabled-by-operator': 'Temporarily withdrawn by the operator.',
  'elevated-risk-not-enabled':
    'This app can make outbound network requests. Because Zerops cannot ' +
    'firewall a trial’s egress, it is disabled unless the operator opts in ' +
    'with OPENTRY_ALLOW_ELEVATED=true.',
});

/** Split a catalog into what is offered and what is withheld, with reasons. */
export function partitionCatalog(catalog, env = process.env) {
  const offered = [];
  const withheld = [];
  for (const manifest of catalog.values()) {
    if (manifest.app.hidden) continue;
    const policy = appPolicy(manifest, env);
    (policy.offered ? offered : withheld).push({ manifest, policy });
  }
  return { offered, withheld };
}
