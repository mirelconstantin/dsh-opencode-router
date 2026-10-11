/**
 * Smoke check for the published entry points: the built `lib/` artifacts must
 * import cleanly under the plugin's own Node, export the plugin surface the
 * Loader expects, and build a working exit pool from the shipped bundle.
 *
 * This is what a `dsh plugin add` install gets, so it guards the boundary the
 * unit tests cannot: the bundle, not the source tree.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { builtTest, lib, root } from './helpers.ts'

/**
 * Chunk specifiers a built file references, static and dynamic. The ip-pool
 * chunk is pulled in by `await import(...)` rather than a top-level `from`,
 * so a static-only scan would report a live chunk as orphaned.
 */
function chunkSpecs(source: string): string[] {
  return [
    ...[...source.matchAll(/from\s+"(\.\/[^"]+\.js)"/g)].map((m) => m[1]!),
    ...[...source.matchAll(/(?:import|require)\(\s*"(\.\/[^"]+\.js)"\s*\)/g)].map((m) => m[1]!),
  ]
}

describe('the manifest', () => {
  test('declares the bundle patch the Loader applies', async () => {
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  })

  builtTest('ships every entry point it declares', async () => {
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    for (const entry of [manifest.main, manifest.exports['.'].import, manifest.exports['./client']]) {
      await assert.doesNotReject(readFile(join(root, entry)), `missing entry: ${entry}`)
    }
  })

  builtTest('the patch inserts the plugin row', async () => {
    const patch = await readFile(lib('../cordis.patch.yml'), 'utf8')
    assert.match(patch, /- insert:/)
    assert.match(patch, /id: opencode2dsh/)
    assert.match(patch, /name: 'dsh-opencode-router'/)
  })
})

describe('the built plugin entry', () => {
  builtTest('imports and exports the Loader surface', async () => {
    const plugin = await import(pathToFileURL(lib('index.js')).href)
    assert.equal(typeof plugin.apply, 'function', 'apply() mounts the plugin')
    assert.equal(plugin.name, 'opencode2dsh', 'the row id and the plugin name must match')
    assert.deepEqual([...plugin.inject], ['llm'], 'the provider needs the llm service')
    assert.ok(plugin.Config, 'the settings schema must be exported')
  })

  builtTest('every chunk the entry imports resolves', async () => {
    const source = await readFile(lib('index.js'), 'utf8')
    const specs = chunkSpecs(source)
    assert.ok(specs.length > 0, 'the entry should reference its chunks')
    for (const spec of new Set(specs)) {
      await assert.doesNotReject(readFile(join(lib('.'), spec)), `unresolved chunk: ${spec}`)
    }
  })

  builtTest('no stale chunk from an earlier build is left behind', async () => {
    // Every chunk file must be reachable from the entry graph, so an
    // orphaned hash-named chunk (a --no-clean leftover) is a build defect.
    const entry = await readFile(lib('index.js'), 'utf8')
    const seen = new Set<string>()
    const queue = chunkSpecs(entry)
    while (queue.length > 0) {
      const spec = queue.pop()!
      if (seen.has(spec)) continue
      seen.add(spec)
      const chunk = await readFile(join(lib('.'), spec), 'utf8')
      queue.push(...chunkSpecs(chunk))
    }
    const entries = new Set(['./index.js', './client.js'])
    for (const file of await readdir(lib('.'))) {
      if (!file.endsWith('.js') || entries.has(`./${file}`)) continue
      assert.ok(seen.has(`./${file}`), `orphaned chunk with no importer: ${file}`)
    }
  })

  builtTest('builds a working exit pool from the shipped bundle', async () => {
    // The pool is minified to a single-letter export, so it is located by the
    // constructor name on the module rather than by an export key.
    const files = await readdir(lib('.'))
    const poolChunk = files.find((f) => /^admission-.*\.js$/.test(f))
    assert.ok(poolChunk, 'the bundle should emit a chunk holding the pool')
    const module = await import(pathToFileURL(join(lib('.'), poolChunk!)).href) as Record<string, unknown>
    const ExitPool = Object.values(module).find((value) => typeof value === 'function' && value.name === 'ExitPool') as
      (new (options: object) => {
        add(node: Record<string, unknown>): boolean
        snapshot(): { total: number }
        pick(session: string, model: string): string | null
      }) | undefined
    assert.ok(ExitPool, 'the pool class must be exported from its chunk')
    const pool = new ExitPool({ targetSize: 5 })
    for (let i = 0; i < 5; i += 1) {
      pool.add({ id: `p${i}`, protocol: 'http', source: 'manual', pinned: false, exitIP: '', exitLocation: '', latencyMs: 100, quality: 'S', addedAt: 0 })
    }
    assert.equal(pool.snapshot().total, 5)
    assert.notEqual(pool.pick('s1', 'model'), null)
  })
})

describe('the built client bundle', () => {
  builtTest('registers itself with the shell module loader', async () => {
    const source = await readFile(lib('client.js'), 'utf8')
    assert.match(source, /window\.__ModuleLoader__\.load\(\{\s*id:\s*"dsh-opencode-router"/)
  })

  builtTest('keeps every platform import external', async () => {
    const source = await readFile(lib('client.js'), 'utf8')
    // `dsh-client-ui-slots` is imported for types only, so it is erased and
    // never reaches the bundle; the rest must be resolved by the loader.
    for (const external of ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives']) {
      assert.match(source, new RegExp(`require\\("${external.replace(/[/@]/g, '\\$&')}"\\)`), `missing external: ${external}`)
    }
  })

  builtTest('inlines no other deepseek package bundle', async () => {
    const source = await readFile(lib('client.js'), 'utf8')
    const required = [...source.matchAll(/require\("(@deepseek-ai\/[^"]+)"\)/g)].map((m) => m[1]!)
    for (const spec of required) {
      assert.ok(
        ['@deepseek-ai/cordis', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives'].includes(spec),
        `unexpected cross-plugin import: ${spec}`,
      )
    }
  })

  builtTest('injects the CSS module as a style tag', async () => {
    const source = await readFile(lib('client.js'), 'utf8')
    assert.match(source, /data-plugin-css/)
    assert.match(source, /dsh-opencode-router\/ip-pool\.module\.css/)
  })
})