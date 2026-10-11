/**
 * Remove the build output so the next build starts from an empty `lib/`.
 *
 * The node build passes `--no-clean` so a client rebuild does not drop the
 * node bundle, which means a renamed or removed source module leaves its
 * previous hash-named chunk behind. Clearing the directory is the only way to
 * be sure the shipped chunks are exactly the ones the current sources produce.
 *
 * Run with: node scripts/clean.mjs
 */
import { rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
await rm(join(root, 'lib'), { recursive: true, force: true })
console.log('clean: removed lib/')