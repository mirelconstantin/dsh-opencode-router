/**
 * The Host schema is the contract for what a saved value may be, so the page's
 * bounds and syntax checks are pinned here. If these drift from
 * `src/ip-pool-settings/namespace.ts`, a user either cannot save a legal value
 * or saves one the server rejects.
 *
 * Run with: node --test "test/*.test.ts"
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROXY_SHAPE, URL_SHAPE } from '../src/client/address-list.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const card = await readFile(join(root, 'src', 'client', 'IpPoolCard.tsx'), 'utf8')

describe('the page bounds match the Host schema', () => {
  test('the target-size ceiling agrees with namespace.ts', async () => {
    const namespace = await readFile(join(root, 'src', 'ip-pool-settings', 'namespace.ts'), 'utf8')
    const ceiling = /targetSize:\s*Schema\.number\(\)\.min\((\d+)\)\.max\((\d+)\)/.exec(namespace)
    assert.ok(ceiling, 'the schema should bound targetSize')
    const pageCeiling = /const MAX_TARGET_SIZE = (\d+)/.exec(card)?.[1]
    assert.equal(pageCeiling, ceiling[2], 'the page and the schema must allow the same maximum')
  })

  test('the probe-concurrency ceiling agrees with namespace.ts', async () => {
    const namespace = await readFile(join(root, 'src', 'ip-pool-settings', 'namespace.ts'), 'utf8')
    const ceiling = /maxConcurrentProbes:\s*Schema\.number\(\)\.min\((\d+)\)\.max\((\d+)\)/.exec(namespace)
    assert.ok(ceiling, 'the schema should bound maxConcurrentProbes')
    const pageCeiling = /const MAX_PROBE_CONCURRENCY = (\d+)/.exec(card)?.[1]
    assert.equal(pageCeiling, ceiling[2], 'the page and the schema must allow the same maximum')
  })
})

describe('the proxy syntax the page accepts', () => {
  test('accepts the forms the pool can dial', () => {
    for (const entry of [
      'http://127.0.0.1:7897',
      'https://proxy.example.com:8443',
      'socks5://10.0.0.1:1080',
      'socks5h://10.0.0.1:1080',
      'http://user:pass@proxy.example.com:3128',
      'http://[2001:db8::1]:8080',
    ]) {
      assert.ok(PROXY_SHAPE.test(entry), `should accept ${entry}`)
    }
  })

  test('refuses what the pool cannot dial', () => {
    for (const entry of [
      '127.0.0.1:7897',
      'http://host-without-port',
      'proxy.example.com:8080',
      'ftp://host:21',
      '',
      'http://host:port',
    ]) {
      assert.ok(!PROXY_SHAPE.test(entry), `should refuse ${entry}`)
    }
  })

  test('accepts only http(s) subscription URLs', () => {
    assert.ok(URL_SHAPE.test('https://example.com/sub'))
    assert.ok(URL_SHAPE.test('http://example.com/sub'))
    assert.ok(!URL_SHAPE.test('ftp://example.com/sub'))
    assert.ok(!URL_SHAPE.test('example.com/sub'))
  })
})

describe('validation follows the master switch', () => {
  test('a disabled pool validates nothing', () => {
    // The rule is that `validateForm` returns early when the pool is off.
    assert.match(card, /if \(!enabled\) return problems/)
  })

  test('the page collects every failure rather than the first', () => {
    assert.match(card, /const problems: string\[\] = \[\]/)
    assert.match(card, /problems\.push\(/)
  })
})