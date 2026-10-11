/**
 * Prepare the tarball: build both halves, then verify what is about to ship.
 *
 * `lib/` is gitignored, so a tarball produced from a clean checkout would
 * otherwise contain no entry points and install as a package that cannot load.
 *
 * Run with: node scripts/prepack.mjs
 */
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Run a package script.
 * @param {string} name - the script name in package.json.
 */
function run(name) {
  execFileSync('npm', ['run', name], { cwd: root, stdio: 'inherit', shell: true })
}

run('clean')
run('build')
run('build:client')
run('verify:all')

console.log('prepack: lib/ built and verified')