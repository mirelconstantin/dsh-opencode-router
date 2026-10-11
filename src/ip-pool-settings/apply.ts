/**
 * ip-pool settings controller — glues the plugin's volatile `Config` field
 * (docs/ip-pool.md §5.1) to the runtime assembly (ip-pool.ts) with live apply,
 * and mounts the status/probe bridge (§5.3) on the host webServer.
 *
 * Lifecycle (all no-restart, docs §7 IP-5 acceptance), on the DSH 0.1.7 model
 * where there is no `ctx.settings.register()` and the namespace is the Loader
 * entry id:
 *  - the Loader resolves the entry config into the `ipPool` volatile
 *    reference, so a composition that already sets `enabled` assembles the
 *    pool at boot;
 *  - every settings save commits into that same reference and arrives as
 *    `loader/volatile-update`, which hot-applies through runtime.reconfigure()
 *    — including the `enabled` flip (dispatcher install/uninstall) and address
 *    list edits (manual rows rebuilt, pinned re-pinned);
 *  - bridge routes mount once the webServer service shows up (ctx.inject),
 *    reading the live runtime and the current settings value.
 */

import type { PluginContext } from '../index.ts'
import type { OrdinaryPluginConfig } from '../config.ts'
import type { IpPoolRuntime } from '../ip-pool.ts'
import { IP_POOL_NAMESPACE, resolveIpPoolSettings, toIpPoolConfig, type IpPoolSettings } from './namespace.ts'
import { IP_POOL_BRIDGE_PREFIX, makeBridgeHandlers, makeBridgeRoutes } from './bridge.ts'

export interface IpPoolController {
  /** The live runtime (null until enabled and assembled). */
  runtime: IpPoolRuntime | null
  /** Current effective settings value (defaults filled). */
  settings(): IpPoolSettings
  /** The plugin config object shape consumed by reconfigure. */
  asConfig(value: IpPoolSettings): OrdinaryPluginConfig & { ipPool: ReturnType<typeof toIpPoolConfig> }
}

/** Assembly seam (test-injectable); default = the real startIpPool. */
export type AssembleIpPool = (
  config: OrdinaryPluginConfig & { ipPool: ReturnType<typeof toIpPoolConfig> },
  logger: PluginContext['logger'],
) => Promise<IpPoolRuntime | null>

const defaultAssemble: AssembleIpPool = async (config, logger) => {
  const { startIpPool } = await import('../ip-pool.ts')
  return startIpPool(config, logger)
}

/**
 * Register the ip-pool namespace, own the live runtime, mount the bridge.
 * Returns the controller handle; disposal rides the plugin fiber.
 */
export function applyIpPoolSettings(
  ctx: PluginContext,
  ordinary: OrdinaryPluginConfig,
  readIpPool: () => Partial<IpPoolSettings> | undefined,
  logger: PluginContext['logger'],
  deps: { assemble?: AssembleIpPool; listLiveModels?: () => string[] } = {},
): IpPoolController {
  const assemble = deps.assemble ?? defaultAssemble
  let disposed = false
  let starting: Promise<void> | undefined
  const controller: IpPoolController = {
    runtime: null,
    settings: () => resolveIpPoolSettings(readIpPool()),
    asConfig: (value) => ({ ...ordinary, ipPool: toIpPoolConfig(value) }),
  }

  /** Assemble on first enable; reuse across later commits (live reconfigure). */
  const ensureRuntime = async (): Promise<void> => {
    if (disposed || controller.runtime !== null) return
    if (starting !== undefined) return starting
    starting = (async () => {
      const runtime = await assemble(controller.asConfig(controller.settings()), logger)
      if (disposed) await runtime?.dispose()
      else controller.runtime = runtime
    })()
    try { await starting } finally { starting = undefined }
  }

  // Cold-start ordering: the Loader has already resolved schema defaults, the
  // composition's entry config, and the persisted user document into the
  // volatile reference, so a saved enabled:true must assemble the pool at boot
  // — not only after the next settings-page save. The entry config alone
  // cannot see the persisted value; `readIpPool()` can.
  const applyCommitted = (value: IpPoolSettings): void => {
    if (disposed) return
    const rt = controller.runtime
    if (value.enabled && rt === null) {
      void ensureRuntime()
        .then(() => controller.runtime?.reconfigure(controller.asConfig(controller.settings())))
        .catch((err) => {
          logger.warn(`opencode2dsh: ip pool start failed: ${err instanceof Error ? err.message : String(err)}`)
        })
      return
    }
    if (rt !== null) {
      void rt.reconfigure(controller.asConfig(value)).catch((err) => {
        logger.warn(`opencode2dsh: ip pool live re-apply failed: ${err instanceof Error ? err.message : String(err)}`)
      })
    }
  }

  // Boot: apply the resolved value. Then every commit the Loader announces
  // takes the same path — one code path for boot and live, as before.
  applyCommitted(controller.settings())

  // Every settings save the Host accepts for this entry lands in the volatile
  // reference and arrives here. This replaces the 0.1.1 `scope.watch()` seam
  // that DSH 0.1.7 deleted along with `ctx.settings.register()`.
  const maybeOn = (ctx as { on?: PluginContext['on'] }).on
  if (typeof maybeOn === 'function') {
    maybeOn.call(ctx, 'loader/volatile-update', () => {
      applyCommitted(controller.settings())
    })
  }

  // The plugin supplies its own page (the client half's IP 池 card), so tell
  // the settings domain not to auto-generate one for this entry. Requested
  // lazily: `settings` must stay out of `inject` or a headless composition
  // that does not compose it would never activate the provider route.
  // Same shape as dsh-llm-deepseek's host.ts — `configure` returns the undo, so
  // the claim is scoped to our fiber and released on unload.
  if (typeof ctx.inject === 'function') {
    void Promise.resolve(ctx.inject(['settings'], (sctx: PluginContext) => {
      const settings = sctx.settings
      if (typeof settings?.configure !== 'function') return
      const fiber = (ctx as { fiber?: unknown }).fiber
      const claim = () => settings.configure!({ auto: false }, fiber)
      const maybeFiberEffect = (sctx as { effect?: PluginContext['effect'] }).effect
      if (typeof maybeFiberEffect === 'function') {
        // `configure` returns the undo, so the claim is scoped to our fiber.
        maybeFiberEffect.call(sctx, claim)
        return
      }
      void claim()
    })) as unknown as Promise<unknown>
  }

  // Bridge: mount once webServer is up. The handlers read the live runtime
  // and the current settings value at request time (never stale closures).
  if (typeof ctx.inject === 'function') {
    void Promise.resolve(ctx.inject(['webServer'], (bctx: PluginContext) => {
      if (!bctx.webServer) return
      const handlers = makeBridgeHandlers(
        () => controller.runtime,
        () => ({
          pinnedStrict: controller.settings().pinnedStrict,
          proxyHosts: controller.runtime?.installer && controller.settings().proxyHosts.length > 0
            ? controller.settings().proxyHosts
            : ['opencode.ai'],
        }),
        {
          // Probe-model dropdown rows: the plugin's live Zen catalog when one
          // is running (adapter mode), static S3 list only otherwise.
          listLiveModels: deps.listLiveModels,
        },
      )
      const disposers: Array<() => void> = []
      for (const route of makeBridgeRoutes(handlers)) {
        disposers.push(bctx.webServer.register(route as never))
      }
      logger.info(`opencode2dsh: ip-pool bridge mounted at ${IP_POOL_BRIDGE_PREFIX} (${disposers.length} routes)`)
      const maybeEffect = (bctx as { effect?: PluginContext['effect'] }).effect
      if (typeof maybeEffect === 'function') {
        maybeEffect.call(bctx, () => () => {
          for (const dispose of disposers) dispose()
        })
      }
    })) as unknown as Promise<unknown>
  }

  logger.info(`opencode2dsh: settings namespace "${IP_POOL_NAMESPACE}" served from the plugin's volatile Config — live apply via 设置 → 插件 → IP 池`)
  const maybeEffect = (ctx as { effect?: PluginContext['effect'] }).effect
  if (typeof maybeEffect === 'function') {
    maybeEffect.call(ctx, () => () => {
      disposed = true
      void controller.runtime?.dispose()
      controller.runtime = null
    })
  }
  return controller
}
