/**
 * The session stamp is the whole difference between 200 and 403 FreeTierError
 * on the free lane, and a wrong one is silent: upstream answers 403 and DSH
 * renders it as "API key is invalid" (9router#4780, opencode2dsh#62). These pin
 * the encoding — the 12 hex characters must decode back to the wall clock, not
 * to hash bytes.
 *
 * Run with: node --test "test/*.test.ts"
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { canonicalSessionID } from '../src/adapter/ids.ts'

/**
 * The stamp is `~(ms * 0x1000 + counter)`, so it round-trips modulo 2^48 and
 * the low 12 bits are the counter. The plugin always mints counter 1, because
 * upstream decodes the segment and checks the clock; a zero-counter prefix is
 * rejected for having no counter structure (issue #62).
 */
function decodeStamp(id: string): { ms: number; counter: number } {
  const decoded = ~BigInt('0x' + id.slice(4, 16)) & 0xffffffffffffn
  const counter = Number(decoded & 0xfffn)
  return { ms: Number(decoded >> 12n), counter }
}

function stampDeltaMs(id: string): number {
  const { ms } = decodeStamp(id)
  // Compare milliseconds only: the counter lives in the low 12 bits and is
  // shifted out above, so it must not leak into the delta.
  const expected = BigInt(Date.now())
  const delta = (BigInt(ms) - expected + (1n << 36n)) % (1n << 36n)
  return Number(delta)
}

describe('the canonical session id', () => {
  test('keeps OpenCode\'s shape', () => {
    assert.match(canonicalSessionID('hello'), /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
  })

  test('stamps a decodable timestamp, not a digest', () => {
    const id = canonicalSessionID('stamp me')
    assert.ok(stampDeltaMs(id) < 60_000, `${id} does not decode to now`)
  })

  test('carries a real sequence in the low 12 bits', () => {
    // Issue #62: matching the shape stopped being sufficient once upstream
    // started decoding the 12 hex characters as ~(ms * 0x1000 + counter). A
    // zero or missing counter passes the regex and is still refused.
    assert.equal(decodeStamp(canonicalSessionID('counter me')).counter, 1)
  })

  test('keeps one session per conversation', () => {
    assert.equal(canonicalSessionID('same seed'), canonicalSessionID('same seed'))
    assert.notEqual(canonicalSessionID('same seed'), canonicalSessionID('other seed'))
  })

  test('passes a foreign canonical session through untouched', () => {
    const native = 'ses_ecc985076ffe3FWJqsz05vQbUW'
    assert.equal(canonicalSessionID(native), native)
  })
})
