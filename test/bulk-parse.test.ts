/**
 * Tests for the bulk-paste parser the manual-proxy and subscription editors
 * share. The parser is what makes importing hundreds of proxies one action
 * instead of hundreds, so its decisions about duplicates and malformed input
 * are the user-visible contract.
 *
 * Run with: node --test "test/*.test.ts"
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { parseListBlock, PROXY_SHAPE, URL_SHAPE } from '../src/client/address-list.ts'

describe('parseListBlock', () => {
  test('reads one address per line', () => {
    const result = parseListBlock('http://a:1\nhttp://b:2\n', [], PROXY_SHAPE)
    assert.deepEqual(result.added, ['http://a:1', 'http://b:2'])
    assert.equal(result.duplicates, 0)
    assert.equal(result.malformed.length, 0)
  })

  test('accepts CRLF and trims surrounding whitespace', () => {
    const result = parseListBlock('  http://a:1  \r\n\t http://b:2 \r\n', [], PROXY_SHAPE)
    assert.deepEqual(result.added, ['http://a:1', 'http://b:2'])
  })

  test('ignores blank lines and comments', () => {
    const result = parseListBlock('\n# a comment\nhttp://a:1\n\n#another\n', [], PROXY_SHAPE)
    assert.deepEqual(result.added, ['http://a:1'])
    assert.equal(result.malformed.length, 0)
  })

  test('an empty block adds nothing', () => {
    const result = parseListBlock('', [], PROXY_SHAPE)
    assert.deepEqual(result.added, [])
    assert.equal(result.duplicates, 0)
  })

  test('treats an equivalent spelling as a duplicate', () => {
    // Same endpoint written differently must not land twice in the list.
    const result = parseListBlock('http://Host:80', ['http://host:80'], PROXY_SHAPE)
    assert.deepEqual(result.added, [])
    assert.equal(result.duplicates, 1)
  })

  test('folds a leading-zero port when comparing', () => {
    const result = parseListBlock('http://host:080', ['http://host:80'], PROXY_SHAPE)
    assert.deepEqual(result.added, [])
    assert.equal(result.duplicates, 1)
  })

  test('differing schemes are not duplicates of each other', () => {
    const result = parseListBlock('socks5://host:1080', ['http://host:1080'], PROXY_SHAPE)
    assert.deepEqual(result.added, ['socks5://host:1080'])
  })

  test('differing credentials are not duplicates of each other', () => {
    const result = parseListBlock('http://bob:pw@host:8080', ['http://alice:pw@host:8080'], PROXY_SHAPE)
    assert.deepEqual(result.added, ['http://bob:pw@host:8080'])
  })

  test('deduplicates within the pasted block itself', () => {
    const result = parseListBlock('http://a:1\nhttp://a:1\nhttp://A:1', [], PROXY_SHAPE)
    assert.deepEqual(result.added, ['http://a:1'])
    assert.equal(result.duplicates, 2)
  })

  test('reports malformed input separately from duplicates', () => {
    const result = parseListBlock('http://a:1\nnot-a-PROXY_SHAPE\nhttp://a:1\n', [], PROXY_SHAPE)
    assert.deepEqual(result.added, ['http://a:1'])
    assert.equal(result.duplicates, 1)
    assert.deepEqual(result.malformed, ['not-a-PROXY_SHAPE'])
    assert.equal(result.firstError, 'not-a-PROXY_SHAPE')
  })

  test('rejects a proxy address with no port', () => {
    const result = parseListBlock('http://host-without-port', [], PROXY_SHAPE)
    assert.deepEqual(result.added, [])
    assert.equal(result.malformed.length, 1)
  })

  test('accepts an IPv6 literal in brackets', () => {
    const result = parseListBlock('http://[2001:db8::1]:8080', [], PROXY_SHAPE)
    assert.deepEqual(result.added, ['http://[2001:db8::1]:8080'])
  })

  test('accepts credentials in the address', () => {
    const result = parseListBlock('http://user:pass@host:3128', [], PROXY_SHAPE)
    assert.deepEqual(result.added, ['http://user:pass@host:3128'])
  })

  test('handles a large block', () => {
    const block = Array.from({ length: 500 }, (_, i) => `http://10.0.0.${i % 250 + 1}:${8080 + (i % 7)}`).join('\n')
    const result = parseListBlock(block, [], PROXY_SHAPE)
    assert.equal(result.added.length + result.duplicates, 500)
    assert.ok(result.added.length > 0)
  })

  test('checks subscription lines against the URL syntax', () => {
    const ok = parseListBlock('https://example.com/sub\n', [], URL_SHAPE)
    assert.deepEqual(ok.added, ['https://example.com/sub'])

    const bad = parseListBlock('ftp://example.com/sub', [], URL_SHAPE)
    assert.equal(bad.added.length, 0)
    assert.equal(bad.malformed.length, 1)
  })

  test('does not mutate the list it was given', () => {
    const values = ['http://a:1']
    parseListBlock('http://b:2\n', values, PROXY_SHAPE)
    assert.deepEqual(values, ['http://a:1'])
  })
})