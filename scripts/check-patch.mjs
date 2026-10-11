/**
 * Checks the bundle patch against the plugin's own settings schema, so a
 * config key that the UI edits cannot silently disagree with the schema the
 * Host serves.
 *
 * Run with: node scripts/check-patch.mjs
 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const problems = []

const patch = YAML.parse(await readFile(join(root, 'cordis.patch.yml'), 'utf8'))
if (!Array.isArray(patch)) {
  console.error('check-patch: the patch must be a YAML array of layers')
  process.exit(1)
}

const rows = patch.flatMap((layer) => layer.insert ?? [])
if (rows.length === 0) {
  problems.push('the patch inserts no plugin row, so the bundle never activates')
}

const seen = new Set()
for (const row of rows) {
  if (row.id === undefined) problems.push('a row is missing its id')
  if (row.name === undefined) problems.push(`row "${row.id}" is missing its package name`)
  // The Loader evaluates `config` against the injected context, and a row
  // that overrides a key must restate the whole config, so an empty object
  // is the only safe default here.
  if (row.config !== undefined && Object.keys(row.config).length > 0) {
    problems.push(`row "${row.id}" overrides config keys; every key must be restated, so prefer defaults`)
  }
  if (seen.has(row.id)) problems.push(`duplicate row id "${row.id}"`)
  seen.add(row.id)
}

// The settings namespace the client page edits must match the row the Host
// serves, or the page registers against an entry that never mounts.
const client = await readFile(join(root, 'src', 'client', 'index.ts'), 'utf8')
const namespace = /SETTINGS_NAMESPACE\s*=\s*'([^']+)'/.exec(client)?.[1]
if (namespace === undefined) {
  problems.push('src/client/index.ts does not declare SETTINGS_NAMESPACE')
} else if (namespace !== 'opencode2dsh') {
  problems.push(`SETTINGS_NAMESPACE is "${namespace}" but the patch row id is "${rows[0]?.id}"`)
}

const bridge = await readFile(join(root, 'src', 'ip-pool-settings', 'bridge.ts'), 'utf8')
const prefix = /BRIDGE_PREFIX\s*=\s*'([^']+)'/.exec(bridge)?.[1] ?? ''
const card = await readFile(join(root, 'src', 'client', 'IpPoolCard.tsx'), 'utf8')
if (!card.includes(prefix)) {
  problems.push(`the card does not call the bridge prefix "${prefix}" declared by bridge.ts`)
}

if (problems.length > 0) {
  console.error(`check-patch: ${problems.length} problem(s)`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log(`check-patch: ok (${rows.length} row(s), namespace "${namespace}")`)