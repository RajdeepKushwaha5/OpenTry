#!/usr/bin/env node
/**
 * deploy.mjs — stand up the OpenTry control plane with one command.
 *
 *   npm run deploy
 *
 * Uses the same Zerops REST client the product uses, so there is nothing extra
 * to install — no zcli, no Docker, no CI. It reads your token from .env.local
 * (gitignored), injects it into the import manifest in memory, creates the
 * project, and waits until the API is serving.
 *
 * The token is NEVER written to disk in expanded form: `zerops-import.yaml`
 * keeps its placeholder, and substitution happens only in memory.
 *
 * Flags:
 *   --name <n>   project name (default: opentry)
 *   --dry-run    print the manifest that would be sent, minus the token
 */

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZeropsClient, pollUntil } from '../packages/provisioner/src/zerops-client.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const NAME = args[args.indexOf('--name') + 1] ?? 'opentry';

const TOKEN_PLACEHOLDER = 'REPLACE_WITH_YOUR_ZEROPS_TOKEN';
const REPO_PLACEHOLDER = 'REPLACE_ME';

const t0 = Date.now();
const el = () => ((Date.now() - t0) / 1000).toFixed(0).padStart(4);
const log = (m) => console.log(`[${el()}s] ${m}`);

function die(msg, hint) {
  console.error(`\nDeploy aborted: ${msg}`);
  if (hint) console.error(`\n${hint}`);
  process.exit(1);
}

const token = process.env.ZEROPS_TOKEN;
if (!token || token === 'PASTE_YOUR_TOKEN_HERE') {
  die(
    'ZEROPS_TOKEN is not set.',
    'Copy .env.local.example to .env.local and paste a personal access token\n' +
      'from app.zerops.io -> avatar menu -> Access Token Management.',
  );
}

let manifest = await readFile(join(ROOT, 'zerops-import.yaml'), 'utf8');

if (manifest.includes(REPO_PLACEHOLDER)) {
  die(
    'zerops-import.yaml still points at a placeholder repository.',
    `Replace "${REPO_PLACEHOLDER}" with your GitHub org/repo. Zerops builds the\n` +
      'control plane straight from git, so the repo must be reachable.',
  );
}
if (!manifest.includes(TOKEN_PLACEHOLDER)) {
  die(
    'Could not find the token placeholder in zerops-import.yaml.',
    `Expected the literal string "${TOKEN_PLACEHOLDER}" on the controller service.\n` +
      'If you hardcoded a real token there, remove it — it must never be committed.',
  );
}

// Substitute in memory only.
manifest = manifest.replace(TOKEN_PLACEHOLDER, token).replace(/^project:\n  name: .*$/m, `project:\n  name: ${NAME}`);

if (DRY) {
  console.log(manifest.replace(token, '<redacted>'));
  process.exit(0);
}

const client = new ZeropsClient({ token });

let clientId;
try {
  clientId = await client.getClientId();
  log(`authenticated (clientId=${clientId})`);
} catch (err) {
  die(`could not authenticate: ${err.message}`, 'Is the token valid and not expired?');
}

// Refuse to create a second control plane by accident.
const existing = (await client.listProjects()).find((p) => p.name === NAME);
if (existing) {
  die(
    `a project named "${NAME}" already exists (${existing.id}).`,
    'Delete it in the Zerops GUI first, or deploy under another name:\n' +
      '  npm run deploy -- --name opentry-staging',
  );
}

log(`importing control plane "${NAME}"...`);
let projectId;
try {
  const res = await client.importProject(manifest);
  projectId = res?.projectId ?? res?.project?.id ?? res?.id;
  if (!projectId) throw new Error('import accepted but returned no project id');
} catch (err) {
  die(`import failed: ${err.message}`);
}
log(`project created: ${projectId}`);

const READY = new Set(['ACTIVE', 'SERVICE_ACTIVE']);
const wanted = ['db', 'controller', 'api'];

log('waiting for services (the git build takes a few minutes)...');
const services = await pollUntil(
  async () => {
    const list = (await client.listServices(projectId)).filter((s) => wanted.includes(s.name));
    const ready = list.filter((s) => READY.has(String(s.status).toUpperCase()));
    return list.length === wanted.length && ready.length === wanted.length ? list : null;
  },
  {
    timeoutMs: 15 * 60_000,
    intervalMs: 6_000,
    onTick: async () => {
      const list = await client.listServices(projectId).catch(() => []);
      log('  ' + list.map((s) => `${s.name}=${s.status}`).join(' '));
    },
  },
).catch((err) => die(`services did not come up: ${err.message}`));

log('all services active');

// The API needs a public subdomain. Enabling it can 400 briefly while the HTTP
// port registers, so retry — same race the trial provisioner handles.
const apiSvc = services.find((s) => s.name === 'api');
await pollUntil(
  async () => {
    const svc = (await client.listServices(projectId)).find((s) => s.name === 'api');
    if (svc?.subdomainAccess) return true;
    try {
      await client.enableSubdomain(apiSvc.id);
      return true;
    } catch (err) {
      if (err.body?.error?.code === 'serviceStackIsNotHttp') return null;
      throw err;
    }
  },
  { timeoutMs: 120_000, intervalMs: 5_000 },
).catch(() => die('could not enable public access on the api service'));

const project = await client.getProject(projectId);
const url = client.subdomainUrl({
  serviceName: 'api',
  subdomainHost: project.zeropsSubdomainHost,
  port: 3000,
});

log('waiting for the API to answer...');
await pollUntil(
  async () => {
    try {
      const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(8000) });
      return r.ok ? true : null;
    } catch {
      return null;
    }
  },
  { timeoutMs: 180_000, intervalMs: 5_000 },
).catch(() => die(`api never answered at ${url}/health`));

console.log(`
${'='.repeat(64)}
OpenTry is live
${'='.repeat(64)}

  ${url}

  project id   ${projectId}
  services     ${services.map((s) => s.name).join(', ')}

The controller is already warming the first trial. That takes several minutes,
so the pool panel will read "provisioning" for a while — this is expected and
is exactly the cost the product exists to hide.

Watch it:      ${url}/api/pool
Tear it down:  Zerops GUI -> project "${NAME}" -> delete
`);
