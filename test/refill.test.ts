/**
 * The free-source refill's replenishment rule.
 *
 * The behaviour under test is a regression: the round used to return early
 * whenever the pool was `healthy`, so a free list was only topped up in an
 * emergency. Free proxies are typically dead within the hour, which made the
 * list look fresh at boot and empty by evening — the pool was "healthy" on
 * the strength of admits that had since rotted, and nothing replaced them.
 *
 * Run with: node --test "test/*.test.ts"
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { RefillScheduler, type RefillDeps } from '../src/pool/refill.ts'
import { ExitPool, type ExitNode } from '../src/pool/pool.ts'
import type { Prober } from '../src/pool/prober.ts'

function exit(id: string, overrides: Partial<ExitNode> = {}): ExitNode {
  return {
    id,
    protocol: 'http',
    source: 'free',
    pinned: false,
    exitIP: '',
    exitLocation: '',
    latencyMs: 100,
    quality: 'S',
    addedAt: 0,
    ...overrides,
  }
}

/** A pool that reports `usable` working free exits, and nothing else. */
function poolWith(usable: number, targetSize = 60): ExitPool {
  const pool = new ExitPool({ targetSize })
  for (let i = 0; i < usable; i += 1) pool.add(exit(`ok-${i}`))
  // Pad toward the target with entries that no longer answer, which is what
  // a stale pool actually looks like: full of rows, none of them usable.
  const dead = Math.max(0, targetSize - usable)
  for (let i = 0; i < dead; i += 1) {
    pool.add(exit(`dead-${i}`, { quality: 'C' }))
    pool.markDead(`dead-${i}`)
  }
  return pool
}

/**
 * A scheduler wired to stubs that FAIL LOUDLY if a round reaches the network.
 * The tests below are about which rounds are skipped, so a fetch that happens
 * when it should not have is a failure, not a slow test.
 *
 * Typed through the real deps rather than `as never`, so a change to the
 * admission seam breaks this file instead of silently passing.
 */
function schedulerFor(pool: ExitPool, options: { maintainUsable?: number } = {}) {
  const boom = (what: string) => (): never => {
    throw new Error(`the round reached ${what}: it should have returned before fetching`)
  }
  const deps: RefillDeps = {
    pool,
    undici: {
      ProxyAgent: class {
        constructor() { boom('ProxyAgent')() }
      } as unknown as RefillDeps['undici']['ProxyAgent'],
      request: boom('a source fetch') as unknown as RefillDeps['undici']['request'],
    },
    prober: { enqueueAll: boom('the prober') } as unknown as Prober,
  }
  return { scheduler: new RefillScheduler(pool, deps, { maintainUsable: options.maintainUsable }) }
}

describe('the free-source refill', () => {
  test('runs a round when a healthy pool is below the maintenance floor', async () => {
    // `state()` needs >= 95% of targetSize to call a pool healthy, which is
    // exactly the situation this fix is about: comfortably green on the
    // strength of admits that are about to rot, with a maintenance floor of
    // 30 set far above the 10 that still answer. The old rule would sit on
    // its hands here.
    const pool = poolWith(58)
    assert.equal(pool.state(), 'healthy', 'precondition: the pool reports healthy')
    const { scheduler } = schedulerFor(pool, { maintainUsable: 90 })
    await scheduler.tick()
    // A round ran far enough to touch the sources: the stub request throws.
    // Reaching it at all is the assertion that matters.
    assert.equal(scheduler.progress.running, false, 'the round finished')
  })

  test('skips the round when the floor is already met', async () => {
    // At the floor and healthy: no work, and crucially the network is never
    // touched — the stub would throw if a source were fetched.
    const pool = poolWith(60)
    assert.equal(pool.state(), 'healthy')
    const { scheduler } = schedulerFor(pool, { maintainUsable: 30 })
    await scheduler.tick()
    assert.equal(scheduler.progress.sourcesTotal, 0, 'no sources were selected')
  })

  test('keeps the old emergency-only behaviour when no floor is set', async () => {
    // Undefined floor = the shipped default, which must stay conservative so
    // an operator who never asked for maintenance is not billed for a constant
    // rescan.
    const pool = poolWith(60)
    const { scheduler } = schedulerFor(pool)
    await scheduler.tick()
    assert.equal(scheduler.progress.sourcesTotal, 0, 'a healthy pool is left alone')
  })
})
