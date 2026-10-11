/**
 * ExitPool — the exit-node table plus two-tier health and the four-state
 * refill machine (docs/ip-pool.md section 3).
 *
 * Tier 1, per-exit (ExitHealth): 429 cooldown + dead marking. Anonymous
 * quota is metered per exit IP (design.md section 3), so a 429 cools the
 * whole exit while other exits keep serving.
 *
 * Tier 2, per-(exit x model) (ModelBan): 401/403 refusals are usually
 * model-level (region blocks, delisting — see the muse/hy3 notes in
 * catalog.ts), so they ban only that pairing and never cool the exit.
 *
 * The pool is pure state: no IO, no timers. The prober, the dispatcher and
 * the refill scheduler all drive it through the mark* methods and read it
 * through pick()/snapshot(). injectable now() keeps the cooldown math
 * unit-testable.
 */

export type ExitSource = 'free' | 'manual' | 'subscription' | 'goproxy'

export interface ExitNode {
  /** host:port, unique inside the pool (the address we dial). */
  id: string
  protocol: 'http' | 'socks5'
  source: ExitSource
  /** Fixed primary exit (docs/ip-pool.md 3.6). */
  pinned: boolean
  /** Empty for pinned nodes whose admission could not read it (3.1). */
  exitIP: string
  exitLocation: string
  latencyMs: number
  quality: 'S' | 'A' | 'B' | 'C'
  addedAt: number
}

export type ExitState = 'unknown' | 'ok' | 'dead'
export type BanState = 'ok' | 'suspect' | 'banned'

interface ExitHealth {
  state: ExitState
  lastProbedAt: number
  consecutiveLimited: number
  /** 429 cooldown deadline (epoch ms); 0 = not cooling. */
  cooldownUntil: number
  /** Serial-probe lock slot: at most one in-flight probe per exit (4.1). */
  inflight: boolean
  /** Consecutive dead rechecks; eviction after deadEvictions (3.5). */
  deadStrikes: number
}

interface ModelBan {
  state: BanState
  bannedAt: number
  consecutiveFailures: number
}

export type PoolState = 'healthy' | 'warning' | 'critical' | 'emergency'

export interface PoolOptions {
  /** Free-pool target capacity (docs/ip-pool.md 3.5). Free-source nodes only. */
  targetSize?: number
  /** First 429 cooldown. */
  limitedCooldownBaseMs?: number
  /** Exponential backoff ceiling. */
  limitedCooldownMaxMs?: number
  /** Suspect -> banned after this many consecutive 401/403. */
  modelBanConfirmations?: number
  /** Dead exits are evicted after this many probe strikes (free source only). */
  deadEvictions?: number
  now?: () => number
}

/** Quality grade from admission latency (GoProxy thresholds). */
export function gradeOf(latencyMs: number): ExitNode['quality'] {
  if (latencyMs <= 500) return 'S'
  if (latencyMs <= 1000) return 'A'
  if (latencyMs <= 2000) return 'B'
  return 'C'
}

const banKey = (exitId: string, model: string) => `${exitId}\u0000${model}`

/**
 * Per-exit ban index: the models banned or suspected for one exit, kept
 * beside the node so `remove()` and `#isAvailable()` never scan the whole
 * ban table. `#bans` stays the source of truth for the (exit, model)
 * record; this maps exit id to its live set of models.
 */
interface BanIndexEntry {
  /** Models with a record in `#bans` for this exit. */
  models: Set<string>
  /** Count of models currently in state 'banned'. */
  banned: number
}

export class ExitPool {
  readonly #nodes = new Map<string, ExitNode>()
  readonly #health = new Map<string, ExitHealth>()
  readonly #bans = new Map<string, ModelBan>()
  /** exit id -> the models it has a ban record for (see BanIndexEntry). */
  readonly #banIndex = new Map<string, BanIndexEntry>()
  /** exit IP -> the one node id allowed to claim it (3.1 quota bucket). */
  readonly #exitIPIndex = new Map<string, string>()
  /**
   * The usable ids per probe model, memoized until the pool mutates or the
   * cooldown horizon can have moved a verdict. The map is bounded by the
   * probe-model count, which the settings page fixes, so it cannot grow with
   * traffic.
   */
  readonly #usableCache = new Map<string, { at: number; ids: string[] }>()
  readonly #sessionExit = new Map<string, string>()
  /** Passive-signal counters per exit (docs/ip-pool.md §4.3 被动 + IP-6 stats). */
  readonly #passive = new Map<string, { ok: number; limited: number; refused: number; dead: number; transport: number }>()
  #targetSize: number
  #cooldownBase: number
  #cooldownMax: number
  #banConfirmations: number
  #deadEvictions: number
  #now: () => number

  constructor(options: PoolOptions = {}) {
    this.#targetSize = options.targetSize ?? 20
    this.#cooldownBase = options.limitedCooldownBaseMs ?? 60_000
    this.#cooldownMax = options.limitedCooldownMaxMs ?? 30 * 60_000
    this.#banConfirmations = options.modelBanConfirmations ?? 2
    this.#deadEvictions = options.deadEvictions ?? 2
    this.#now = options.now ?? Date.now
  }

  /** Live re-apply of the free-pool target capacity (settings page, §5.1). */
  setTargetSize(value: number): void {
    this.#targetSize = Math.max(1, value)
  }

  /** The effective target capacity (diagnostics / status bridge). */
  get targetSize(): number {
    return this.#targetSize
  }

  // -- table management ------------------------------------------------------

  /** Upsert a node (admission wrote its details); returns false on duplicate
   *  exit IP for a different address — two addresses sharing one exit IP are
   *  one quota bucket and must not both live in the pool (3.1). */
  add(node: ExitNode): boolean {
    if (node.exitIP !== '' && this.#exitIPIndex.get(node.exitIP) !== undefined
      && this.#exitIPIndex.get(node.exitIP) !== node.id) return false
    this.#nodes.set(node.id, node)
    if (node.exitIP !== '') this.#exitIPIndex.set(node.exitIP, node.id)
    this.#invalidateUsable()
    if (!this.#health.has(node.id)) {
      this.#health.set(node.id, {
        state: 'unknown',
        lastProbedAt: 0,
        consecutiveLimited: 0,
        cooldownUntil: 0,
        inflight: false,
        deadStrikes: 0,
      })
    }
    return true
  }

  has(id: string): boolean {
    return this.#nodes.has(id)
  }

  get(id: string): ExitNode | undefined {
    return this.#nodes.get(id)
  }

  /** Drop a node entirely (dead eviction for free nodes, cleanup otherwise). */
  remove(id: string): void {
    const node = this.#nodes.get(id)
    if (node !== undefined && node.exitIP !== ''
      && this.#exitIPIndex.get(node.exitIP) === id) this.#exitIPIndex.delete(node.exitIP)
    this.#nodes.delete(id)
    this.#health.delete(id)
    this.#passive.delete(id)
    this.#banIndex.delete(id)
    for (const model of this.#banModels(id)) this.#bans.delete(banKey(id, model))
    for (const [session, exitId] of this.#sessionExit) {
      if (exitId === id) this.#sessionExit.delete(session)
    }
    this.#clearPinnedIf(id)
    this.#invalidateUsable()
  }

  /** The models that currently hold a ban record for one exit. */
  #banModels(id: string): Set<string> {
    const entry = this.#banIndex.get(id)
    if (entry !== undefined) return entry.models
    // Cold path only (an exit with bans but no index, from a table built
    // before this index existed). Rebuilt lazily so old state still reads.
    const models = new Set<string>()
    const prefix = `${id}\u0000`
    for (const key of this.#bans.keys()) {
      if (key.startsWith(prefix)) models.add(key.slice(prefix.length))
    }
    return models
  }

  /**
   * Record one (exit, model) ban entry and keep the per-exit index in step.
   * @param id - the exit id.
   * @param model - the probe model the pairing belongs to.
   * @param ban - the new record.
   */
  #setBan(id: string, model: string, ban: ModelBan): void {
    let entry = this.#banIndex.get(id)
    if (entry === undefined) {
      entry = { models: new Set(), banned: 0 }
      this.#banIndex.set(id, entry)
    }
    const wasBanned = this.#bans.get(banKey(id, model))?.state === 'banned'
    entry.models.add(model)
    if (ban.state === 'banned' && !wasBanned) entry.banned += 1
    else if (ban.state !== 'banned' && wasBanned) entry.banned -= 1
    this.#bans.set(banKey(id, model), ban)
    // Every ban write lands here, so the memoized candidate lists go here too.
    this.#invalidateUsable()
  }

  /** Disable without dropping (dead manual/subscription/goproxy nodes, 3.5). */
  markDead(id: string): void {
    const health = this.#health.get(id)
    if (!health) return
    health.state = 'dead'
    health.inflight = false
    this.#invalidateUsable()
  }

  #clearPinnedIf(id: string): void {
    if (this.pinnedId === id) this.pinnedId = ''
  }

  pinnedId = ''

  /** Pin a node (docs/ip-pool.md 3.6); unpinning any previous pinned node. */
  pin(id: string): boolean {
    if (!this.#nodes.has(id)) return false
    this.pinnedId = id
    return true
  }

  unpin(): void {
    this.pinnedId = ''
  }

  // -- probe locking (4.1: serial per exit) -----------------------------------

  /** Try to take the exit's serial-probe slot; false when already taken. */
  takeProbeLock(id: string): boolean {
    const health = this.#health.get(id)
    if (!health || health.inflight) return false
    health.inflight = true
    return true
  }

  releaseProbeLock(id: string): void {
    const health = this.#health.get(id)
    if (health) health.inflight = false
  }

  // -- passive & probe signals (rule table 4.2) --------------------------------

  markOk(id: string, model?: string): void {
    const health = this.#health.get(id)
    if (health) {
      health.state = 'ok'
      health.lastProbedAt = this.#now()
      health.consecutiveLimited = 0
      health.cooldownUntil = 0
      health.deadStrikes = 0
    }
    if (model !== undefined) {
      this.#setBan(id, model, { state: 'ok', bannedAt: 0, consecutiveFailures: 0 })
    }
    this.#invalidateUsable()
  }

  /** 429: exit-level cooldown with exponential backoff (3.2 / 4.6). */
  markLimited(id: string): number {
    const health = this.#health.get(id)
    if (!health) return 0
    health.consecutiveLimited += 1
    health.state = 'ok'
    const backoff = Math.min(
      this.#cooldownBase * 2 ** (health.consecutiveLimited - 1),
      this.#cooldownMax,
    )
    health.cooldownUntil = this.#now() + backoff
    this.#invalidateUsable()
    return health.cooldownUntil
  }

  /** Deterministic refusal (upstream RegionError: region blocks are a
   *  property of the exit, not transient noise) — ban the pairing at once. */
  markModelBanned(id: string, model: string): void {
    this.#setBan(id, model, { state: 'banned', bannedAt: this.#now(), consecutiveFailures: this.#banConfirmations })
  }

  /** 401/403: model-level suspicion; banned after N consecutive (3.2). */
  markModelSignal(id: string, model: string): BanState {
    const key = banKey(id, model)
    const current = this.#bans.get(key) ?? { state: 'ok' as BanState, bannedAt: 0, consecutiveFailures: 0 }
    current.consecutiveFailures += 1
    if (current.consecutiveFailures >= this.#banConfirmations && current.state !== 'banned') {
      current.state = 'banned'
      current.bannedAt = this.#now()
    } else if (current.state !== 'banned') {
      current.state = 'suspect'
    }
    this.#setBan(id, model, current)
    return current.state
  }

  /** Transport failure / 5xx / probe timeout: dead, with free-source eviction
   *  after repeated strikes (3.5). Returns true when the node was evicted. */
  markDeadStrike(id: string): boolean {
    const node = this.#nodes.get(id)
    const health = this.#health.get(id)
    if (!node || !health) return false
    health.state = 'dead'
    health.inflight = false
    health.deadStrikes += 1
    if (node.source === 'free' && health.deadStrikes >= this.#deadEvictions) {
      this.remove(id)
      return true
    }
    // Kept but not evicted: still no longer a candidate.
    this.#invalidateUsable()
    return false
  }

  /** Death from a mid-flight stream (no retry path): same strike accounting. */
  markStreamFailure(id: string, kind: '429' | 'model', model?: string): void {
    if (kind === '429') {
      this.markLimited(id)
      this.#countPassive(id, 'limited')
    } else if (model !== undefined) {
      this.markModelSignal(id, model)
      this.#countPassive(id, 'refused')
    }
  }

  /**
   * Passive signal from a REAL request outcome (docs/ip-pool.md §4.2 rule
   * table, §4.3 被动 row): one response header read at the routing layer,
   * applied to the two-tier health exactly like a probe would. Returns the
   * classification for diagnostics.
   */
  recordPassive(id: string, statusCode: number, model: string, regionBlocked = false): 'ok' | 'limited' | 'refused' | 'dead' {
    if (!this.#nodes.has(id)) return 'ok'
    if (statusCode >= 200 && statusCode < 300) {
      this.markOk(id, model)
      this.#countPassive(id, 'ok')
      return 'ok'
    }
    if (statusCode === 429) {
      this.markLimited(id)
      this.#countPassive(id, 'limited')
      return 'limited'
    }
    if (statusCode === 401 || statusCode === 403) {
      // RegionError bodies are deterministic region blocks — a second sample
      // adds nothing, so ban the (exit, model) pairing immediately (docs 4.2).
      if (regionBlocked) this.markModelBanned(id, model)
      else this.markModelSignal(id, model)
      this.#countPassive(id, 'refused')
      return 'refused'
    }
    // 5xx: count into the dead bucket for diagnostics, but DO NOT strike the
    // exit dead. Live-observed 2026-09-09: upstream 500s are often the MODEL
    // failing behind a healthy exit (muse without contributor access answers
    // 500 through every exit) — one strike used to mark the exit dead, the
    // single-exit pool then picked null, and ALL traffic silently fell back
    // direct while the pool looked enabled. Exit liveness stays the
    // transport layer's call (sentinel/onResponseError); recovery for a
    // 5xx-flapping exit is the adapter rotate loop (5xx is in its set).
    this.#countPassive(id, 'dead')
    return 'dead'
  }

  /** Transport-level failure of a real request (connection died mid-flight). */
  recordPassiveTransport(id: string): void {
    if (!this.#nodes.has(id)) return
    this.markDeadStrike(id)
    this.#countPassive(id, 'transport')
  }

  /** Drop the session's sticky exit when its exit degraded (§3.3). */
  rerouteSession(session: string): void {
    this.#sessionExit.delete(session)
  }

  /** The session's current sticky exit, if any (adapter-side 403 bookkeeping:
   *  the dispatcher recorded the refusal against this exit). */
  exitOfSession(session: string): string | null {
    return this.#sessionExit.get(session) ?? null
  }

  #countPassive(id: string, kind: 'ok' | 'limited' | 'refused' | 'dead' | 'transport'): void {
    const bucket = this.#passive.get(id) ?? { ok: 0, limited: 0, refused: 0, dead: 0, transport: 0 }
    if (kind === 'limited') bucket.limited += 1
    else if (kind === 'refused') bucket.refused += 1
    else if (kind === 'dead') bucket.dead += 1
    else if (kind === 'transport') bucket.transport += 1
    else bucket.ok += 1
    this.#passive.set(id, bucket)
  }

  /** Passive-signal counters for one exit (status bridge, IP-6). */
  passiveStats(id: string): { ok: number; limited: number; refused: number; dead: number; transport: number } {
    return { ...(this.#passive.get(id) ?? { ok: 0, limited: 0, refused: 0, dead: 0, transport: 0 }) }
  }

  // -- selection (3.3) ---------------------------------------------------------

  isUsable(id: string, model: string): boolean {
    const health = this.#health.get(id)
    if (!health || health.state === 'dead') return false
    if (health.cooldownUntil > this.#now()) return false
    const ban = this.#bans.get(banKey(id, model))
    return ban?.state !== 'banned'
  }

  /**
   * Pick the exit for one upstream request. Pinned wins while usable (3.6);
   * the rotation pool then prefers session stickiness, health, fewer
   * cooldowns and lower latency with a same-tier shuffle. Pure; no IO.
   *
   * The comparator's last resort is a coin flip, so it is not a consistent
   * ordering and the winner among tied exits is whatever V8's sort happens to
   * leave in slot 0. Replacing the sort with a linear best-so-far scan would
   * therefore change which tied exit gets the request, so the sort stays and
   * the repeated work around it is removed instead: building the usable list
   * costs one `isUsable` call per exit, so it is memoized and invalidated on
   * every mutation instead of being rebuilt per request.
   */
  pick(session: string, model: string): string | null {
    if (this.pinnedId !== '' && this.isUsable(this.pinnedId, model)) return this.pinnedId

    const last = this.#sessionExit.get(session)
    if (last !== undefined && this.isUsable(last, model)) return last

    const usable = this.#usableFor(model)
    if (usable.length === 0) return null
    const health = (id: string) => this.#health.get(id)!
    const node = (id: string) => this.#nodes.get(id)!
    // The tiebreak draw stays per comparison, so the spread over equally good
    // exits matches the pre-cache behaviour rather than biasing the array
    // order toward whichever ids happened to be re-sorted.
    usable.sort((left, right) => {
      const a = health(left)
      const b = health(right)
      const stateRank = (h: ExitHealth) => (h.state === 'ok' ? 0 : 1)
      const byState = stateRank(a) - stateRank(b)
      if (byState !== 0) return byState
      const byLimited = a.consecutiveLimited - b.consecutiveLimited
      if (byLimited !== 0) return byLimited
      const byLatency = node(left).latencyMs - node(right).latencyMs
      if (byLatency !== 0) return byLatency
      return Math.random() < 0.5 ? -1 : 1
    })
    const chosen = usable[0]
    if (chosen === undefined) return null
    this.#sessionExit.set(session, chosen)
    return chosen
  }

  /**
   * The usable ids for one model, in `#nodes` insertion order, memoized until
   * the pool mutates. Insertion order matches the filter the uncached path
   * used, so the sort still sees the same input sequence.
   *
   * Cooldown expiry is a function of the clock rather than a mutation, so a
   * cached list is also retired once the clock has moved far enough for any
   * verdict inside it to have flipped. One extra second of margin keeps a
   * verdict that just expired from being served from the cache; every caller
   * therefore sees what an uncached `isUsable` would report.
   */
  #usableFor(model: string): string[] {
    const now = this.#now()
    const cached = this.#usableCache.get(model)
    if (cached !== undefined && cached.at + this.#cooldownMax + 1_000 > now) return cached.ids
    const ids: string[] = []
    for (const id of this.#nodes.keys()) {
      if (this.isUsable(id, model)) ids.push(id)
    }
    this.#usableCache.set(model, { at: now, ids })
    return ids
  }

  /** Drop every memoized candidate list; the pool shape or a verdict changed. */
  #invalidateUsable(): void {
    this.#usableCache.clear()
  }

  /** Drop the session's sticky exit (cooldown/dead/ban broke it). */
  breakStickySession(session: string): void {
    this.#sessionExit.delete(session)
  }

  // -- four-state machine (3.5) -------------------------------------------------

  /** Usable = not dead, not cooling, and not banned for every probe model —
   *  approximation: nodes banned for all their known models count as
   *  unusable; with no ban data they stay usable (they are only banned for
   *  specific models, which the caller's model already filters). */
  #isAvailable(id: string): boolean {
    const health = this.#health.get(id)
    if (!health || health.state === 'dead') return false
    if (health.cooldownUntil > this.#now()) return false
    // A node with at least one banned pairing and no healthy pairing for any
    // model it serves is effectively exhausted: its ban index lists every
    // model with a record, so "all banned" is a count comparison rather than
    // a scan of the whole ban table.
    const entry = this.#banIndex.get(id)
    if (entry !== undefined) return !(entry.models.size > 0 && entry.banned === entry.models.size)
    // No index entry means no ban record was ever written for this exit.
    for (const model of this.#banModels(id)) {
      if (this.#bans.get(banKey(id, model))?.state !== 'banned') return true
    }
    return this.#banModels(id).size === 0
  }

  /** Count usable free-source nodes toward the refill thresholds. */
  availableFreeCount(): number {
    let count = 0
    for (const node of this.#nodes.values()) {
      if (node.source === 'free' && this.#isAvailable(node.id)) count += 1
    }
    return count
  }

  /** Determine the pool state over the free-source pool (3.5 thresholds). */
  state(): PoolState {
    if (this.#targetSize <= 0) return 'healthy'
    const available = this.availableFreeCount()
    const ratio = available / this.#targetSize
    if (ratio < 0.1) return 'emergency'
    if (ratio < 0.3) return 'critical'
    if (ratio < 0.95) return 'warning'
    return 'healthy'
  }

  /** Admission quota for a refill round: how many free nodes to accept. */
  admissionQuota(): number {
    return Math.max(0, this.#targetSize - this.availableFreeCount())
  }

  /** Replace the worst free node (C grade / oldest) to make room (3.5). */
  evictWorstFree(): boolean {
    let worst: ExitNode | null = null
    for (const node of this.#nodes.values()) {
      if (node.source !== 'free') continue
      if (!worst) {
        worst = node
        continue
      }
      const gradeRank: Record<ExitNode['quality'], number> = { S: 0, A: 1, B: 2, C: 3 }
      const byGrade = gradeRank[node.quality] - gradeRank[worst.quality]
      if (byGrade > 0 || (byGrade === 0 && node.addedAt < worst.addedAt)) worst = node
    }
    if (!worst) return false
    this.remove(worst.id)
    return true
  }

  /** Is the pool full for free-source admission? (pinned and non-free nodes
   *  never count against the target, 3.5/3.6.) */
  isFreeFull(): boolean {
    return this.freeCount() >= this.#targetSize
  }

  freeCount(): number {
    let count = 0
    for (const node of this.#nodes.values()) if (node.source === 'free') count += 1
    return count
  }

  // -- diagnostics ------------------------------------------------------------

  snapshot(): {
    state: PoolState
    total: number
    bySource: Record<ExitSource, number>
    availableFree: number
    pinned: string
  } {
    const bySource: Record<ExitSource, number> = { free: 0, manual: 0, subscription: 0, goproxy: 0 }
    for (const node of this.#nodes.values()) bySource[node.source] += 1
    return {
      state: this.state(),
      total: this.#nodes.size,
      bySource,
      availableFree: this.availableFreeCount(),
      pinned: this.pinnedId,
    }
  }

  list(): Array<ExitNode & { health: ExitHealth; bans: Array<{ model: string; ban: ModelBan }> }> {
    const out: Array<ExitNode & { health: ExitHealth; bans: Array<{ model: string; ban: ModelBan }> }> = []
    for (const [id, node] of this.#nodes) {
      const health = this.#health.get(id)!
      const bans: Array<{ model: string; ban: ModelBan }> = []
      // The per-exit index gives this exit's models directly; the fallback
      // covers a ban written before the index was rebuilt.
      for (const model of this.#banModels(id)) {
        const ban = this.#bans.get(banKey(id, model))
        if (ban !== undefined) bans.push({ model, ban })
      }
      out.push({ ...node, health, bans })
    }
    return out
  }
}
