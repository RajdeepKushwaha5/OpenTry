/**
 * SVG badge for a maintainer's README.
 *
 * This is the other half of OpenTry. A visitor gets a trial; a maintainer gets
 * a button that stops them losing evaluators at the top of the funnel. Without
 * it the product only has one user.
 *
 * Rendered server-side as plain SVG rather than proxied through shields.io:
 * GitHub caches README images aggressively through camo, and a third-party
 * dependency in that path means someone else's downtime shows up as a broken
 * badge on other people's projects.
 *
 * The badge reflects real pool state, so it doubles as a status indicator —
 * a maintainer can see at a glance whether trials are actually available.
 */

/** Rough text width for the default sans stack at a given size. */
function textWidth(text, size = 11) {
  // Measured against DejaVu Sans, which is what most renderers fall back to.
  const wide = /[MWmw@]/;
  const narrow = /[iljt.,:'!|]/;
  let w = 0;
  for (const ch of text) {
    if (wide.test(ch)) w += size * 0.78;
    else if (narrow.test(ch)) w += size * 0.31;
    else if (ch === ' ') w += size * 0.29;
    else w += size * 0.58;
  }
  return Math.ceil(w);
}

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

const STATES = {
  ready: { label: 'try it live', colour: '#3bbdb2' },
  building: { label: 'warming up', colour: '#d97706' },
  empty: { label: 'try it live', colour: '#6b7280' },
  unknown: { label: 'unavailable', colour: '#9ca3af' },
};

/**
 * @param {object} o
 * @param {string} o.left    left-hand label, e.g. "OpenTry"
 * @param {'ready'|'building'|'empty'|'unknown'} o.state
 * @returns {string} SVG
 */
export function renderBadge({ left = 'OpenTry', state = 'ready' } = {}) {
  const { label, colour } = STATES[state] ?? STATES.unknown;

  const padding = 9;
  const lw = textWidth(left) + padding * 2;
  const rw = textWidth(label) + padding * 2 + 10; // +10 for the status dot
  const w = lw + rw;
  const h = 20;

  // aria-label rather than <title>: screen readers announce it, and GitHub
  // strips <title> from camo-proxied images.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"
     role="img" aria-label="${esc(left)}: ${esc(label)}">
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#fff" stop-opacity=".7"/>
    <stop offset=".1" stop-color="#aaa" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r"><rect width="${w}" height="${h}" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${lw}" height="${h}" fill="#24292f"/>
    <rect x="${lw}" width="${rw}" height="${h}" fill="${colour}"/>
    <rect width="${w}" height="${h}" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle"
     font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="${lw / 2}" y="15" fill="#010101" fill-opacity=".3">${esc(left)}</text>
    <text x="${lw / 2}" y="14">${esc(left)}</text>
    <text x="${lw + rw / 2 + 5}" y="15" fill="#010101" fill-opacity=".3">${esc(label)}</text>
    <text x="${lw + rw / 2 + 5}" y="14">${esc(label)}</text>
  </g>
  <circle cx="${lw + 11}" cy="${h / 2}" r="3.5" fill="#fff" fill-opacity="0.9"/>
</svg>`;
}

/** Markdown + HTML snippets a maintainer can paste straight into a README. */
export function badgeSnippets({ origin, slug, appName }) {
  const badge = `${origin}/badge/${slug}.svg`;
  const target = `${origin}/?app=${slug}`;
  return {
    badgeUrl: badge,
    tryUrl: target,
    markdown: `[![Try ${appName} live](${badge})](${target})`,
    html: `<a href="${target}"><img src="${badge}" alt="Try ${appName} live"></a>`,
    restructuredText: `.. image:: ${badge}\n   :target: ${target}\n   :alt: Try ${appName} live`,
  };
}
