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
import { ExitPool, gradeOf, nextUtcMidnight, type ExitNode, type ExitSource } from '../src/pool/pool.ts'

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

  test('repeated 429s never shorten the daily cooldown', () => {
    // The exponential ladder is now only a FLOOR under the real reset, so a
    // second 429 inside the same day cannot pull the deadline earlier.
    const start = Date.UTC(2026, 0, 1, 12, 0, 0)
    const { pool, at } = makePool()
    at(start)
    pool.add(exit('e1'))
    const first = pool.markLimited('e1')
    at(start + 1000)
    const second = pool.markLimited('e1')
    assert.ok(second >= first, 'a repeat 429 must not shorten the wait')
    assert.equal(second, first, 'the same UTC day yields the same deadline')
    // The 60s backoff floor applies near the day boundary, where the reset
    // is only 500ms away: waiting the extra 59.5s is correct (it avoids a
    // re-probe against an upstream that has not reset yet).
    const near = makePool()
    near.at(86_400_000 - 500)
    near.pool.add(exit('e2'))
    const until = near.pool.markLimited('e2')
    assert.equal(until, 86_400_000 - 500 + 60_000, 'the 60s ladder floor wins near midnight')
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

  test('token tallies accumulate per exit, split by kind', () => {
    // The picker's Tokens column answers "what did this proxy cost me", and
    // cacheRead is kept separate because a cached prefix is billed far below
    // a fresh one — folding it into `input` would hide the number that says
    // whether the proxy is carrying a long conversation cheaply.
    const pool = new ExitPool()
    pool.add(exit('e1'))
    assert.equal(pool.usageOf('e1'), null)

    pool.recordRouted('e1', 1_000)
    pool.recordTokens('e1', { input: 1_000, output: 200, cacheRead: 300, cacheWrite: 50, requests: 1 })
    pool.recordRouted('e1', 2_000)
    pool.recordTokens('e1', { input: 500, output: 100, cacheRead: 700, cacheWrite: 0, requests: 1 })

    const usage = pool.usageOf('e1')!
    assert.deepEqual(usage.tokens, {
      input: 1_500,
      output: 300,
      cacheRead: 1_000,
      cacheWrite: 50,
      requests: 2,
    })
    assert.equal(usage.uses, 2, 'each dispatch counted once, each billing folded in')
  })

  test('a token tally for an exit that never routed is ignored', () => {
    // recordTokens must not conjure a usage row: `firstUsedAt` would be 0 and
    // the tally would disagree with the use count beside it.
    const pool = new ExitPool()
    pool.add(exit('e1'))
    pool.recordTokens('e1', { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, requests: 1 })
    assert.equal(pool.usageOf('e1'), null)
  })

  test('a token tally is a copy, not a handle on the pool state', () => {
    const pool = new ExitPool()
    pool.add(exit('e1'))
    pool.recordRouted('e1', 1_000)
    pool.recordTokens('e1', { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, requests: 1 })
    const first = pool.usageOf('e1')!
    first.tokens!.input = 999_999
    assert.equal(pool.usageOf('e1')?.tokens?.input, 10, 'a caller cannot corrupt the tally')
  })

  test('usage tallies ride the same edge as the readout', () => {
    // The GUI's picker shows "3 uses · 2m ago" per exit, so the counters must
    // count the requests that actually routed, not the ones pick() considered.
    const pool = new ExitPool()
    pool.add(exit('e1'))
    pool.add(exit('e2'))
    assert.equal(pool.usageOf('e1'), null, 'an unused exit has no usage row')

    pool.recordRouted('e1', 1_000)
    const one = pool.usageOf('e1')!
    assert.equal(one.uses, 1)
    assert.equal(one.lastUsedAt, 1_000)
    assert.equal(one.firstUsedAt, 1_000)
    assert.equal(one.tokens, undefined, 'a dispatch with no finished usage bills nothing yet')

    pool.recordRouted('e1', 5_000)
    const two = pool.usageOf('e1')!
    assert.equal(two.uses, 2)
    assert.equal(two.lastUsedAt, 5_000)
    assert.equal(two.firstUsedAt, 1_000, 'firstUsedAt stays the first dispatch')
    assert.equal(pool.usageOf('e2'), null, 'an exit nobody routed through stays unused')

    // The copy handed out is a copy: a caller cannot corrupt the tally.
    const copy = pool.usageOf('e1')!
    copy.uses = 999
    assert.equal(pool.usageOf('e1')?.uses, 2)
  })

  test('a 429 cools the exit until the daily bucket resets', () => {
    // Zen meters the free lane per-IP per-UTC-day and its retry-after is the
    // seconds to the next UTC midnight. The old ladder guessed 1m→2m→4m and
    // would re-probe an exhausted exit ~28 times inside a window where the
    // upstream can only refuse again.
    const start = Date.UTC(2026, 0, 1, 12, 0, 0) // noon, 12h from midnight
    const { pool, at } = makePool()
    at(start)
    pool.add(exit('e1'))
    pool.markOk('e1')

    const until = pool.markLimited('e1')
    assert.equal(until, start + 12 * 3_600_000, 'cools until midnight UTC, not 1 minute')

    // Well past the old 30-minute cap: the exit must still be unusable.
    at(start + 40 * 60_000)
    assert.equal(pool.isUsable('e1', 'm'), false)

    // One second after the reset it comes back.
    at(until + 1)
    assert.equal(pool.isUsable('e1', 'm'), true)
  })

  test('an upstream retry-after wins over the local backoff', () => {
    // The gateway states the real deadline; a longer one must be believed.
    const start = Date.UTC(2026, 0, 1, 23, 0, 0) // 1h from midnight
    const { pool, at } = makePool()
    at(start)
    pool.add(exit('e1'))
    pool.markOk('e1')

    // Upstream says 3h, far longer than the local guess (1h to midnight).
    const until = pool.markLimited('e1', 3 * 3_600_000)
    assert.equal(until, start + 3 * 3_600_000, 'the upstream deadline is used verbatim')
    at(until + 1)
    assert.equal(pool.isUsable('e1', 'm'), true)
  })

  test('nextUtcMidnight floors at 1s', () => {
    // A call in the last millisecond of the day would otherwise produce a
    // zero wait and immediately re-probe an exhausted exit.
    const DAY = 86_400_000
    assert.equal(nextUtcMidnight(0), DAY)
    assert.equal(nextUtcMidnight(DAY / 2), DAY / 2)
    assert.equal(nextUtcMidnight(DAY - 1), 1000)
    assert.equal(nextUtcMidnight(DAY), DAY)
  })

  test('bypass routes nothing, and outranks a pinned exit', () => {
    // "No proxy" is the user saying stop routing, so it must win over every
    // preference pick() has — including a pin left over from earlier.
    const { pool } = makePool()
    pool.add(exit('e1'))
    pool.add(exit('e2'))
    pool.markOk('e1')
    pool.markOk('e2')

    assert.equal(pool.bypass, false, 'routing is on by default')
    assert.notEqual(pool.pick('s1', 'm'), null)

    pool.setBypass(true)
    assert.equal(pool.bypass, true)
    assert.equal(pool.pick('s1', 'm'), null, 'bypass sends every request direct')

    // A pin must not resurrect routing while bypass is on.
    pool.pin('e1')
    assert.equal(pool.pick('s1', 'm'), null, 'a pin does not override bypass')

    pool.setBypass(false)
    assert.equal(pool.pick('s1', 'm'), 'e1', 'clearing bypass restores the pin')
  })

  test('the current-proxy readout tracks the last routed exit', () => {
    // The GUI reads this, so it must survive the case pick() cannot report:
    // a pinned exit returns before the sticky write, and a rotation leaves
    // the previous session binding behind.
    const pool = new ExitPool()
    assert.equal(pool.lastRoutedExit(), null)

    pool.add(exit('e1'))
    pool.add(exit('e2'))
    pool.recordRouted('e1', 100)
    assert.deepEqual(pool.lastRoutedExit(), { exitId: 'e1', at: 100 })

    // A pinned exit still answers, because the dispatcher records it.
    pool.pin('e2')
    pool.recordRouted('e2', 200)
    assert.deepEqual(pool.lastRoutedExit(), { exitId: 'e2', at: 200 })

    // A later dispatch wins, so a rotation is reflected rather than lagged.
    pool.recordRouted('e1', 300)
    assert.deepEqual(pool.lastRoutedExit(), { exitId: 'e1', at: 300 })
  })
})