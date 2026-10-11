/**
 * Structural check for the published surface: every entry point the manifest
 * promises exists, the bundle patch agrees with the manifest, and the client
 * half registers under the id the shell loader is told to expect.
 *
 * Run with: node scripts/check-plugin.mjs
 */
import { readFile, access } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const problems = []

/**
 * Record a failure.
 * @param {string} message - what is wrong, stated so it can be fixed.
 */
function fail(message) {
  problems.push(message)
}

/**
 * Assert a path exists.
 * @param {string} relative - the path, relative to the package root.
 */
async function requireFile(relative) {
  try {
    await access(join(root, relative))
  } catch {
    fail(`missing file: ${relative}`)
  }
}

const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

// The Loader reads these; an absent one turns the install into a warning.
if (manifest.dsh?.bundle?.patch !== './cordis.patch.yml') {
  fail('dsh.bundle.patch must point at ./cordis.patch.yml so the Loader applies a layer')
}
if (manifest.engines?.node === undefined) {
  fail('engines.node is missing; the harness resolves peers against it')
}
for (const field of ['repository', 'homepage', 'bugs', 'icon', 'license']) {
  if (manifest[field] === undefined) fail(`manifest is missing "${field}"`)
}

const entries = [
  manifest.main,
  manifest.types,
  manifest.exports?.['.']?.import,
  manifest.exports?.['./client'],
  manifest.dsh.bundle.patch,
]
for (const entry of entries) {
  if (typeof entry === 'string') await requireFile(entry)
}

for (const field of manifest.files ?? []) {
  if (field === 'lib') continue
  await requireFile(field)
}

// The row id in the patch, the plugin's own `name` export and the locale
// namespace all name the same entry; a mismatch shows as an empty settings page.
const patch = await readFile(join(root, 'cordis.patch.yml'), 'utf8')
const rowId = /id:\s*(\S+)/.exec(patch)?.[1]
const rowName = /name:\s*'?([^'\n]+)'?/.exec(patch)?.[1]?.trim()
if (rowName !== manifest.name) {
  fail(`the patch installs "${rowName}" but the package is named "${manifest.name}"`)
}

const entrySource = await readFile(join(root, manifest.main.replace(/^lib\//, 'lib/')), 'utf8').catch(() => '')
if (entrySource !== '' && rowId !== undefined && !entrySource.includes(`"${rowId}"`)) {
  fail(`the entry does not export the name "${rowId}" the patch row declares`)
}

const clientSource = await readFile(join(root, 'lib', 'client.js'), 'utf8').catch(() => '')
if (clientSource !== '') {
  const loaderId = /__ModuleLoader__\.load\(\{\s*id:\s*"([^"]+)"/.exec(clientSource)?.[1]
  if (loaderId !== manifest.name) {
    fail(`the client bundle registers as "${loaderId}" but the package is "${manifest.name}"`)
  }
}

if (problems.length > 0) {
  console.error(`check-plugin: ${problems.length} problem(s)`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log(`check-plugin: ok (${entries.length} entry points, row "${rowId}")`)