#!/usr/bin/env node
/**
 * discover-api.mjs
 *
 * Pulls the live Zerops OpenAPI spec and prints the endpoints FireDrill's
 * controller actually needs: project lifecycle, import, service-stack reads,
 * processes and subdomains.
 *
 * We do this rather than trusting documentation prose, because the controller
 * performs DESTRUCTIVE operations (project delete) and every path + method must
 * be exact. Run this once and paste the output into docs/api-surface.md.
 *
 *   node scripts/discover-api.mjs
 *   node scripts/discover-api.mjs --grep project        # filter
 *   node scripts/discover-api.mjs --json                # raw matched paths
 *
 * No auth needed: the swagger document itself is public.
 */

import YAML from 'yaml';

// Verified 2026-08: the Swagger UI initializer loads `openapi.yml` relative to
// the swagger path. It is OpenAPI 3.0 YAML (~830 KB), not JSON.
const SWAGGER_URL =
  process.env.ZEROPS_SWAGGER_URL ??
  'https://api.app-prg1.zerops.io/api/rest/public/swagger/openapi.yml';

const CANDIDATES = [
  SWAGGER_URL,
  'https://api.app-prg1.zerops.io/api/rest/public/swagger/openapi.json',
  'https://api.app-prg1.zerops.io/api/rest/public/swagger/doc.json',
];

/** Endpoint groups the FireDrill controller depends on. */
const INTERESTING = [
  { label: 'PROJECT LIFECYCLE', re: /\/project(\/|$)/i },
  { label: 'PROJECT IMPORT / EXPORT', re: /import|export/i },
  { label: 'SERVICE STACK', re: /service-stack/i },
  { label: 'ASYNC PROCESSES', re: /\/process/i },
  { label: 'PUBLIC ROUTING / SUBDOMAIN', re: /routing|subdomain/i },
  { label: 'APP VERSION / DEPLOY', re: /app-version|deploy/i },
];

async function fetchSpec() {
  const errors = [];
  for (const url of CANDIDATES) {
    try {
      const res = await fetch(url, { headers: { accept: 'application/yaml, application/json' } });
      if (!res.ok) {
        errors.push(`${url} -> HTTP ${res.status}`);
        continue;
      }
      const body = await res.text();
      const spec = url.endsWith('.json') ? JSON.parse(body) : YAML.parse(body);
      if (spec?.paths) {
        console.log(`# spec: ${url}  (${(body.length / 1024).toFixed(0)} KB)\n`);
        return spec;
      }
      errors.push(`${url} -> parsed but no .paths`);
    } catch (err) {
      errors.push(`${url} -> ${err.message}`);
    }
  }
  console.error('Could not fetch the OpenAPI spec. Tried:');
  for (const e of errors) console.error('  ' + e);
  console.error(
    '\nOpen https://api.app-prg1.zerops.io/api/rest/public/swagger in a browser,\n' +
      'find the spec URL in the network tab, and re-run with:\n' +
      '  ZEROPS_SWAGGER_URL=<url> node scripts/discover-api.mjs',
  );
  process.exit(1);
}

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

function collect(spec) {
  const rows = [];
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const [method, op] of Object.entries(item ?? {})) {
      if (!HTTP_METHODS.has(method.toLowerCase())) continue;
      rows.push({
        method: method.toUpperCase(),
        path,
        summary: op?.summary ?? op?.operationId ?? '',
        operationId: op?.operationId ?? '',
      });
    }
  }
  return rows.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

function main(spec) {
  const args = process.argv.slice(2);
  const grepIdx = args.indexOf('--grep');
  const grep = grepIdx !== -1 ? new RegExp(args[grepIdx + 1], 'i') : null;
  const asJson = args.includes('--json');

  const all = collect(spec);

  if (grep) {
    const hits = all.filter((r) => grep.test(r.path) || grep.test(r.operationId));
    if (asJson) return console.log(JSON.stringify(hits, null, 2));
    for (const r of hits) console.log(fmt(r));
    console.log(`\n${hits.length} match(es) of ${all.length} endpoints.`);
    return;
  }

  for (const group of INTERESTING) {
    const hits = all.filter((r) => group.re.test(r.path));
    if (!hits.length) continue;
    console.log(`\n## ${group.label}`);
    console.log('-'.repeat(group.label.length + 3));
    for (const r of hits) console.log(fmt(r));
  }

  console.log(`\n\n${all.length} endpoints total in the public API.`);
  console.log('Filter with:  node scripts/discover-api.mjs --grep <regex>');

  // The three the controller cannot work without. Flag loudly if absent.
  const required = [
    { name: 'create project', re: /^POST \/project$/ },
    { name: 'delete project', re: /^DELETE \/project\/\{[^}]+\}$/ },
    { name: 'project import', re: /import/i },
  ];
  console.log('\n## CONTROLLER PREREQUISITES');
  for (const req of required) {
    const found = all.find((r) => req.re.test(`${r.method} ${r.path}`));
    console.log(
      found ? `  ok      ${req.name}: ${found.method} ${found.path}` : `  MISSING ${req.name}`,
    );
  }
  console.log(
    '\nIf "project import" is missing from the REST surface, the controller must\n' +
      'shell out to `zcli project project-import` instead. zcli ships preinstalled\n' +
      'in every Zerops runtime container, so that path is fully supported.',
  );
}

function fmt(r) {
  const left = `  ${r.method.padEnd(6)} ${r.path}`;
  return r.summary ? `${left.padEnd(72)} ${r.summary}` : left;
}

main(await fetchSpec());
