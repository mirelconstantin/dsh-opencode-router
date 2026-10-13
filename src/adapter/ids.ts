import { createHash, randomBytes } from 'node:crypto'

/**
 * Port of agent/internal/ids (opencode2api ids.go, verbatim semantics):
 * stable session/project ids derived from the conversation's first user turn,
 * and a per-request random id. The upstream sees CLI-identical correlation
 * headers built from these (zen-adapter.ts).
 */

export interface RequestIDs {
  session: string
  request: string
  project: string
  parentSession: string
}

/** sha256("prefix\0value") truncated to 12 bytes: stable, non-reversible. */
export function stableID(prefix: string, value: string): string {
  const sum = createHash('sha256').update(prefix + '\x00' + value).digest()
  return `${prefix}_${sum.subarray(0, 12).toString('hex')}`
}

export function randomID(prefix: string, size: number): string {
  return `${prefix}_${randomBytes(size).toString('hex')}`
}

export function firstString(...values: Array<string | undefined>): string {
  for (const value of values) {
    const trimmed = value?.trim()
    if (trimmed) return trimmed
  }
  return ''
}

/**
 * The conversation signal: JSON of the first user message's content. Using the
 * first user turn keeps a multi-turn conversation stable as its history grows
 * while separating conversations with different beginnings (ids.go:59-76).
 */
export function conversationSeed(messages: Array<{ role: string; content: unknown }>): string {
  for (const message of messages) {
    if (message.role !== 'user') continue
    const encoded = JSON.stringify(message.content ?? null)
    if (encoded !== 'null' && encoded.length > 0) return encoded
  }
  return ''
}

/**
 * Derive the correlation ids for one upstream request. In adapter mode there
 * are no inbound opencode headers, so the seed is the conversation itself.
 */
export function deriveRequestIDs(messages: Array<{ role: string; content: unknown }>): RequestIDs {
  let signal = conversationSeed(messages)
  if (signal === '' || signal === '{}') signal = randomID('fallback', 16)
  return {
    session: canonicalSessionID(signal),
    request: randomID('req', 16),
    project: stableID('prj', 'opencode2dsh:default-project'),
    parentSession: '',
  }
}

/**
 * OpenCode's canonical session shape: "ses_" + 12 lowercase hex timestamp
 * characters + 14 Base62 characters. Since 2026-09-16 the Zen free tier
 * rejects any other session shape with 403 FreeTierError ("free tier can
 * only be used from within OpenCode") — the plain User-Agent gate stopped
 * being sufficient (upstream fix: jasonxu114514/opencode2api 8185202).
 * Live-probed 2026-09-18: the gate has a second, body-shape half (streaming
 * + bash/read tools, adapter/messages.ts); both must pass.
 * Live-probed 2026-10-13: the 12 hex characters must decode as OpenCode's
 * ~(ms * 0x1000 + counter) stamp. A digest-derived prefix is the sole reason a
 * fully gate-shaped request still 403s (9router#4780, opencode2dsh#62 — the
 * 403 reaches DSH as "API key is invalid"); tools and the request-id header
 * are not gates (200 without either).
 */
const CANONICAL_SESSION_PATTERN = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/

const BASE62_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

function base62Fixed(value: bigint, width: number): string {
  const base = 62n
  let n = value
  const out = new Array<string>(width)
  for (let i = width - 1; i >= 0; i--) {
    out[i] = BASE62_ALPHABET.charAt(Number(n % base))
    n /= base
  }
  return out.join('')
}

/**
 * The session id sent upstream. A signal that already carries an official
 * OpenCode session passes through unchanged (preserving upstream prompt-cache
 * affinity); any other identity — the conversation seed in adapter mode,
 * foreign client sessions, admission probes — is deterministically hashed
 * into the canonical shape, so the same conversation keeps a stable session.
 */
export function canonicalSessionID(signal: string): string {
  if (CANONICAL_SESSION_PATTERN.test(signal)) return signal
  const sum = createHash('sha256').update('ses\x00' + signal).digest()
  const randomPart = base62Fixed(BigInt('0x' + sum.subarray(6, 16).toString('hex')), 14)
  return `ses_${sessionStamp(sum.toString('hex'))}${randomPart}`
}

/**
 * One OpenCode-shaped creation stamp: `~(ms * 0x1000 + counter)`, the low 48
 * bits, which is what the real client encodes (upstream's identifier
 * generator: clock, per-millisecond counter in the low 12 bits, then a
 * bitwise inversion so ids sort newest first as plain strings).
 *
 * The `+ 1` is the counter and it is NOT cosmetic: the inversion flips those
 * low bits, so upstream reads the segment back and checks it against a
 * wall-clock reading. A digest-derived or zero-counter prefix has no such
 * structure and is rejected even though it matches the regex (issue #62).
 * We always mint counter 1: this plugin is the only writer of its own
 * sessions, so a real per-millisecond counter would only add state.
 *
 * Held per conversation seed so a multi-turn conversation keeps ONE session
 * id (and its prompt-cache affinity) while the stamp stays a decodable
 * timestamp — recomputing it per request would rotate the session every turn.
 */
const SESSION_STAMP_LIMIT = 256
const sessionStamps = new Map<string, string>()

function sessionStamp(key: string): string {
  const cached = sessionStamps.get(key)
  if (cached !== undefined) return cached
  if (sessionStamps.size >= SESSION_STAMP_LIMIT) sessionStamps.clear()
  const stamp = ((~(BigInt(Date.now()) * 0x1000n + 1n)) & 0xFFFFFFFFFFFFn).toString(16).padStart(12, '0')
  sessionStamps.set(key, stamp)
  return stamp
}

/** CLI-identical user agent (ids.go opencodeUserAgent, node runtime values). */
export function opencodeUserAgent(): string {
  return `opencode/1.18.31 (${process.platform} ${process.arch}; node${process.versions.node})`
}

/**
 * The full disguise header set sent with every upstream request
 * (design.md 2.4; gateway.go newUpstreamRequest:640-669).
 */
export function disguiseHeaders(ids: RequestIDs): Record<string, string> {
  return {
    'user-agent': opencodeUserAgent(),
    'x-opencode-client': 'cli',
    'x-opencode-session': ids.session,
    'x-session-affinity': ids.session,
    'X-Session-Id': ids.session,
    'x-opencode-request': ids.request,
    'x-opencode-project': ids.project,
  }
}
