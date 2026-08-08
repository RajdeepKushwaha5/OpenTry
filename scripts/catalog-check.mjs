#!/usr/bin/env node
/**
 * catalog-check.mjs — validate every catalog manifest and show exactly what
 * Zerops Import YAML it renders to.
 *
 * Run this before touching the API. If a manifest is wrong, the failure should
 * surface here in milliseconds rather than half-way through provisioning a
 * real project.
 *
 *   node scripts/catalog-check.mjs
 *   node scripts/catalog-check.mjs --show n8n     # print the rendered YAML
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseManifest, renderImportYaml, generateTrialId } from '../packages/shared/src/manifest.mjs';
import { LIMITS } from '../packages/shared/src/limits.mjs';
import { validateImportYaml } from '../packages/shared/src/validate-import.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG = join(ROOT, 'catalog');

const showArg = process.argv.indexOf('--show');
const showSlug = showArg !== -1 ? process.argv[showArg + 1] : null;

const entries = await readdir(CATALOG, { withFileTypes: true });
const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);

if (!dirs.length) {
  console.error('No catalog entries found in catalog/');
  process.exit(1);
}

let failures = 0;

for (const dir of dirs) {
  const path = join(CATALOG, dir, 'opentry.yaml');
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    console.error(`  FAIL  ${dir}: no opentry.yaml`);
    failures++;
    continue;
  }

  try {
    const manifest = parseManifest(text, { source: `${dir}/opentry.yaml` });
    const trialId = generateTrialId();
    const { yaml, projectName, secrets } = renderImportYaml(manifest, { trialId });

    const svcSummary = manifest.services
      .map((s) => `${s.hostname}(${s.type})`)
      .join(' ');

    console.log(`  ok    ${manifest.app.slug.padEnd(12)} ${svcSummary}`);
    console.log(
      `        ttl=${manifest.trial.ttlMinutes}m  entry=${manifest.trial.entry.service}:${manifest.trial.entry.port}  ` +
        `checks=${manifest.verify.length}  generated-secrets=${Object.keys(secrets).length}`,
    );

    // Prove the clamps actually bite.
    for (const s of manifest.services) {
      const va = s.verticalAutoscaling ?? {};
      if (va.maxCpu > LIMITS.maxCpuPerService || va.maxRam > LIMITS.maxRamGbPerService) {
        console.error(`  FAIL  ${dir}: clamping did not apply to ${s.hostname}`);
        failures++;
      }
    }

    // Validate the rendered YAML against Zerops' own published JSON Schema.
    const { valid, errors, warnings } = await validateImportYaml(yaml);
    for (const w of warnings) console.log(`        warn  ${w}`);
    if (!valid) {
      for (const e of errors) console.error(`  FAIL  ${dir}: ${e}`);
      failures++;
    }

    if (showSlug === manifest.app.slug) {
      console.log(`\n${'-'.repeat(70)}\nRendered Zerops Import YAML for ${projectName}:\n${'-'.repeat(70)}`);
      console.log(yaml);
      console.log(`${'-'.repeat(70)}\nGenerated credentials (shown to the visitor):`);
      for (const [k, v] of Object.entries(secrets)) console.log(`  ${k} = ${v}`);
      console.log();
    }
  } catch (err) {
    console.error(`  FAIL  ${dir}: ${err.message}`);
    failures++;
  }
}

console.log(`\n${dirs.length - failures}/${dirs.length} manifest(s) valid.`);
if (!showSlug) console.log('Tip: node scripts/catalog-check.mjs --show <slug>  to see the rendered YAML.');
process.exit(failures ? 1 : 0);
