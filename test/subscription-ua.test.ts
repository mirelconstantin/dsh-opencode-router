/**
 * The subscription fetch's User-Agent, and the rule that a blank setting
 * falls back to the built-in default.
 *
 * This is not cosmetic: airports allow-list the client version they
 * recognise. `clash-verge/1.6.0` was hardcoded and a real airport answers
 * `502 Bad Gateway` for it. The default is the allow-listed spelling, and
 * "send nothing" is not an option — an absent User-Agent is itself a
 * fingerprint, and a cleared setting must not produce one.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_SUBSCRIPTION_USER_AGENT,
  normalizeSubscriptionUserAgent,
} from '../src/pool/subscription-defaults.ts'
import { IpPoolConfigSchema, resolveIpPoolSettings } from '../src/ip-pool-settings/namespace.ts'

describe('the subscription fetch User-Agent', () => {
  test('the built-in default is the allow-listed spelling, not 1.6.0', () => {
    assert.equal(DEFAULT_SUBSCRIPTION_USER_AGENT, 'clash-verge/v2.0')
    assert.notEqual(DEFAULT_SUBSCRIPTION_USER_AGENT, 'clash-verge/1.6.0')
  })

  test('a blank or absent setting falls back to the default', () => {
    for (const value of [undefined, '', '   ']) {
      assert.equal(
        normalizeSubscriptionUserAgent(value),
        DEFAULT_SUBSCRIPTION_USER_AGENT,
        `blank input ${JSON.stringify(value)} must not send an empty UA`,
      )
    }
  })

  test('a configured UA is used verbatim, trimmed', () => {
    assert.equal(normalizeSubscriptionUserAgent('  clash.meta/1.0  '), 'clash.meta/1.0')
  })

  test('the schema defaults the field, so the fetcher is never built without one', () => {
    const value = IpPoolConfigSchema({}) as { subscription: { userAgent: string } }
    assert.equal(value.subscription.userAgent, DEFAULT_SUBSCRIPTION_USER_AGENT)
  })

  test('the resolver normalizes a blank value rather than persisting it', () => {
    // Persisting "" would look configured in the UI while the fetcher falls
    // back anyway, so the two would disagree about what is in effect.
    const resolved = resolveIpPoolSettings({ subscription: { urls: [], userAgent: '   ' } })
    assert.equal(resolved.subscription.userAgent, DEFAULT_SUBSCRIPTION_USER_AGENT)
  })

  test('a configured UA round-trips through the config shape', () => {
    const resolved = resolveIpPoolSettings({ subscription: { urls: [], userAgent: 'custom/9' } })
    assert.equal(resolved.subscription.userAgent, 'custom/9')
  })
})
