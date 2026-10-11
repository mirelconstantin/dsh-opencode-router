/**
 * Behavioural tests for the exit pool: selection preference, the two-tier
 * health machine, ban semantics and the index bookkeeping that keeps those
 * answers correct at pool sizes the settings page now allows.
 *
 * The selection tests pin the documented order (pinned, session stickiness,
 * healthy before unknown, fewer 429s, lower latency, then a random tiebreak
 * among equals), because the pool's memoized candidate list and its per-exit
 * ban index both sit underneath that order.
 *
 * Run with: node --test "test/*.test.ts"
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { ExitPool, gradeOf, type ExitNode, type ExitSource } from '../src/pool/pool.ts'

/** A pool whose clock the test drives, so cooldown maths needs no waiting. */
function makePool(options: { now?: () => number } = {}): { pool: ExitPool; at: (ms: number) => void } {
  let clock = 1_000_000
  const pool = new ExitPool({ now: options.now ?? (() => clock) })
  return { pool, at: (ms: number) => { clock = ms } }
}

function exit(id: string, overrides: Partial<ExitNode> = {}): ExitNode {
  return {
    id,
    protocol: 'http',
    source: 'free' as ExitSource,
    pinned: false,
    exitIP: '',
    exitLocation: '',
    latencyMs: 300,
    quality: 'S' as ExitNode['quality'],
    addedAt: 0,
    ...overrides,
  }
}

/** Add `count` healthy exits with distinct ids and ascending latency. */
function addMany(pool: ExitPool, count: number, overrides: Partial<ExitNode> = {}): void {
  for (let i = 0; i < count; i += 1) pool.add(exit(`h${i}`, { latencyMs: 100 + i, ...overrides }))
}

describe('gradeOf', () => {
  test('maps admission latency onto the documented grades', () => {
    assert.equal(gradeOf(120), 'S')
    assert.equal(gradeOf(500), 'S')
    assert.equal(gradeOf(501), 'A')
    assert.equal(gradeOf(1000), 'A')
    assert.equal(gradeOf(1001), 'B')
    assert.equal(gradeOf(2000), 'B')
    assert.equal(gradeOf(2001), 'C')
  })
})

describe('pick', () => {
  test('prefers the pinned exit while it is usable', () => {
    const { pool } = makePool()
    addMany(pool, 3)
    pool.add(exit('pinned', { pinned: true, latencyMs: 9999 }))
    pool.pin('pinned')
    assert.equal(pool.pick('s1', 'model-a'), 'pinned')
  })

  test('falls back off a pinned exit that is dead or cooling', () => {
    const { pool, at } = makePool()
    addMany(pool, 3)
    pool.add(exit('pinned', { latencyMs: 9999 }))
    pool.pin('pinned')
    pool.markDead('pinned')
    const fallback = pool.pick('s1', 'model-a')
    assert.notEqual(fallback, 'pinned')

    const second = makePool()
    addMany(second.pool, 3)
    second.pool.add(exit('pinned', { latencyMs: 9999 }))
    second.pool.pin('pinned')
    second.pool.markLimited('pinned')
    at(1_000_000)
    assert.notEqual(second.pool.pick('s2', 'model-a'), 'pinned')
  })

  test('keeps a session on its exit across requests', () => {
    const { pool } = makePool()
    addMany(pool, 5)
    const first = pool.pick('sticky', 'model-a')
    assert.notEqual(first, null)
    for (let i = 0; i < 10; i += 1) assert.equal(pool.pick('sticky', 'model-a'), first)
  })

  test('re-picks once the sticky exit is gone', () => {
    const { pool } = makePool()
    addMany(pool, 5)
    const first = pool.pick('s1', 'model-a')
    pool.remove(first!)
    assert.notEqual(pool.pick('s1', 'model-a'), first)
  })

  test('prefers a healthy exit over an unknown one', () => {
    const { pool } = makePool()
    pool.add(exit('fresh', { latencyMs: 10 }))
    pool.add(exit('proven', { latencyMs: 9000 }))
    pool.markOk('proven')
    const chosen = pool.pick('s1', 'model-a')
    assert.equal(chosen, 'proven')
  })

  test('prefers the exit with fewer consecutive 429s', () => {
    const { pool } = makePool()
    pool.add(exit('limited', { latencyMs: 10 }))
    pool.add(exit('fresh', { latencyMs: 10 }))
    pool.markLimited('limited')
    pool.markOk('fresh')
    // Both are healthy; the limited exit carries one 429, so it ranks behind.
    const chosen = pool.pick('s1', 'model-a')
    assert.notEqual(chosen, 'limited')
  })

  test('prefers the lower-latency exit when health matches', () => {
    const { pool } = makePool()
    pool.add(exit('slow', { latencyMs: 5000 }))
    pool.add(exit('quick', { latencyMs: 120 }))
    assert.equal(pool.pick('s1', 'model-a'), 'quick')
  })

  test('spreads requests across equally good exits', () => {
    const { pool } = makePool()
    // Identical health and latency, so only the tiebreak can separate them.
    for (let i = 0; i < 4; i += 1) pool.add(exit(`t${i}`, { latencyMs: 100 }))
    const seen = new Set<string>()
    for (let i = 0; i < 200; i += 1) {
      const chosen = pool.pick(`session-${i}`, 'model-a')
      if (chosen !== null) seen.add(chosen)
    }
    assert.equal(seen.size, 4, 'every tied exit should receive traffic')
  })

  test('returns null when nothing is usable', () => {
    const { pool } = makePool()
    pool.add(exit('only'))
    pool.markDead('only')
    assert.equal(pool.pick('s1', 'model-a'), null)
  })

  test('never returns an exit banned for the requested model', () => {
    const { pool } = makePool()
    addMany(pool, 4)
    for (const id of ['h0', 'h1', 'h2']) pool.markModelBanned(id, 'model-a')
    const chosen = pool.pick('s1', 'model-a')
    assert.equal(chosen, 'h3')
  })
})

describe('two-tier health', () => {
  test('a 429 cools the exit and the cooldown expires', () => {
    const { pool, at } = makePool()
    pool.add(exit('e1'))
    at(1_000_000)
    const until = pool.markLimited('e1')
    assert.ok(until > 1_000_000, 'cooldown should be in the future')
    assert.equal(pool.isUsable('e1', 'm'), false)
    at(until + 1)
    assert.equal(pool.isUsable('e1', 'm'), true)
  })

  test('repeated 429s back off exponentially up to the ceiling', () => {
    const { pool, at } = makePool()
    pool.add(exit('e1'))
    at(1_000_000)
    const first = pool.markLimited('e1')
    at(1_000_000)
    const second = pool.markLimited('e1')
    assert.ok(second - 1_000_000 > first - 1_000_000, 'the second backoff should be longer')
  })

  test('a model-level ban never cools the exit for other models', () => {
    const { pool } = makePool()
    pool.add(exit('e1'))
    pool.markModelBanned('e1', 'blocked-model')
    assert.equal(pool.isUsable('e1', 'blocked-model'), false)
    assert.equal(pool.isUsable('e1', 'other-model'), true)
  })

  test('suspicion becomes a ban only after the confirmation count', () => {
    const pool = new ExitPool({ modelBanConfirmations: 2 })
    pool.add(exit('e1'))
    assert.equal(pool.markModelSignal('e1', 'm'), 'suspect')
    assert.equal(pool.isUsable('e1', 'm'), true)
    assert.equal(pool.markModelSignal('e1', 'm'), 'banned')
    assert.equal(pool.isUsable('e1', 'm'), false)
  })

  test('a banned exit stops being picked', () => {
    const { pool } = makePool()
    pool.add(exit('bad', { latencyMs: 1 }))
    pool.add(exit('good', { latencyMs: 5000 }))
    pool.markModelBanned('bad', 'm')
    const chosen = pool.pick('s1', 'm')
    assert.notEqual(chosen, 'bad')
  })
})

describe('the per-exit ban index', () => {
  test('an exit banned for every model it serves is unavailable', () => {
    const pool = new ExitPool({ targetSize: 1 })
    pool.add(exit('e1'))
    pool.markModelBanned('e1', 'm1')
    assert.equal(pool.availableFreeCount(), 0, 'every known model is banned')
  })

  test('one unbanned pairing keeps the exit available', () => {
    const pool = new ExitPool({ targetSize: 1 })
    pool.add(exit('e1'))
    pool.markModelBanned('e1', 'm1')
    pool.markModelSignal('e1', 'm2')
    assert.equal(pool.availableFreeCount(), 1)
  })

  test('clearing a ban restores availability', () => {
    const { pool } = makePool()
    pool.add(exit('e1'))
    pool.markModelBanned('e1', 'm1')
    assert.equal(pool.isUsable('e1', 'm1'), false)
    pool.markOk('e1', 'm1')
    assert.equal(pool.isUsable('e1', 'm1'), true)
  })

  test('the index matches a fresh scan of the whole ban table', () => {
    const pool = new ExitPool({ targetSize: 500 })
    for (let i = 0; i < 60; i += 1) pool.add(exit(`e${i}`, { latencyMs: 50 + i }))
    for (let i = 0; i < 60; i += 1) {
      pool.markModelBanned(`e${i}`, 'm1')
      if (i % 3 === 0) pool.markModelSignal(`e${i}`, 'm2')
    }
    // Every exit has m1 banned, so every exit is exhausted for that model.
    for (let i = 0; i < 60; i += 1) assert.equal(pool.isUsable(`e${i}`, 'm1'), false)
    // The third without an m2 ban stays usable for m2.
    assert.equal(pool.availableFreeCount(), 20)
  })

  test('removing an exit drops its ban records', () => {
    const pool = new ExitPool()
    pool.add(exit('gone'))
    pool.markModelBanned('gone', 'm1')
    pool.remove('gone')
    // A fresh exit reusing the id must not inherit the removed ban.
    pool.add(exit('gone'))
    assert.equal(pool.isUsable('gone', 'm1'), true)
  })
})

describe('the exit-IP quota bucket', () => {
  test('two addresses sharing one exit IP are refused', () => {
    const pool = new ExitPool()
    pool.add(exit('a:1', { exitIP: '1.2.3.4' }))
    assert.equal(pool.add(exit('b:2', { exitIP: '1.2.3.4' })), false)
  })

  test('re-adding the same node with its own exit IP succeeds', () => {
    const pool = new ExitPool()
    pool.add(exit('a:1', { exitIP: '1.2.3.4' }))
    assert.equal(pool.add(exit('a:1', { exitIP: '1.2.3.4', latencyMs: 900 })), true)
    assert.equal(pool.get('a:1')?.latencyMs, 900)
  })

  test('a freed exit IP can be claimed again by a different address', () => {
    const pool = new ExitPool()
    pool.add(exit('a:1', { exitIP: '1.2.3.4' }))
    pool.remove('a:1')
    assert.equal(pool.add(exit('b:2', { exitIP: '1.2.3.4' })), true)
  })

  test('an empty exit IP never collides', () => {
    const pool = new ExitPool()
    assert.equal(pool.add(exit('a:1')), true)
    assert.equal(pool.add(exit('b:2')), true)
  })
})

describe('the four-state machine', () => {
  test('tracks the free pool against the target size', () => {
    // The bands are ratios of available exits over the target, compared with
    // a strict `<`: below 10% emergency, below 30% critical, below 95%
    // warning, otherwise healthy.
    const pool = new ExitPool({ targetSize: 20 })
    addMany(pool, 19)
    assert.equal(pool.availableFreeCount(), 19)
    assert.equal(pool.state(), 'healthy', '19/20 = 0.95 is not below 0.95')

    pool.markDead('h18')
    assert.equal(pool.availableFreeCount(), 18)
    assert.equal(pool.state(), 'warning', '18/20 = 0.90 is below 0.95')
  })

  test('the bands narrow as exits are lost', () => {
    const pool = new ExitPool({ targetSize: 20 })
    addMany(pool, 10)
    pool.markDead('h9')
    pool.markDead('h8')
    assert.equal(pool.availableFreeCount(), 8)
    assert.equal(pool.state(), 'warning', '8/20 = 0.40 is below 0.95 but above 0.30')

    pool.markDead('h7')
    pool.markDead('h6')
    assert.equal(pool.availableFreeCount(), 6)
    assert.equal(pool.state(), 'warning', '6/20 = 0.30 is not below 0.30')

    pool.markDead('h5')
    pool.markDead('h4')
    assert.equal(pool.availableFreeCount(), 4)
    assert.equal(pool.state(), 'critical', '4/20 = 0.20 is below 0.30 but not below 0.10')

    pool.markDead('h3')
    pool.markDead('h2')
    assert.equal(pool.availableFreeCount(), 2)
    assert.equal(pool.state(), 'critical', '2/20 = 0.10 is not below 0.10')

    pool.markDead('h1')
    assert.equal(pool.availableFreeCount(), 1)
    assert.equal(pool.state(), 'emergency', '1/20 = 0.05 is below 0.10')
  })

  test('a nearly empty pool is emergency', () => {
    const pool = new ExitPool({ targetSize: 100 })
    addMany(pool, 5)
    assert.equal(pool.availableFreeCount(), 5)
    assert.equal(pool.state(), 'emergency')
  })

  test('a full healthy pool is healthy', () => {
    const pool = new ExitPool({ targetSize: 4 })
    addMany(pool, 4)
    assert.equal(pool.state(), 'healthy')
  })

  test('the admission quota is the gap to the target', () => {
    const pool = new ExitPool({ targetSize: 10 })
    addMany(pool, 4)
    assert.equal(pool.admissionQuota(), 6)
  })

  test('non-free exits never count toward the target', () => {
    const pool = new ExitPool({ targetSize: 10 })
    for (let i = 0; i < 30; i += 1) pool.add(exit(`m${i}`, { source: 'manual' }))
    assert.equal(pool.freeCount(), 0)
    assert.equal(pool.admissionQuota(), 10)
  })

  test('eviction replaces the worst free exit', () => {
    const pool = new ExitPool({ targetSize: 2 })
    pool.add(exit('good', { quality: 'S', addedAt: 1 }))
    pool.add(exit('bad', { quality: 'C', addedAt: 2 }))
    pool.add(exit('also-bad', { quality: 'C', addedAt: 3 }))
    assert.equal(pool.evictWorstFree(), true)
    assert.equal(pool.has('good'), true)
    assert.equal(pool.has('also-bad'), true)
  })
})

describe('bulk behaviour', () => {
  test('picks from a large pool without losing entries', () => {
    const { pool } = makePool()
    // Identical health and latency so the tiebreak, not latency, spreads load.
    for (let i = 0; i < 1000; i += 1) pool.add(exit(`bulk${i}`, { latencyMs: 250 }))
    assert.equal(pool.snapshot().total, 1000)
    const chosen = new Set<string>()
    for (let i = 0; i < 400; i += 1) {
      const id = pool.pick(`bulk-${i}`, 'model-a')
      if (id !== null) chosen.add(id)
    }
    assert.ok(chosen.size > 1, 'many exits should share traffic')
  })

  test('a mutation invalidates the memoized candidate list', () => {
    const { pool } = makePool()
    pool.add(exit('e1'))
    assert.equal(pool.pick('s1', 'm'), 'e1')
    pool.add(exit('e2', { latencyMs: 9999 }))
    assert.equal(pool.pick('s1', 'm'), 'e1', 'the better exit still wins')
    pool.markDead('e1')
    assert.equal(pool.pick('s2', 'm'), 'e2', 'the dead exit must not be served from cache')
  })

  test('snapshot reports every source', () => {
    const pool = new ExitPool({ targetSize: 10 })
    pool.add(exit('f', { source: 'free' }))
    pool.add(exit('m', { source: 'manual' }))
    pool.add(exit('s', { source: 'subscription' }))
    pool.add(exit('g', { source: 'goproxy' }))
    const snapshot = pool.snapshot()
    assert.deepEqual(snapshot.bySource, { free: 1, manual: 1, subscription: 1, goproxy: 1 })
    assert.equal(snapshot.total, 4)
  })

  test('list reports each exit with its own bans', () => {
    const pool = new ExitPool()
    pool.add(exit('e1'))
    pool.add(exit('e2'))
    pool.markModelBanned('e1', 'm1')
    pool.markModelSignal('e2', 'm2')
    const rows = pool.list()
    assert.equal(rows.length, 2)
    assert.equal(rows.find((row) => row.id === 'e1')?.bans.length, 1)
    assert.equal(rows.find((row) => row.id === 'e2')?.bans.length, 1)
  })
})