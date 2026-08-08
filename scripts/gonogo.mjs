#!/usr/bin/env node
/**
 * gonogo.mjs — the decision test for OpenTry.
 *
 * Deliberately runs the REAL product code path (parseManifest ->
 * renderImportYaml -> provisionTrial -> destroyTrial) against a real Zerops
 * account, rather than a synthetic probe. If this passes, the core of OpenTry
 * demonstrably works and only the UI remains. If it fails, we learn it now
 * instead of after building a frontend.
 *
 *   npm run gonogo                 # provision + verify + destroy (n8n)
 *   npm run gonogo -- --app hello  # minimal stack, fastest baseline
 *   npm run gonogo:keep            # leave it running so you can click around
 *   npm run gonogo:cleanup         # delete any strays
 *
 * Exit 0 = GO.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseManifest, generateTrialId } from '../packages/shared/src/manifest.mjs';
import { LEASE_TAG } from '../packages/shared/src/limits.mjs';
import { ZeropsClient } from '../packages/provisioner/src/zerops-client.mjs';
import { provisionTrial, destroyTrial } from '../packages/provisioner/src/lifecycle.mjs';
import { estimateCostUsd, monthlyEquivalentUsd, formatCost } from '../packages/provisioner/src/cost.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const KEEP = args.includes('--keep');
const CLEANUP_ONLY = args.includes('--cleanup');
const APP = args.find((a, i) => args[i - 1] === '--app') ?? 'n8n';

const t0 = Date.now();
const secs = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6);

const ICON = { running: '  ', ok: 'ok', error: 'XX' };

function onEvent(e) {
  const icon = ICON[e.status] ?? '  ';
  // Overwrite "running" lines in place so the log reads like the real UI will.
  const line = `[${secs()}s] ${icon}  ${e.message}`;
  if (e.status === 'running') process.stdout.write(`\r${line.padEnd(78)}`);
  else console.log(`\r${line.padEnd(78)}`);
}

function bail(step, err) {
  console.error(`\n\n${'='.repeat(66)}`);
  console.error(`NO-GO — failed at: ${step}`);
  console.error('='.repeat(66));
  console.error(err?.message ?? String(err));
  if (err?.body) console.error('\nAPI response:\n' + JSON.stringify(err.body, null, 2).slice(0, 1500));
  console.error(`
What this means:
  - HTTP 401/403      -> token is wrong, expired, or lacks project-create rights
  - HTTP 402/quota    -> out of credit, or the account caps concurrent projects
  - import rejected   -> the manifest is invalid; run: npm run catalog:check
  - services stuck    -> the app image is slow or broken; try: --app hello
  - URL never serves  -> app booted but isn't listening on the declared port

Strays? Run:  npm run gonogo:cleanup
`);
  process.exit(1);
}

async function loadManifest(slug) {
  const path = join(ROOT, 'catalog', slug, 'opentry.yaml');
  try {
    return parseManifest(await readFile(path, 'utf8'), { source: `${slug}/opentry.yaml` });
  } catch (err) {
    if (err.code === 'ENOENT') {
      const dirs = (await readdir(join(ROOT, 'catalog'), { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
      throw new Error(`No catalog entry "${slug}". Available: ${dirs.join(', ')}`);
    }
    throw err;
  }
}

async function cleanup(client) {
  const projects = await client.listProjects();
  const strays = projects.filter((p) => (p.tags ?? p.tagList ?? []).includes(LEASE_TAG));
  if (!strays.length) return console.log('No OpenTry projects to clean up.');
  for (const p of strays) {
    process.stdout.write(`Deleting ${p.name} (${p.id})... `);
    await client.deleteProject(p.id, LEASE_TAG);
    console.log('done');
  }
  console.log(`\nRemoved ${strays.length} project(s).`);
}

async function main() {
  const token = process.env.ZEROPS_TOKEN;
  if (!token || token === 'PASTE_YOUR_TOKEN_HERE') {
    console.error(`
ZEROPS_TOKEN is not set.

Open .env.local in this folder and replace PASTE_YOUR_TOKEN_HERE with a real
token from app.zerops.io -> avatar menu -> Access Token Management.
`);
    process.exit(2);
  }

  const client = new ZeropsClient({ token });

  let clientId;
  try {
    clientId = await client.getClientId();
    console.log(`[${secs()}s] ok  Authenticated (clientId=${clientId})`);
  } catch (err) {
    bail('authenticate', err);
  }

  if (CLEANUP_ONLY) {
    await cleanup(client).catch((e) => bail('cleanup', e));
    return;
  }

  let manifest;
  try {
    manifest = await loadManifest(APP);
    console.log(
      `[${secs()}s] ok  Manifest "${manifest.app.slug}" — ` +
        `${manifest.services.length} services, ${manifest.verify.length} behaviour checks`,
    );
  } catch (err) {
    bail('load manifest', err);
  }

  const trialId = generateTrialId();
  let result;
  try {
    result = await provisionTrial({ client, manifest, trialId, emit: onEvent });
  } catch (err) {
    // provisionTrial already destroys partial projects on the way out.
    bail('provision', err);
  }

  const readyAt = (Date.now() - t0) / 1000;

  console.log(`\n${'='.repeat(66)}`);
  console.log(`TRIAL READY  ${result.url}`);
  console.log('='.repeat(66));
  for (const c of result.credentials) console.log(`  ${c.label.padEnd(10)} ${c.value}`);

  // Prove the safety guard actually refuses. This is the single most dangerous
  // call in the codebase, so we assert on it every run.
  process.stdout.write('\nVerifying the delete guard refuses a wrong tag... ');
  let refused = false;
  try {
    await client.deleteProject(result.projectId, 'NOT_THE_REAL_TAG');
  } catch (e) {
    refused = /REFUSING TO DELETE/.test(e.message);
  }
  if (!refused) bail('safety guard', new Error('deleteProject accepted a mismatched tag!'));
  console.log('refused correctly.');

  if (KEEP) {
    console.log(`\n--keep set. Project ${result.projectId} left running.`);
    console.log('Click around, then remove it with:  npm run gonogo:cleanup');
  } else {
    process.stdout.write('Destroying trial... ');
    const receipt = await destroyTrial({
      client,
      lease: { projectId: result.projectId, createdAt: t0, services: manifest.services },
    }).catch((e) => bail('destroy', e));
    console.log(`done in ${(receipt.lifetimeMs / 1000).toFixed(1)}s of lifetime.`);
  }

  // ---- the numbers that shape the product -------------------------------
  const T = result.timings;
  const row = (l, v) => `  ${l.padEnd(30)} ${v == null ? '—' : (v / 1000).toFixed(1) + 's'}`;
  console.log(`\n${'='.repeat(66)}\nGO — disposable infrastructure works\n${'='.repeat(66)}`);
  console.log(row('project created', T.importMs));
  console.log(row('all services ready', T.servicesMs));
  console.log(row('public URL assigned', T.urlMs));
  console.log(row('behaviour checks passed', T.verifiedMs));
  console.log(`  ${'TOTAL time to usable trial'.padEnd(30)} ${readyAt.toFixed(1)}s`);

  console.log('\nCost (estimated, from published list prices):');
  console.log(`  this run                       ${formatCost(estimateCostUsd(manifest.services, Date.now() - t0))}`);
  console.log(`  a full ${String(manifest.trial.ttlMinutes).padStart(2)}-minute trial        ${formatCost(estimateCostUsd(manifest.services, manifest.trial.ttlMinutes * 60_000))}`);
  console.log(`  same stack left up 30 days     $${monthlyEquivalentUsd(manifest.services)}`);

  console.log('\nVerdict:');
  if (readyAt <= 120) {
    console.log('  Under 2 minutes. Provision live in the demo, streaming the timeline.');
    console.log('  No warm pool needed for the hackathon build.');
  } else if (readyAt <= 240) {
    console.log('  2-4 minutes. Live provisioning is usable but the wait needs real');
    console.log('  progress UI. Keep ONE pre-warmed trial as the demo fast path.');
  } else {
    console.log('  Over 4 minutes. Too slow to provision live on camera.');
    console.log('  Build the warm pool, and make the demo hand out a ready trial.');
  }
  console.log();
}

main().catch((e) => bail('unexpected', e));
