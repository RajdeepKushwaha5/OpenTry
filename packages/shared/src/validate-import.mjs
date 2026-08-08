/**
 * Validate a rendered Zerops Import YAML against Zerops' own published
 * JSON Schema, offline.
 *
 * Why this exists: a bad manifest otherwise costs a 4-minute round trip
 * (import -> provision -> watch a service sit in READY_TO_DEPLOY -> time out).
 * Two real bugs were found this way in seconds:
 *
 *   1. Inside an embedded `zeropsYaml`, `build.base` and `build.deployFiles`
 *      must be ARRAYS. Passing the strings the docs show for a repo-level
 *      zerops.yml is silently accepted by the import endpoint and then no
 *      build is ever triggered.
 *   2. Databases reject `minContainers`; runtimes reject `mode`.
 *
 * Schema source:
 *   https://api.app-prg1.zerops.io/api/rest/public/settings/import-project-yml-json-schema.json
 *
 * KNOWN DIVERGENCE — the schema's `type` enum is stricter than the live API.
 * The schema lists `postgresql:single@16`; the API also accepts the documented
 * `postgresql@16` + `mode: NON_HA`, which is what the official recipes use and
 * what we have verified end-to-end. So type-enum violations are reported as
 * warnings, not errors. Everything else is a hard failure.
 */

// Zerops publishes the schema as JSON Schema draft 2020-12, so the plain
// `ajv` entrypoint cannot compile it ("no schema with key or ref
// .../2020-12/schema"). The 2020 build is required.
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import YAML from 'yaml';

const SCHEMA_URL =
  'https://api.app-prg1.zerops.io/api/rest/public/settings/import-project-yml-json-schema.json';

let cachedSchema = null;
let cachedValidator = null;

export async function loadSchema({ url = SCHEMA_URL, schema } = {}) {
  if (schema) return schema;
  if (cachedSchema) return cachedSchema;
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Could not fetch import schema: HTTP ${res.status}`);
  cachedSchema = await res.json();
  return cachedSchema;
}

async function getValidator(opts) {
  if (cachedValidator) return cachedValidator;
  const schema = await loadSchema(opts);
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  cachedValidator = ajv.compile(schema);
  return cachedValidator;
}

const isTypeEnumError = (e) =>
  /\/type$/.test(e.instancePath) && e.keyword === 'enum';

/**
 * @param {string} importYaml  rendered Import YAML (preprocessor line allowed)
 * @returns {Promise<{valid:boolean, errors:string[], warnings:string[]}>}
 */
export async function validateImportYaml(importYaml, opts = {}) {
  const validate = await getValidator(opts);
  const doc = YAML.parse(importYaml.replace(/^#yamlPreprocessor=on\s*\n/, ''));

  const ok = validate(doc);
  const errors = [];
  const warnings = [];

  if (!ok) {
    for (const e of validate.errors ?? []) {
      const where = e.instancePath || '(root)';
      if (isTypeEnumError(e)) {
        warnings.push(
          `${where}: "${valueAt(doc, e.instancePath)}" is not in the schema's type enum ` +
            `(the live API is more permissive — verified working)`,
        );
      } else {
        // Keep the message readable: the type enum has 180+ entries.
        const params =
          e.keyword === 'enum' ? '' : ` ${JSON.stringify(e.params ?? {}).slice(0, 120)}`;
        errors.push(`${where}: ${e.message}${params}`);
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

function valueAt(obj, pointer) {
  if (!pointer) return undefined;
  let cur = obj;
  for (const seg of pointer.split('/').slice(1)) {
    cur = cur?.[seg.replace(/~1/g, '/').replace(/~0/g, '~')];
    if (cur === undefined) return undefined;
  }
  return cur;
}
