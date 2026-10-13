/**
 * The composer chip's readout logic, kept out of the component so it can be
 * tested directly.
 *
 * The rule that matters is the ordering: a routing decision the user has just
 * made (a pin, or "no proxy") outranks the last completed request. Without
 * it, pinning an exit leaves the label reading "direct" until you send a
 * message — the "I clicked it and nothing happened" report.
 */

/** The token bill for one request, split as the provider reports it. */
interface TokenUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  requests: number
}

/** What one exit has carried in this process. */
interface ExitUsage {
  uses: number
  lastUsedAt: number
  firstUsedAt: number
  /** Absent until a request finishes; a dispatch that dies bills nothing. */
  tokens?: TokenUsage
}

/** The part of the /status view this chip reads (mirrors bridge.ts). */
export interface StatusView {
  enabled: boolean
  deferredReason: string
  currentExit: { exitId: string; at: number } | null
  pinned: { id: string; strict: boolean } | null
  /** The user chose "no proxy" (bridge /pin mode 'direct'). */
  bypass: boolean
  exits: Array<{
    id: string
    exitIP: string
    exitLocation: string
    latencyMs: number
    state: 'unknown' | 'ok' | 'dead'
    cooling: boolean
    /** The pool's own pin flag, which is what the pin button writes. */
    pinnedFlag: boolean
    usage: ExitUsage | null
  }>
}

/**
 * What the chip renders: which mode it is in, and the exit it names.
 *
 * There is deliberately no "absent" member. An earlier shape had one for a
 * disabled pool, and it made the chip vanish the moment the pool was switched
 * off — removing the only control that could switch it back on. A reading from
 * the bridge already proves this plugin is serving, so there is nothing left
 * for such a state to mean.
 */
export type ChipState =
  | { mode: 'deferred'; reason: string }
  | { mode: 'direct'; forced: boolean }
  | { mode: 'proxy'; exitId: string; label: string; latencyMs: number; ok: boolean; pinned: boolean }

/** The short name for an exit: its location when admission read one, else
 *  the address itself. Never the exit IP, which is the one field the card
 *  keeps for the exit table. */
export function exitLabel(exit: StatusView['exits'][number] | undefined, exitId: string): string {
  if (exit === undefined) return exitId
  if (exit.exitLocation !== '') return exit.exitLocation
  if (exit.exitIP !== '') return exit.exitIP
  return exitId
}

function proxyState(status: StatusView, exitId: string, pinned: boolean): ChipState {
  const exit = status.exits.find((row) => row.id === exitId)
  return {
    mode: 'proxy',
    exitId,
    label: exitLabel(exit, exitId),
    latencyMs: exit?.latencyMs ?? 0,
    ok: exit !== undefined && exit.state === 'ok' && !exit.cooling,
    pinned,
  }
}

/** What the chip shows for one /status reading. */
export function resolve(status: StatusView): ChipState {
  if (status.deferredReason !== '') return { mode: 'deferred', reason: status.deferredReason }
  // A chosen "no proxy" outranks everything, including a pin: the chip must
  // reflect the routing decision the user just made, not a stale exit.
  if (status.bypass) return { mode: 'direct', forced: true }
  // A pin is the routing decision for the *next* request, so it wins over the
  // last completed one: pinning has to update the label immediately. The last
  // request remains the fallback, so the readout still tracks real traffic
  // whenever nothing is pinned.
  if (status.pinned !== null) return proxyState(status, status.pinned.id, true)
  const current = status.currentExit
  // Not chosen, just nothing routed yet.
  //
  // A DISABLED pool is still 'direct', not 'off': the chip is how the pool is
  // turned back on, so hiding it here would remove the only control that
  // brings routing back. 'off' is reserved for "this plugin is not serving
  // here at all" — the bridge answered, so that is never true.
  if (current === null) return { mode: 'direct', forced: false }
  return proxyState(status, current.exitId, false)
}

/**
 * A token count in the compact form the picker uses: exact below 1k, then K
 * and M. Matches the ConversationMeter's own compact-number style so the two
 * panels read as one product.
 */
export function formatTokenCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value < 1_000) return String(Math.round(value))
  if (value < 1_000_000) {
    const k = value / 1_000
    return `${k >= 100 ? Math.round(k) : Math.round(k * 10) / 10}K`
  }
  const m = value / 1_000_000
  return `${m >= 100 ? Math.round(m) : Math.round(m * 10) / 10}M`
}

/** The total tokens an exit carried, across every finished request. */
export function totalTokens(usage: ExitUsage | null): number {
  if (usage?.tokens === undefined) return 0
  const t = usage.tokens
  return t.input + t.output + t.cacheRead + t.cacheWrite
}

/** The share of an exit's traffic that came from the prompt cache, 0..1.
 *  A high ratio means the exit is carrying long conversations cheaply. */
export function cacheRatio(usage: ExitUsage | null): number {
  if (usage?.tokens === undefined) return 0
  const t = usage.tokens
  const total = t.input + t.output + t.cacheRead + t.cacheWrite
  return total === 0 ? 0 : t.cacheRead / total
}
