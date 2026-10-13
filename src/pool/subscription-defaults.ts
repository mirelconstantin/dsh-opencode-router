/** Shared by the host and browser; keep this module free of parser dependencies. */

/**
 * The default `User-Agent` subscription fetches present.
 *
 * `clash-verge/v2.0` — NOT `1.6.0`: real airports allow-list the version they
 * recognise and answer 502 Bad Gateway for the other. Emptiness is not an
 * option, since "send no User-Agent" is itself a fingerprint.
 */
export const DEFAULT_SUBSCRIPTION_USER_AGENT = 'clash-verge/v2.0'

/**
 * The UA to send for a configured value.
 *
 * @param value - the operator's setting; blank or absent means the default.
 * @returns the trimmed setting, or the built-in default when it is empty.
 */
export function normalizeSubscriptionUserAgent(value: string | undefined): string {
  return value?.trim() || DEFAULT_SUBSCRIPTION_USER_AGENT
}
