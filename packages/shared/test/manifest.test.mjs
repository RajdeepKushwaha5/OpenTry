/**
 * Manifest safety tests.
 *
 * A catalog entry is UNTRUSTED input written by a third-party maintainer. The
 * clamping logic is the only thing standing between a careless or malicious
 * manifest and a drained account, so it is the part most worth testing —
 * these are security properties, not formatting preferences.
 *
 *   node --test packages/shared/test/
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseManifest, renderImportYaml, generateTrialId } from '../src/manifest.mjs';
import { LIMITS, LEASE_TAG } from '../src/limits.mjs';

const base = (extra = '') => `
version: 1
app:
  slug: testapp
  name: Test App
trial:
  ttlMinutes: 30
  entry: { service: app, port: 3000 }
infra:
  services:
    - hostname: app
      type: nodejs@22
${extra}
`;

describe('resource clamping', () => {
  test('clamps CPU, RAM and disk DOWN to the platform ceiling', () => {
    const m = parseManifest(
      base(`      verticalAutoscaling:
        minCpu: 8
        maxCpu: 64
        minRam: 32
        maxRam: 128
        minDisk: 200
        maxDisk: 500`),
    );
    const va = m.services[0].verticalAutoscaling;
    assert.equal(va.maxCpu, LIMITS.maxCpuPerService, 'maxCpu must be clamped');
    assert.equal(va.maxRam, LIMITS.maxRamGbPerService, 'maxRam must be clamped');
    assert.equal(va.maxDisk, LIMITS.maxDiskGbPerService, 'maxDisk must be clamped');
  });

  test('pulls min below the clamped max — Zerops rejects min > max', () => {
    const m = parseManifest(
      base(`      verticalAutoscaling:
        minCpu: 64
        maxCpu: 64
        minRam: 99
        maxRam: 99`),
    );
    const va = m.services[0].verticalAutoscaling;
    assert.ok(va.minCpu <= va.maxCpu, `minCpu ${va.minCpu} > maxCpu ${va.maxCpu}`);
    assert.ok(va.minRam <= va.maxRam, `minRam ${va.minRam} > maxRam ${va.maxRam}`);
  });

  test('never widens a request that is already under the ceiling', () => {
    const m = parseManifest(
      base(`      verticalAutoscaling:
        minCpu: 1
        maxCpu: 1
        minRam: 0.25
        maxRam: 0.5`),
    );
    const va = m.services[0].verticalAutoscaling;
    assert.equal(va.maxCpu, 1, 'clamping must be one-directional');
    assert.equal(va.maxRam, 0.5);
  });

  test('caps container count', () => {
    const m = parseManifest(base('      maxContainers: 10'));
    assert.equal(m.services[0].maxContainers, LIMITS.maxContainersPerService);
  });

  test('caps TTL', () => {
    const m = parseManifest(base().replace('ttlMinutes: 30', 'ttlMinutes: 6000'));
    assert.equal(m.trial.ttlMinutes, LIMITS.maxTtlMinutes);
  });
});

describe('per-family field rules', () => {
  // Each of these is accepted by the import endpoint and then fails silently,
  // which is why they are enforced here rather than discovered in production.

  test('databases get mode, never container counts', () => {
    const m = parseManifest(`
version: 1
app: { slug: t, name: T }
trial: { ttlMinutes: 10, entry: { service: app, port: 3000 } }
infra:
  services:
    - hostname: db
      type: postgresql@16
      minContainers: 3
      maxContainers: 5
    - hostname: app
      type: nodejs@22
`);
    const db = m.services.find((s) => s.hostname === 'db');
    assert.equal(db.minContainers, undefined, 'databases reject minContainers');
    assert.equal(db.maxContainers, undefined);
    assert.equal(db.mode, 'NON_HA');
  });

  test('runtimes get container counts, never mode', () => {
    const m = parseManifest(base('      mode: HA'));
    const app = m.services[0];
    assert.equal(app.mode, undefined, 'runtimes reject mode');
    assert.equal(app.minContainers, 1);
  });

  test('docker gets FIXED cpu/ram/disk, never ranges', () => {
    const m = parseManifest(`
version: 1
app: { slug: t, name: T }
trial: { ttlMinutes: 10, entry: { service: app, port: 3000 } }
infra:
  services:
    - hostname: app
      type: docker@26.1
      verticalAutoscaling: { minCpu: 1, maxCpu: 99, minRam: 1, maxRam: 99 }
`);
    const va = m.services[0].verticalAutoscaling;
    assert.equal(va.minCpu, undefined, 'docker VMs reject min/max ranges');
    assert.equal(va.maxCpu, undefined);
    assert.equal(va.cpu, LIMITS.maxCpuPerService, 'range must collapse to a clamped fixed value');
    assert.equal(va.ram, LIMITS.maxRamGbPerService);
  });

  test('object storage gets neither autoscaling nor container counts', () => {
    const m = parseManifest(`
version: 1
app: { slug: t, name: T }
trial: { ttlMinutes: 10, entry: { service: app, port: 3000 } }
infra:
  services:
    - hostname: app
      type: nodejs@22
    - hostname: files
      type: objectstorage
      objectStorageSize: 2
      verticalAutoscaling: { minCpu: 1, maxCpu: 2 }
      minContainers: 2
`);
    const store = m.services.find((s) => s.hostname === 'files');
    assert.equal(store.verticalAutoscaling, undefined);
    assert.equal(store.minContainers, undefined);
    assert.equal(store.objectStorageSize, 2, 'sizing field must survive');
  });
});

describe('rejections', () => {
  const bad = (yaml, match) =>
    assert.throws(() => parseManifest(yaml), match, 'should have been rejected');

  test('unknown service type', () => {
    bad(base().replace('type: nodejs@22', 'type: bitcoin-miner@1'), /not allowed/);
  });

  test('SMTP credentials — a trial must not become a mail relay', () => {
    bad(
      base(`      envSecrets:
        SMTP_HOST: smtp.example.com`),
      /blocked/,
    );
  });

  test('port outside the range Zerops permits', () => {
    bad(base().replace('port: 3000', 'port: 70000'), /10-65435/);
  });

  test('entry service that does not exist', () => {
    bad(base().replace('service: app,', 'service: ghost,'), /not one of/);
  });

  test('too many services', () => {
    const many = Array.from(
      { length: LIMITS.maxServicesPerTrial + 1 },
      (_, i) => `    - hostname: s${i}\n      type: nodejs@22`,
    ).join('\n');
    bad(
      `version: 1\napp: { slug: t, name: T }\ntrial: { ttlMinutes: 10, entry: { service: s0, port: 3000 } }\ninfra:\n  services:\n${many}`,
      /limit is/,
    );
  });

  test('duplicate hostnames', () => {
    bad(base('    - hostname: app\n      type: nodejs@22'), /duplicate hostname/);
  });
});

describe('capability declaration', () => {
  test('assumes the worst when undeclared', () => {
    const m = parseManifest(base());
    assert.equal(m.app.capabilities.outboundHttp, true, 'undeclared must default to risky');
    assert.equal(m.app.capabilities.level, 'elevated');
    assert.ok(m.app.capabilities.notice, 'risky apps must warn the visitor');
  });

  test('honours an explicit safe declaration', () => {
    const m = parseManifest(
      base().replace('  name: Test App', '  name: Test App\n  capabilities:\n    outboundHttp: false'),
    );
    assert.equal(m.app.capabilities.level, 'standard');
    assert.equal(m.app.capabilities.notice, null);
  });
});

describe('rendered import YAML', () => {
  test('always carries the tag the reaper requires', () => {
    const { yaml } = renderImportYaml(parseManifest(base()), { trialId: 'abc123' });
    assert.match(yaml, new RegExp(LEASE_TAG), 'without this tag the reaper refuses to delete it');
  });

  test('enables the platform preprocessor', () => {
    const { yaml } = renderImportYaml(parseManifest(base()), { trialId: 'abc123' });
    assert.ok(yaml.startsWith('#yamlPreprocessor=on'));
  });

  test('generates a distinct password per trial', () => {
    const m = parseManifest(
      base().replace(
        '  entry: { service: app, port: 3000 }',
        '  entry: { service: app, port: 3000 }\n  credentials:\n    - { label: Pass, key: PW, generate: password }',
      ),
    );
    const a = renderImportYaml(m, { trialId: generateTrialId() }).secrets.PW;
    const b = renderImportYaml(m, { trialId: generateTrialId() }).secrets.PW;
    assert.notEqual(a, b, 'two visitors must never share a password');
    assert.ok(a.length >= 16);
  });

  test('rejects a slug too long to be a hostname', () => {
    assert.throws(
      () => parseManifest(base().replace('slug: testapp', 'slug: averyveryverylongapplicationslug')),
      /max 24 chars/,
    );
  });

  test('project name stays within the 40-char budget at the slug limit', () => {
    // 24 chars is the longest slug the validator permits. With the
    // "opentry-" prefix and a 12-char trial id that overflows 40, so the
    // renderer must truncate rather than emit an invalid project name.
    const maxSlug = 'a'.repeat(24);
    const m = parseManifest(base().replace('slug: testapp', `slug: ${maxSlug}`));
    const { projectName } = renderImportYaml(m, { trialId: generateTrialId() });
    assert.ok(projectName.length <= 40, `got ${projectName.length}: ${projectName}`);
    assert.ok(projectName.startsWith('opentry-'));
  });
});

describe('docker port collision guard', () => {
  const dockerOnPort = (port) => `
version: 1
app: { slug: t, name: T }
trial: { ttlMinutes: 10, entry: { service: app, port: ${port} } }
infra:
  services:
    - hostname: app
      type: docker@26.1
`;

  test('rejects port 80 on a docker service', () => {
    // Cost two catalog candidates before it was understood: the service reports
    // ACTIVE, the URL resolves, and nothing ever answers.
    assert.throws(() => parseManifest(dockerOnPort(80)), /collides with the project's L7 balancer/);
  });

  test('rejects port 443 too', () => {
    assert.throws(() => parseManifest(dockerOnPort(443)), /collides/);
  });

  test('allows a high port', () => {
    assert.equal(parseManifest(dockerOnPort(8080)).trial.entry.port, 8080);
  });

  test('does not restrict non-docker services', () => {
    const m = parseManifest(`
version: 1
app: { slug: t, name: T }
trial: { ttlMinutes: 10, entry: { service: app, port: 80 } }
infra:
  services:
    - hostname: app
      type: nodejs@22
`);
    assert.equal(m.trial.entry.port, 80);
  });
});
