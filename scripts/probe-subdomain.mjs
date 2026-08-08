#!/usr/bin/env node
/**
 * probe-subdomain.mjs — one-off reconnaissance.
 *
 * The Zerops subdomain URL is NOT on the service object. `OutDtoServiceStack`
 * only carries `subdomainAccess: boolean`; the host lives on the project as
 * `zeropsSubdomainHost`, and real URLs look like:
 *     https://appstage-24c6-3000.prg1.zerops.app
 * i.e. {serviceName}-{something}-{port}.{region}.zerops.app
 *
 * Rather than reverse-engineer that from examples, this provisions the tiny
 * `hello` stack once, dumps the exact project and service payloads, and LEAVES
 * IT RUNNING so we can confirm the composed URL actually serves.
 *
 *   node --env-file-if-exists=.env.local scripts/probe-subdomain.mjs
 *   npm run gonogo:cleanup      # when finished
 */

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseManifest, renderImportYaml, generateTrialId } from '../packages/shared/src/manifest.mjs';
import { ZeropsClient, pollUntil } from '../packages/provisioner/src/zerops-client.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const client = new ZeropsClient({ token: process.env.ZEROPS_TOKEN });

const manifest = parseManifest(await readFile(join(ROOT, 'catalog/hello/opentry.yaml'), 'utf8'));
const { yaml } = renderImportYaml(manifest, { trialId: generateTrialId() });

console.log('Importing probe project...');
const res = await client.importProject(yaml);
const projectId = res?.projectId ?? res?.project?.id ?? res?.id;
console.log('projectId =', projectId);

const expected = new Set(manifest.services.map((s) => s.hostname));
const READY = new Set(['ACTIVE', 'SERVICE_ACTIVE']);

console.log('Waiting for services (this takes ~3-4 min for a git build)...');
const services = await pollUntil(
  async () => {
    const list = (await client.listServices(projectId)).filter((s) => expected.has(s.name));
    const ready = list.filter((s) => READY.has(String(s.status).toUpperCase()));
    return list.length && ready.length === list.length ? list : null;
  },
  {
    timeoutMs: 600_000,
    intervalMs: 5_000,
    onTick: async (ms) => {
      const l = await client.listServices(projectId).catch(() => []);
      process.stdout.write(`\r  ${Math.round(ms / 1000)}s  ${l.map((s) => s.name + '=' + s.status).join(' ')}`.padEnd(100));
    },
  },
);

console.log('\n\n===== PROJECT =====');
const project = await client.getProject(projectId);
for (const k of ['id', 'name', 'zeropsSubdomainHost', 'status', 'tags', 'tagList']) {
  if (k in project) console.log(`  ${k}:`, JSON.stringify(project[k]));
}

console.log('\n===== SERVICES =====');
for (const s of services) {
  console.log(`\n  --- ${s.name} (${s.status}) ---`);
  for (const k of ['id', 'subdomainAccess', 'customPortsEnabled', 'ports', 'requestedPorts']) {
    if (k in s) console.log(`    ${k}:`, JSON.stringify(s[k]));
  }
}

console.log('\n===== PUBLIC HTTP ROUTING =====');
const routing = await client
  .request('GET', `/project/${projectId}/public-http-routing`)
  .catch((e) => ({ error: e.message }));
console.log(JSON.stringify(routing, null, 2).slice(0, 1500));

// Try to compose and hit candidate URLs so we learn the right formula.
const entry = services.find((s) => s.name === manifest.trial.entry.service);
const port = manifest.trial.entry.port;
const host = project.zeropsSubdomainHost;
const candidates = [
  host && `https://${entry.name}-${host}`,
  host && `https://${entry.name}-${port}.${host}`,
  host && `https://${entry.name}-${host}`.replace(/\.(\w+)\.zerops\.app$/, `-${port}.$1.zerops.app`),
].filter(Boolean);

console.log('\n===== URL CANDIDATES =====');
for (const url of candidates) {
  const code = await fetch(url, { signal: AbortSignal.timeout(8000) })
    .then((r) => r.status)
    .catch((e) => e.message);
  console.log(`  ${url}  ->  ${code}`);
}

console.log(`\nProject left running. Clean up with:  npm run gonogo:cleanup`);
