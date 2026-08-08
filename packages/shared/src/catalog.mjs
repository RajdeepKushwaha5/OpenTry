/**
 * Catalog loader — reads every `catalog/<slug>/opentry.yaml`, parses and
 * validates it, and returns a Map keyed by slug.
 *
 * Loaded once at boot. A malformed manifest is logged and SKIPPED rather than
 * crashing the process: one broken catalog entry must never take the whole
 * service down, because entries come from third-party maintainers.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseManifest } from './manifest.mjs';

export async function loadCatalog(catalogDir, { log = console.warn } = {}) {
  const catalog = new Map();

  let entries;
  try {
    entries = await readdir(catalogDir, { withFileTypes: true });
  } catch (err) {
    throw new Error(`Catalog directory not readable at ${catalogDir}: ${err.message}`);
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(catalogDir, entry.name, 'opentry.yaml');
    try {
      const manifest = parseManifest(await readFile(path, 'utf8'), { source: entry.name });
      // `hidden` entries (timing probes) are loaded but never offered publicly.
      manifest.app.hidden = manifest.app.hidden ?? false;
      catalog.set(manifest.app.slug, manifest);
    } catch (err) {
      log(`[catalog] skipping "${entry.name}": ${err.message}`);
    }
  }

  if (catalog.size === 0) throw new Error('Catalog is empty — refusing to start');
  return catalog;
}

/** Public view of the catalog, safe to serialise to a browser. */
export function publicCatalog(catalog) {
  return [...catalog.values()]
    .filter((m) => !m.app.hidden)
    .map((m) => ({
      ...m.app,
      ttlMinutes: m.trial.ttlMinutes,
      services: m.services.map((s) => ({ hostname: s.hostname, type: s.type })),
      checks: m.verify.map((v) => v.name),
    }));
}
