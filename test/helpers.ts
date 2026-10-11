/**
 * Shared test helpers for the checks that read the built bundle.
 *
 * `lib/` is gitignored, so a clean checkout has none of it. Tests that
 * inspect the build declare themselves with `builtTest` and skip with a
 * readable reason when it is missing, instead of failing with a bare ENOENT
 * that looks like a real defect.
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

/** The package root, one level above `test/`. */
export const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** A path inside the built output. */
export const lib = (file: string) => join(root, 'lib', file)

/** Whether `lib/` has been built. */
export const built = existsSync(lib('index.js'))

/**
 * Declare a test that only makes sense once `lib/` exists.
 * @param name - the test name.
 * @param fn - the test body.
 */
export function builtTest(name: string, fn: () => Promise<void> | void): void {
  test(name, { skip: built ? false : 'lib/ is not built; run pnpm run build' }, fn)
}