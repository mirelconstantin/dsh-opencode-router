/**
 * The current-proxy control in the composer dock (the bottom bar): a compact
 * readout of the exit the most recent request went through, which opens a
 * picker for choosing the exit by hand.
 *
 * It reads the same /status bridge the IP Pool settings page polls, so the
 * plugin needs no second transport. The chip polls on its own because the
 * settings page only mounts when the Host serves the namespace, and a chip
 * that disappeared with the settings page would answer the question it
 * exists for at the worst moment — mid-conversation, with a stuck proxy.
 *
 * The trigger, panel and dismissal follow the ContextMeter in the
 * conversation client (packages/client/ui-conversation/src/client/skeleton/
 * ContextMeter.tsx): a real <button> with aria-haspopup, a portaled panel
 * anchored above the bar, outside-pointer and Escape dismissal, and a
 * segmented bar built the same way. Matching it exactly is the point — the
 * two controls share the dock row, so anything invented here reads as a
 * stranger sitting next to it. See research/context-meter-anatomy.md.
 *
 * "Current" is the last completed dispatch, so between a 429 rotation and
 * the next request this names the exit the session is about to leave. The
 * readout says so rather than claiming a live tunnel it cannot see.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  IconGlobeOutlineRegular,
  IconPinOutlineRegular,
  Tooltip,
  useAnchoredPosition,
  useDismissOnOutsidePointer,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { en } from './locales.ts'
import { exitLabel, resolve, cacheRatio, formatTokenCount, totalTokens, type ChipState, type StatusView } from './chip-readout.ts'
import styles from './ip-pool.module.css'

/** What the exit picker can ask for; mirrors the bridge's /pin modes. */
type Choice =
  | { mode: 'auto' }
  | { mode: 'direct' }
  | { mode: 'exit'; exitId: string }

/**
 * Props the composer dock binds for the chip.
 *
 * Only the locale kit is consumed: the readout describes the router, not the
 * session it is rendered beside, so it needs none of the dock's session
 * props. That is also why this component declares no dependency on the
 * conversation package that owns the slot — its identity lives in the
 * registration (see client/index.ts).
 */
export type ProxyStatusChipProps = PropsLocale<'settings.ip-pool'>

/** The bridge prefix (same-origin, loopback-only on the host). */
const BRIDGE_PREFIX = '/api/opencode2dsh/ip-pool'

/** How often the readout refreshes while the composer is mounted. */
const POLL_MS = 3000

async function post(path: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${BRIDGE_PREFIX}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) return null
  const payload = (await response.json()) as { ok?: boolean; value?: unknown }
  return payload.ok === true ? payload.value : null
}

async function readStatus(): Promise<StatusView | null> {
  try {
    const value = await post('/status', {})
    return (value as StatusView | null) ?? null
  } catch {
    // A stopped host answers nothing; the chip falls back to its last read.
    return null
  }
}

/** The short name for an exit: its location when admission read one, else
 *  the address itself. Never the exit IP, which is the one field the card
 *  keeps for the exit table. */
/** "3 uses · 2m ago", for one row of the picker. */
function usageText(
  usage: StatusView['exits'][number]['usage'],
  t: ProxyStatusChipProps['t'],
  now: number,
): string {
  if (usage === null) return t('chipNeverUsed')
  const elapsed = Math.max(0, now - usage.lastUsedAt)
  const ago = elapsed < 60_000
    ? t('chipAgoNow')
    : elapsed < 3_600_000
      ? t('chipAgoMinutes', { n: Math.floor(elapsed / 60_000) })
      : elapsed < 86_400_000
        ? t('chipAgoHours', { n: Math.floor(elapsed / 3_600_000) })
        : t('chipAgoDays', { n: Math.floor(elapsed / 86_400_000) })
  return t('chipUses', { n: usage.uses }) + ' · ' + ago
}

export function ProxyStatusChip(props: ProxyStatusChipProps): React.ReactElement | null {
  const { t } = props
  const [status, setStatus] = useState<StatusView | null>(null)
  const [state, setState] = useState<ChipState | null>(null)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const now = Date.now()

  const apply = useCallback((next: StatusView): void => {
    setStatus(next)
    setState(resolve(next))
  }, [])

  useEffect(() => {
    let live = true
    const tick = (): void => {
      void readStatus().then((read) => {
        if (live && read !== null) apply(read)
      })
    }
    tick()
    const timer = setInterval(tick, POLL_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [apply])

  // Escape closes the picker, matching the ContextMeter's panel.
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const position = useAnchoredPosition({
    open,
    anchorRef: rootRef,
    panelRef,
    side: 'top',
    gap: 8,
    margin: 12,
  })
  useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef)

  /** Apply the chosen routing, then re-read so the row shows the host's answer
   *  rather than the click that asked for it. */
  const choose = useCallback(async (choice: Choice): Promise<void> => {
    setOpen(false)
    await post('/pin', choice)
    const read = await readStatus()
    if (read !== null) apply(read)
  }, [apply])

  // Nothing has answered yet: the host may still be starting, and a chip
  // that flickers "direct" during boot would be wrong in the one direction
  // that matters. It appears once there is a real reading.
  if (state === null) return null

  const title = (): string => {
    if (state.mode === 'deferred') return t('chipDeferred')
    if (state.mode === 'direct') {
      // Three distinct reasons to read "direct", and collapsing them would
      // hide the one the reader needs: routing switched off at settings is a
      // different situation from routing declined, or nothing routed yet.
      if (state.forced) return t('chipDirectChosen')
      return t(status?.enabled === false ? 'chipDirectPoolOff' : 'chipDirect')
    }
    // A pin is a decision about the next request, so it gets its own wording
    // rather than claiming traffic already went through this exit.
    if (state.pinned) return t('chipPinned', {
      label: state.label,
      latency: String(state.latencyMs),
      state: t(state.ok ? 'chipStateOk' : 'chipStateBad'),
    })
    return t('chipProxyFull', {
      label: state.label,
      latency: String(state.latencyMs),
      state: t(state.ok ? 'chipStateOk' : 'chipStateBad'),
    })
  }

  // The trigger is the ContextMeter's, with health as a border colour: the
  // border is the only channel that carries state, so the label never
  // depends on colour alone to be readable.
  const health = (): 'ok' | 'bad' | 'flat' => {
    if (state.mode === 'proxy') return state.ok ? 'ok' : 'bad'
    return 'flat'
  }

  const value = (): string => {
    if (state.mode === 'proxy') return state.label
    if (state.mode === 'direct') {
      if (state.forced) return t('chipValueNoProxy')
      // Routing switched off at settings is not the same as "nothing routed
      // yet" — the pool is idle, not empty — so it says so rather than
      // borrowing the runtime's own "direct".
      return t(status?.enabled === false ? 'chipValuePoolOff' : 'chipValueDirect')
    }
    return t('chipValueDeferred')
  }

  const pinnedId = status?.pinned?.id ?? null
  const bypass = status?.bypass === true
  // Rows order themselves the way a person would choose: the current pin, then
  // exits that have actually carried traffic (a proven one beats an untested
  // one of the same health), then healthy, then never-used.
  const rows = [...(status?.exits ?? [])].sort((a, b) => {
    if (a.pinnedFlag !== b.pinnedFlag) return a.pinnedFlag ? -1 : 1
    if ((a.state === 'ok') !== (b.state === 'ok')) return a.state === 'ok' ? -1 : 1
    const usedA = (a.usage?.uses ?? 0) > 0 ? 1 : 0
    const usedB = (b.usage?.uses ?? 0) > 0 ? 1 : 0
    if (usedA !== usedB) return usedB - usedA
    return (b.usage?.lastUsedAt ?? 0) - (a.usage?.lastUsedAt ?? 0)
  })
  // The panel's bar mirrors the ContextMeter's: one segment per class of
  // exit, so a pool that is mostly dead reads as mostly empty at a glance.
  const healthy = rows.filter((row) => row.state === 'ok').length
  const segments = rows.length === 0
    ? []
    : [
      { key: 'ok', color: styles.colorOk, width: (healthy / rows.length) * 100 },
      { key: 'unknown', color: styles.colorUnknown, width: ((rows.filter((row) => row.state === 'unknown').length) / rows.length) * 100 },
      { key: 'dead', color: styles.colorDead, width: ((rows.filter((row) => row.state === 'dead').length) / rows.length) * 100 },
    ].filter((segment) => segment.width > 0)

  return (
    <span ref={rootRef} className={styles.chipRoot} data-composer-proxy={true}>
      <Tooltip label={title()} side="top" delayMs={200} disabled={open}>
        <button
          type="button"
          className={styles.chipTrigger}
          data-health={health()}
          aria-label={title()}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {/* Health rides the icon, not a border: the trigger has none, so
              tinting the glyph is the only channel that stays in keeping with
              the rest of the dock row. */}
          <IconGlobeOutlineRegular className={styles.chipIcon} data-health={health()} aria-hidden={true} />
          <span>{value()}</span>
        </button>
      </Tooltip>
      {open && status !== null && createPortal(
        <div
          ref={panelRef}
          className={styles.chipPanel}
          role="dialog"
          aria-label={t('chipPanelTitle')}
          style={position ?? { visibility: 'hidden', left: 0, top: 0 }}
        >
          <div className={styles.chipPanelHead}>
            <span className={styles.chipPanelTitle}>{t('chipPanelTitle')}</span>
            <span className={styles.chipFigures}>{t('chipHealth', { ok: healthy, total: rows.length })}</span>
          </div>
          {rows.length > 0 && (
            <div className={styles.chipBar}>
              {segments.map((segment) => (
                <div
                  key={segment.key}
                  className={segment.color === undefined
                    ? styles.chipSegment
                    : `${styles.chipSegment} ${segment.color}`}
                  style={{ width: `${segment.width}%` }}
                />
              ))}
            </div>
          )}

          <div className={styles.chipGroupLabel}>{t('chipGroupModes')}</div>
          <button
            type="button"
            className={styles.chipRow}
            aria-pressed={bypass}
            onClick={() => void choose({ mode: 'direct' })}
          >
            <span className={styles.chipDot} data-state="direct" aria-hidden={true} />
            <span className={styles.chipRowLabel}>
              <span className={styles.chipRowName}>{t('chipNoProxy')}</span>
            </span>
            {/* The mode rows carry no tokens or ping, so the two value tracks
                stay empty — otherwise the tick would slide left into the
                Tokens column and the two groups would not line up. */}
            <span className={styles.chipColumnTokens} />
            <span className={styles.chipColumnLatency} />
            <span className={styles.chipCheckSlot}>
              {bypass && <span className={styles.chipCheck}>✓</span>}
            </span>
          </button>
          <button
            type="button"
            className={styles.chipRow}
            aria-pressed={pinnedId === null && !bypass}
            onClick={() => void choose({ mode: 'auto' })}
          >
            <span className={styles.chipDot} data-state="auto" aria-hidden={true} />
            <span className={styles.chipRowLabel}>
              <span className={styles.chipRowName}>{t('chipAuto')}</span>
            </span>
            <span className={styles.chipColumnTokens} />
            <span className={styles.chipColumnLatency} />
            <span className={styles.chipCheckSlot}>
              {pinnedId === null && !bypass && <span className={styles.chipCheck}>✓</span>}
            </span>
          </button>

          {rows.length > 0 && (
            <>
              <div className={styles.chipGroupLabel}>{t('chipGroupExits')}</div>
              <div className={styles.chipColumnHead}>
                {/* Empty leading tracks so the headings sit over the same
                    columns as the values they label. */}
                <span />
                <span />
                <span className={styles.chipColumnTokens}>{t('chipColTokens')}</span>
                <span className={styles.chipColumnLatency}>{t('chipColLatency')}</span>
                <span />
              </div>
            </>
          )}
          {rows.map((row) => {
            const tokens = totalTokens(row.usage)
            const cached = Math.round(cacheRatio(row.usage) * 100)
            return (
              <button
                key={row.id}
                type="button"
                className={styles.chipRow}
                aria-pressed={pinnedId === row.id}
                onClick={() => void choose({ mode: 'exit', exitId: row.id })}
              >
                {row.pinnedFlag
                  ? <IconPinOutlineRegular className={styles.chipIcon} aria-hidden={true} />
                  : <span className={styles.chipDot} data-state={row.state} aria-hidden={true} />}
                <span className={styles.chipRowLabel}>
                  <span className={styles.chipRowName}>{exitLabel(row, row.id)}</span>
                  <span className={styles.chipRowSub}>{usageText(row.usage, t, now)}</span>
                </span>
                <span className={styles.chipColumnTokens}>
                  {tokens > 0 ? (
                    <>
                      <span className={styles.chipTokens}>{formatTokenCount(tokens)}</span>
                      {/* The cached share is the number that says whether this
                          proxy is carrying a long conversation cheaply. */}
                      {cached > 0 && (
                        <span className={styles.chipCache} title={t('chipCacheTitle', { pct: cached })}>
                          {cached}%
                        </span>
                      )}
                    </>
                  ) : (
                    <span
                      className={styles.chipTokensNone}
                      title={t('chipNoTokensTitle')}
                    >
                      —
                    </span>
                  )}
                </span>
                <span className={styles.chipColumnLatency}>
                  {row.state === 'ok' ? `${row.latencyMs}ms` : ''}
                </span>
                <span className={styles.chipCheckSlot}>
                  {pinnedId === row.id && <span className={styles.chipCheck}>✓</span>}
                </span>
              </button>
            )
          })}
          {rows.length === 0 && <div className={styles.chipEmpty}>{t('chipNoExits')}</div>}
        </div>,
        document.body,
      )}
    </span>
  )
}