/**
 * Subscription-URL delivery (issues #60 / #63).
 *
 * The ip-pool section accepts subscription URLs under two spellings — the
 * canonical nested `subscription.urls` the settings form writes, and the
 * legacy flat `subscriptions` key older patches use. Both the host resolver
 * and the browser card must read whichever one carries URLs.
 *
 * The regression under test is subtle and was shipped: `Schema.array()` gets an
 * IMPLICIT `meta.default = []` from schemastery (it does not require an
 * explicit `.default()`), so a bare `raw.subscriptions ?? raw.subscription?.urls`
 * chain short-circuits on the injected empty array and silently discards the
 * saved URLs. The symptom is "saved successfully, then the list re-renders
 * empty and the runtime never sees a URL" — with no error anywhere.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { IpPoolConfigSchema, resolveIpPoolSettings } from '../src/ip-pool-settings/namespace.ts'
import { resolveSubscriptionUrls } from '../src/ip-pool-settings/subscription-urls.ts'

const URL_A = 'https://airport.example.test/api/v1/client/subscribe?token=a'
const URL_B = 'https://airport.example.test/api/v1/client/subscribe?token=b'

// -- the schema behaviour the fix depends on ----------------------------------

test('schemastery injects `[]` into an array field that declares no default', () => {
  // This is the premise of the whole regression: `subscriptions` is declared
  // WITHOUT `.default()`, yet the resolved value is `[]` — not `undefined`.
  // If schemastery ever changes this, the `??`-vs-empty-list reasoning (and the
  // helper's precedence rule) has to be revisited, so pin it here.
  const resolved = IpPoolConfigSchema({ subscription: { urls: [URL_A] } }) as {
    subscriptions?: unknown
    subscription?: { urls?: unknown }
  }
  assert.deepEqual(resolved.subscriptions, [], 'flat alias resolved to [], not undefined')
  assert.deepEqual(resolved.subscription?.urls, [URL_A], 'nested field keeps the real URL')

  // The old spelling is what broke: `[] ?? nested` returns `[]`.
  assert.deepEqual(resolved.subscriptions ?? resolved.subscription?.urls, [], 'the old `??` chain loses the URL')
})

// -- the shared precedence rule -------------------------------------------------

test('resolveSubscriptionUrls reads the nested field the form writes', () => {
  assert.deepEqual(resolveSubscriptionUrls({ subscription: { urls: [URL_A] } }), [URL_A])
})

test('resolveSubscriptionUrls falls back to the legacy flat alias', () => {
  assert.deepEqual(resolveSubscriptionUrls({ subscriptions: [URL_A] }), [URL_A])
})

test('resolveSubscriptionUrls prefers a non-empty nested list over an empty flat one', () => {
  // The exact shape schemastery produces for a nested-only patch.
  assert.deepEqual(resolveSubscriptionUrls({ subscriptions: [], subscription: { urls: [URL_A] } }), [URL_A])
})

test('resolveSubscriptionUrls prefers a non-empty flat list over an empty nested one', () => {
  assert.deepEqual(resolveSubscriptionUrls({ subscriptions: [URL_B], subscription: { urls: [] } }), [URL_B])
})

test('resolveSubscriptionUrls returns [] for an absent, empty or malformed section', () => {
  assert.deepEqual(resolveSubscriptionUrls(undefined), [])
  assert.deepEqual(resolveSubscriptionUrls({}), [])
  assert.deepEqual(resolveSubscriptionUrls({ subscription: {} }), [])
  assert.deepEqual(resolveSubscriptionUrls({ subscriptions: [] }), [])
  assert.deepEqual(resolveSubscriptionUrls({ subscriptions: [], subscription: { urls: [] } }), [])
  // A hand-edited patch can carry junk; never throw on the boot path.
  assert.deepEqual(resolveSubscriptionUrls({ subscription: { urls: 'nope' as never } }), [])
  assert.deepEqual(resolveSubscriptionUrls({ subscriptions: 'nope' as never }), [])
})

// -- the host resolver end-to-end ----------------------------------------------

test('resolveIpPoolSettings delivers a nested-form subscription URL to the runtime', () => {
  // The reported bug: the settings page saved the URL (nested spelling), the
  // runtime resolved zero URLs, so SubscriptionFetcher was never constructed.
  const resolved = resolveIpPoolSettings({ subscription: { urls: [URL_A], refreshMs: 120_000 } })
  assert.deepEqual(resolved.subscription.urls, [URL_A])
  assert.equal(resolved.subscription.refreshMs, 120_000)
})

test('resolveIpPoolSettings still reads the legacy flat spelling', () => {
  const resolved = resolveIpPoolSettings({ subscriptions: [URL_A] })
  assert.deepEqual(resolved.subscription.urls, [URL_A])
})

test('resolveIpPoolSettings survives the schema-resolved dual-key shape', () => {
  // Feed the resolver what schemastery actually emits for a nested-only patch:
  // both keys present, the flat one empty. The URL must still come through.
  const fromSchema = IpPoolConfigSchema({ subscription: { urls: [URL_A] } }) as never
  assert.deepEqual(resolveIpPoolSettings(fromSchema).subscription.urls, [URL_A])
})

test('resolveIpPoolSettings keeps a genuinely cleared list empty', () => {
  const resolved = resolveIpPoolSettings({ subscriptions: [], subscription: { urls: [] } })
  assert.deepEqual(resolved.subscription.urls, [])
})

test('resolveIpPoolSettings round-trips URLs through the config shape the runtime reads', () => {
  // toIpPoolConfig writes the flat key; resolveIpPoolSettings must read it back
  // or a live settings commit would reset the subscriptions to empty.
  const resolved = resolveIpPoolSettings({ subscription: { urls: [URL_A, URL_B] } })
  const roundTripped = resolveIpPoolSettings({ subscriptions: resolved.subscription.urls })
  assert.deepEqual(roundTripped.subscription.urls, [URL_A, URL_B])
})
