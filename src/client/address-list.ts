/**
 * Parsing and normalization for the two editable address lists (manual
 * proxies and subscription URLs).
 *
 * These live apart from the React component so they carry no JSX and can be
 * tested without a DOM: the parser decides what a pasted block does to the
 * saved configuration, and that decision is the contract, not the markup.
 */

/** The accepted proxy syntax: scheme, optional credentials, host, port. */
export const PROXY_SHAPE =
  /^(?:https?|socks5h?):\/\/(?:[^\s@/]+(?::[^\s@/]*)?@)?(?:\[[0-9a-fA-F:.]+\]|[^\s:/?#]+):\d{1,5}$/

/** The accepted subscription syntax: an http(s) URL. */
export const URL_SHAPE = /^https?:\/\/\S+$/

/** Matches any non-blank line, for lists with no stricter syntax. */
export const NON_EMPTY = /^\S+$/

/**
 * A comparison key for an address, so equivalent spellings are one entry.
 *
 * The runtime dials the address exactly as written, so this never rewrites a
 * value; it only decides whether two strings mean the same endpoint. The
 * scheme and host fold to lower case and a leading-zero port folds to its
 * numeric form, so `http://Host:080` and `http://host:80` collapse to one.
 * Userinfo is left alone, because different credentials are different
 * endpoints even on the same host and port.
 *
 * @param entry - the address as typed or pasted.
 * @returns a key that two addresses share exactly when they are equivalent.
 */
export function addressKey(entry: string): string {
  const schemeSplit = entry.indexOf('://')
  if (schemeSplit < 0) return entry.toLowerCase()
  const scheme = entry.slice(0, schemeSplit).toLowerCase()
  const rest = entry.slice(schemeSplit + 3)
  const at = rest.lastIndexOf('@')
  const userinfo = at >= 0 ? `${rest.slice(0, at)}@` : ''
  const hostport = at >= 0 ? rest.slice(at + 1) : rest
  const colon = hostport.lastIndexOf(':')
  const host = (colon >= 0 ? hostport.slice(0, colon) : hostport).toLowerCase()
  const rawPort = colon >= 0 ? hostport.slice(colon + 1) : ''
  const port = /^\d+$/.test(rawPort) ? String(Number(rawPort)) : rawPort
  return `${scheme}://${userinfo}${host}${port === '' ? '' : `:${port}`}`
}

/** The outcome of parsing a pasted block of addresses. */
export interface ParsedList {
  /** New entries to add, in input order, exactly as written. */
  added: string[]
  /** Inputs that matched an address already present. */
  duplicates: number
  /** Inputs that are neither a valid shape nor already present. */
  malformed: string[]
  /** The first malformed input, for the error line. */
  firstError?: string
}

/** Split a pasted block into candidate lines, dropping blanks and comments. */
function splitLines(block: string): string[] {
  return block
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
}

/**
 * Parse a pasted block against the addresses already in a list.
 *
 * Neither argument is mutated, so the caller can show the outcome and let the
 * user decide before anything is written.
 *
 * @param block - the pasted text, one address per line.
 * @param values - the addresses already in the list.
 * @param shape - the accepted syntax for this field.
 * @returns what would be added, skipped as duplicate, and rejected.
 */
export function parseListBlock(block: string, values: string[], shape: RegExp): ParsedList {
  const seen = new Set(values.map(addressKey))
  const result: ParsedList = { added: [], duplicates: 0, malformed: [] }
  for (const line of splitLines(block)) {
    if (!shape.test(line)) {
      result.malformed.push(line)
      continue
    }
    const key = addressKey(line)
    if (seen.has(key)) {
      result.duplicates += 1
      continue
    }
    seen.add(key)
    result.added.push(line)
  }
  const first = result.malformed[0]
  if (first !== undefined) result.firstError = first
  return result
}