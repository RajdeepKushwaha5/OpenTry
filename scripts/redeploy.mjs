#!/usr/bin/env node
/**
 * redeploy.mjs — rebuild an already-deployed control plane from the latest commit.
 *
 *   npm run redeploy
 *
 * `npm run deploy` provisions a NEW project and refuses to touch an existing
 * one, which is the right default for something that creates infrastructure.
 * But it leaves no way to ship a fix to a control plane that is already
 * running, and the fallback — delete the project and deploy again — throws
 * away the database, every live trial, and the public URL the README points at.
 *
 * Zerops builds from GitHub, not from your working copy, so this triggers the
 * build pipeline on the deployed `api` and `controller` service stacks and
 * waits for them to come back. Same git-clean guard as deploy.mjs: a pipeline
 * triggered against unpushed work rebuilds the OLD commit and reports success,
 * which is a genuinely confusing way to lose an afternoon.
 *
 *   --name <project>   project to rebuild (default: opentry)
 *   --service <host>   rebuild only this service (repeatable)
 */

import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZeropsClient, pollUntil } from '../packages/provisioner/src/zerops-client.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const started = Date.now();
const log = (m) => console.log(`[${String(((Date.now() - started) / 1000).toFixed(0)).padStart(4)}s] ${m}`);
const die = (m) => {
  console.error(`\n${m}\n`);
  process.exit(1);
};

const argv = process.argv.slice(2);
const arg = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i === -1 ? fallback : argv[i + 1];
};
const all = (flag) => argv.reduce((acc, a, i) => (a === flag ? [...acc, argv[i + 1]] : acc), []);

const projectName = arg('--name', 'opentry');
const only = all('--service');

const token = process.env.OPENTRY_ZEROPS_TOKEN ?? process.env.ZEROPS_TOKEN;
if (!token || token === 'PASTE_YOUR_TOKEN_HERE') {
  die('No Zerops token. Put one in .env.local as OPENTRY_ZEROPS_TOKEN=...');
}

/**
 * Refuse to rebuild work that GitHub has not seen.
 *
 * The build pulls from the remote. Triggering a pipeline with local commits
 * unpushed rebuilds whatever the remote last had and reports a clean success,
 * so the fix appears deployed and is not.
 */
function assertPushed() {
  const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim();
  const dirty = git('status', '--porcelain');
  if (dirty) {
    die(
      'Working tree has uncommitted changes. Zerops builds from GitHub, so\n' +
        'these would NOT be deployed:\n\n' +
        dirty
          .split('\n')
          .map((l) => `  ${l}`)
          .join('\n'),
    );
  }
  const head = git('rev-parse', 'HEAD');
  let remote;
  try {
    remote = git('rev-parse', '@{u}');
  } catch {
    die('No upstream branch. Push first: git push -u origin HEAD');
  }
  if (head !== remote) {
    die(`HEAD (${head.slice(0, 8)}) does not match upstream (${remote.slice(0, 8)}). Push first.`);
  }
  log(`git clean, HEAD ${head.slice(0, 8)} matches origin`);
}

assertPushed();

const client = new ZeropsClient({ token });
await client.getClientId();
log('authenticated');

const projects = await client.listProjects();
const project = projects.find((p) => p.name === projectName);
if (!project) {
  die(`No project named "${projectName}". Existing: ${projects.map((p) => p.name).join(', ') || '(none)'}`);
}
log(`project ${projectName} (${project.id})`);

const services = await client.listServices(project.id);
// Only the two Node services are built from git; the database has no pipeline.
const buildable = services.filter(
  (s) => ['api', 'controller'].includes(s.name) && (!only.length || only.includes(s.name)),
);
if (!buildable.length) {
  die(`Nothing to rebuild. Services present: ${services.map((s) => s.name).join(', ')}`);
}

for (const svc of buildable) {
  await client.request('PUT', `/service-stack/${svc.id}/trigger-pipeline`, {});
  log(`pipeline triggered: ${svc.name}`);
}

log('building (this takes a few minutes)...');
await pollUntil(
  async () => {
    const now = await client.listServices(project.id);
    const watched = now.filter((s) => buildable.some((b) => b.id === s.id));
    const states = watched.map((s) => `${s.name}=${s.status}`).join(' ');
    log(`  ${states}`);
    return watched.every((s) => s.status === 'ACTIVE') ? watched : null;
  },
  { timeoutMs: 12 * 60 * 1000, intervalMs: 15_000 },
);

log('rebuilt.');
const api = services.find((s) => s.name === 'api');
if (api && project.zeropsSubdomainHost) {
  console.log(
    `\n  ${client.subdomainUrl({ serviceName: 'api', subdomainHost: project.zeropsSubdomainHost, port: 3000 })}\n`,
  );
}
