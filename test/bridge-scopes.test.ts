/**
 * The bridge's action routing: which scope reaches which runtime call.
 *
 * The subscription scope is the reason this file exists (issue #63). The
 * settings card's refresh button used to POST `{scope: 'refill'}`, which
 * pulls the public free-proxy sources — so the button silently refreshed the
 * wrong lane and the configured subscription URLs were never re-fetched.
 * `refill` and `subscriptions` are genuinely different operations and must
 * stay separately addressable.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { makeBridgeHandlers } from '../src/ip-pool-settings/bridge.ts'

/** A runtime that records which lane each scope actually called. */
function fakeRuntime(overrides: Record<string, unknown> = {}) {
  const calls: string[] = []
  const runtime = {
    pool: { has: () => true, snapshot: () => ({ state: 'healthy', total: 0, bySource: {}, availableFree: 0, pinned: '' }) },
    installer: { enabled: true, deferredReason: null },
    subscriptions: { urlCount: 2 },
    async probeAll() { calls.push('probeAll'); return 3 },
    async probeExit() { calls.push('probeExit'); return 1 },
    async refillNow() { calls.push('refillNow') },
    async refreshSubscriptions() { calls.push('refreshSubscriptions') },
    ...overrides,
  }
  return { calls, runtime: runtime as never }
}

const settings = { pinnedStrict: false, proxyHosts: [] }

describe('the bridge action scopes', () => {
  test('subscriptions refreshes only the subscription lane', async () => {
    const { calls, runtime } = fakeRuntime()
    const handlers = makeBridgeHandlers(() => runtime, () => settings)
    const result = await handlers.probe({ scope: 'subscriptions' })
    assert.equal(result.ok, true)
    assert.deepEqual(calls, ['refreshSubscriptions'], 'must not fall through to refill')
  })

  test('refill is still the free-source lane, distinct from subscriptions', async () => {
    const { calls, runtime } = fakeRuntime()
    const handlers = makeBridgeHandlers(() => runtime, () => settings)
    await handlers.probe({ scope: 'refill' })
    assert.deepEqual(calls, ['refillNow'], 'refill pulls the public sources, not the URLs')
  })

  test('subscriptions reports cleanly when no URLs are configured', async () => {
    // Better a clear refusal than a refill that quietly does the wrong thing.
    const { calls, runtime } = fakeRuntime({ subscriptions: null })
    const handlers = makeBridgeHandlers(() => runtime, () => settings)
    const result = await handlers.probe({ scope: 'subscriptions' })
    assert.equal(result.ok, false)
    assert.equal(result.ok === false && result.code, 'no-subscriptions')
    assert.deepEqual(calls, [], 'nothing was called')
  })

  test('an unknown scope is rejected rather than defaulted', async () => {
    // A typo must not silently become a refill.
    const { calls, runtime } = fakeRuntime()
    const handlers = makeBridgeHandlers(() => runtime, () => settings)
    const result = await handlers.probe({ scope: 'nonsense' })
    assert.equal(result.ok, false)
    assert.deepEqual(calls, [])
  })

  test('every scope refuses when the pool is not running', async () => {
    const handlers = makeBridgeHandlers(() => null, () => settings)
    for (const scope of ['all', 'refill', 'subscriptions', 'exit']) {
      const result = await handlers.probe({ scope, exitId: 'x' })
      assert.equal(result.ok, false, `scope ${scope} must not act on a dead pool`)
      assert.equal(result.ok === false && result.code, 'pool-disabled')
    }
  })
})
