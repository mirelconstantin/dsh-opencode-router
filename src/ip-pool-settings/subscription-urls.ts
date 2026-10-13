/**
 * Subscription-URL reconciliation, shared by the host settings resolver
 * (`ip-pool-settings/namespace.ts`) and the browser card (`client/IpPoolCard.tsx`).
 *
 * WHY THIS IS ONE FUNCTION AND NOT A `??` CHAIN
 *
 * The ip-pool section carries subscription URLs under two spellings:
 *
 *  - `subscription.urls` — the canonical nested field the settings form writes;
 *  - `subscriptions`     — the legacy flat key older patches and `cordis.patch.yml`
 *                          overlays still use, migrated away on the next save.
 *
 * Reading "nested first, flat as fallback" looks like a `??` chain, and that is
 * exactly how both call sites used to spell it:
 *
 *     const urls = raw.subscriptions ?? raw.subscription?.urls ?? []
 *
 * That chain is SILENTLY WRONG, because schemastery gives `Schema.array()` an
 * implicit `meta.default = []` (see `defineMethod` in schemastery: every
 * `array`/`tuple` node gets `[]` regardless of whether `.default()` was
 * called). A declared-but-absent field therefore never resolves to `undefined`
 * — it resolves to `[]`, which is not nullish, so `??` short-circuits on it and
 * the canonical nested value is discarded. Concretely, a patch holding
 * `{ subscription: { urls: [u] } }` resolves to
 * `{ subscriptions: [], subscription: { urls: [u] } }`, and the chain returns
 * `[]`: the URL never reaches the runtime, and the settings page re-renders it
 * as an empty list.
 *
 * The fix is to pick the first NON-EMPTY list rather than the first non-nullish
 * one. An empty list carries no information under either spelling, so treating
 * it as "absent" is both safe and what makes the read order-independent:
 * whichever key holds the URLs wins, and a genuinely cleared list stays cleared.
 *
 * Deliberately dependency-free: the browser bundle inlines this module, and the
 * client build's purity gate rejects any `@deepseek-ai/*` import that is not a
 * platform seed — so this file must not reach for the schema.
 */

/** The two URL spellings as they appear in one resolved ip-pool section. */
export interface SubscriptionUrlCarrier {
  /** Canonical nested field written by the settings form. */
  subscription?: { urls?: string[] } | undefined
  /** Legacy flat alias, migrated away on the next subscription edit. */
  subscriptions?: string[] | undefined
}

/**
 * The configured subscription URLs under whichever spelling carries them.
 *
 * @param section - one ip-pool section from any layer (resolved settings, a
 *   raw entry config, or a served form value).
 * @returns the nested list when it is non-empty, else the flat list when it is
 *   non-empty, else an empty array. Never `undefined`, so callers can spread or
 *   measure the result directly.
 */
export function resolveSubscriptionUrls(section: SubscriptionUrlCarrier | undefined): string[] {
  const nested = section?.subscription?.urls
  if (Array.isArray(nested) && nested.length > 0) return nested
  const flat = section?.subscriptions
  if (Array.isArray(flat) && flat.length > 0) return flat
  return []
}
