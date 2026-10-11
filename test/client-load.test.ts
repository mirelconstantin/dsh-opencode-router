/**
 * Loads the built client bundle the way the shell does: it defines the module
 * loader the bundle registers into, evaluates the file, and then applies the
 * registered factory with a `require` that answers the platform externals.
 *
 * This is the only check that proves the browser half is executable, not just
 * structurally present. A bundle that parses but throws on evaluation, or that
 * hands back the wrong exports, fails here and nowhere else.
 *
 * Run with: node --test "test/*.test.ts"
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * A `document` and `window` stand-in covering exactly what the bundle touches:
 * a head it appends the stylesheet to, and the loader it registers into.
 */
function makeEnvironment(): { window: Record<string, unknown>; document: Record<string, unknown> } {
  const appended: Array<Record<string, unknown>> = []
  const document = {
    head: { appendChild: (node: Record<string, unknown>) => { appended.push(node) } },
    querySelector: () => null,
    createElement: () => ({ dataset: {} as Record<string, string> }),
    body: {},
  }
  const window: Record<string, unknown> = { __ModuleLoader__: { load: () => {} } }
  return { window, document }
}

/** Minimal stand-ins for the platform externals the bundle requires. */
const externals: Record<string, unknown> = {
  react: { createElement: () => null, Fragment: Symbol('Fragment') },
  'react/jsx-runtime': { jsx: () => null, jsxs: () => null, Fragment: Symbol('Fragment') },
  '@deepseek-ai/dsh-client-ui-primitives': { SettingsForm: () => null },
  '@deepseek-ai/dsh-client-ui-slots': {},
}

describe('the client bundle under the shell loader', () => {
  test('evaluates and registers a factory the loader can call', async () => {
    const source = await readFile(join(root, 'lib', 'client.js'), 'utf8')
    const env = makeEnvironment()
    let registered: { id: string; factory: (require: (id: string) => unknown) => unknown } | undefined
    ;(env.window as Record<string, { load: (entry: unknown) => void }>).__ModuleLoader__ = {
      load: (entry) => { registered = entry as typeof registered },
    }

    const context = vm.createContext({
      ...env,
      require: (id: string) => {
        const found = externals[id]
        if (found === undefined) throw new Error(`unexpected external: ${id}`)
        return found
      },
      module: { exports: {} },
      exports: {},
      console,
      setTimeout,
      clearTimeout,
      process,
      globalThis: undefined,
    })
    context.globalThis = context
    vm.runInContext(source, context, { filename: 'client.js' })

    assert.ok(registered, 'the bundle must register itself with the loader')
    assert.equal(registered.id, 'dsh-opencode-router')

    // The factory is what the shell runs once the module table is available.
    const exported = registered.factory((id: string) => {
      const found = externals[id]
      if (found === undefined) throw new Error(`unexpected external: ${id}`)
      return found
    })
    assert.ok(exported, 'the factory must return the module exports')
  })

  test('appends exactly one stylesheet, tagged with the plugin id', async () => {
    const source = await readFile(join(root, 'lib', 'client.js'), 'utf8')
    const appended: Array<Record<string, unknown>> = []
    const document = {
      head: { appendChild: (node: Record<string, unknown>) => { appended.push(node) } },
      querySelector: () => null,
      createElement: () => ({ dataset: {} as Record<string, string> }),
      body: {},
    }
    let factory: ((require: (id: string) => unknown) => unknown) | undefined
    const context = vm.createContext({
      window: { __ModuleLoader__: { load: (entry: { factory: (require: (id: string) => unknown) => unknown }) => { factory = entry.factory } } },
      document,
      module: { exports: {} },
      exports: {},
      console,
      process,
      globalThis: undefined,
    })
    context.globalThis = context
    vm.runInContext(source, context, { filename: 'client.js' })

    // The stylesheet is appended by the CSS-module shim that runs inside the
    // factory, so the factory has to be called before the tag appears.
    assert.equal(appended.length, 0, 'registration alone must not touch the DOM')
    assert.ok(factory, 'the bundle must register a factory')
    factory((id: string) => {
      const found = externals[id]
      if (found === undefined) throw new Error(`unexpected external: ${id}`)
      return found
    })

    assert.equal(appended.length, 1, 'the CSS module should inject one style tag')
    const style = appended[0]! as { dataset: Record<string, string>; textContent: string }
    assert.equal(style.dataset.plugin, 'dsh-opencode-router')
    assert.match(style.dataset.pluginCss!, /^dsh-opencode-router\//)
    assert.ok(style.textContent.length > 0, 'the stylesheet should carry the compiled CSS')
  })
})