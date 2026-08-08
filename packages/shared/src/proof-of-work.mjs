/**
 * Proof-of-work challenge for anonymous trial claims.
 *
 * WHY THIS EXISTS
 * OpenTry hands real, internet-connected infrastructure to people with no
 * account. The only other limit is a salted hash of IP + user-agent, which
 * anyone defeats with a fresh browser or a proxy. Something has to make
 * *volume* expensive without making a single honest visit annoying.
 *
 * A CAPTCHA would mean a third-party script, a privacy story, and a signup.
 * Hashcash needs none of that: the browser burns a second or two of CPU, which
 * a real visitor never notices and a script farming hundreds of trials pays
 * over and over.
 *
 * WHAT THIS IS NOT
 * It is not a defence against a determined attacker with real compute. It
 * raises the floor; it does not close the door. The hard limits that actually
 * bound the damage are the global concurrency ceiling and the 30-minute TTL.
 *
 * Design notes:
 *  - Challenges are HMAC-signed and stateless, so the API stays horizontally
 *    scalable — no shared store of issued challenges.
 *  - Single-use is enforced by a small in-memory set of spent tokens; a replay
 *    that survives a restart still has to satisfy the expiry window.
 *  - Difficulty is per-app: an app that can make outbound requests costs more.
 */

import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const SECRET =
  process.env.OPENTRY_POW_SECRET ?? process.env.OPENTRY_VISITOR_SALT ?? randomBytes(32).toString('hex');

/** How long a challenge stays valid. Long enough to solve, short enough to bound replay. */
const TTL_MS = 5 * 60 * 1000;

/** Leading zero BITS required. ~2^n hashes. 18 ≈ under a second in a browser. */
export const DIFFICULTY = Object.freeze({
  standard: 18,
  elevated: 21, // apps that can reach the network or run code
});

const spent = new Set();
setInterval(() => spent.clear(), TTL_MS).unref?.();

const sign = (payload) => createHmac('sha256', SECRET).update(payload).digest('hex').slice(0, 32);

/**
 * Issue a challenge. Stateless: everything needed to verify it is in the token.
 * @param {string} appSlug
 * @param {number} bits
 */
export function issueChallenge(appSlug, bits = DIFFICULTY.standard) {
  const nonce = randomBytes(12).toString('hex');
  const expiresAt = Date.now() + TTL_MS;
  const payload = `${appSlug}.${bits}.${nonce}.${expiresAt}`;
  return {
    challenge: `${payload}.${sign(payload)}`,
    bits,
    expiresAt,
    // Told to the client so it can show a sensible progress hint.
    estimatedHashes: 2 ** bits,
  };
}

/** Count leading zero bits of a hex digest. */
function leadingZeroBits(hex) {
  let bits = 0;
  for (const ch of hex) {
    const v = parseInt(ch, 16);
    if (v === 0) {
      bits += 4;
      continue;
    }
    if (v < 2) bits += 3;
    else if (v < 4) bits += 2;
    else if (v < 8) bits += 1;
    break;
  }
  return bits;
}

/**
 * Verify a solved challenge.
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function verifySolution({ challenge, solution, appSlug }) {
  if (typeof challenge !== 'string' || typeof solution !== 'string') {
    return { ok: false, reason: 'missing challenge or solution' };
  }

  const parts = challenge.split('.');
  if (parts.length !== 5) return { ok: false, reason: 'malformed challenge' };
  const [slug, bitsRaw, nonce, expiresRaw, mac] = parts;

  const expected = sign(`${slug}.${bitsRaw}.${nonce}.${expiresRaw}`);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'bad signature' };
  }

  if (slug !== appSlug) return { ok: false, reason: 'challenge issued for a different app' };
  if (Date.now() > Number(expiresRaw)) return { ok: false, reason: 'challenge expired' };
  if (spent.has(challenge)) return { ok: false, reason: 'challenge already used' };

  const bits = Number(bitsRaw);
  const digest = createHash('sha256').update(`${challenge}:${solution}`).digest('hex');
  if (leadingZeroBits(digest) < bits) return { ok: false, reason: 'insufficient work' };

  spent.add(challenge);
  return { ok: true };
}

/** Reference solver — mirrors the browser implementation, used by tests. */
export function solve(challenge, bits) {
  for (let n = 0; ; n++) {
    const d = createHash('sha256').update(`${challenge}:${n}`).digest('hex');
    if (leadingZeroBits(d) >= bits) return String(n);
  }
}
