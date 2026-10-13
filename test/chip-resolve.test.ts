/**
 * What the composer chip shows for one /status reading.
 *
 * The rule under test is the ordering: a routing decision the user has just
 * made (a pin, or "no proxy") outranks the last completed request. Without
 * that, pinning an exit leaves the label reading "direct" until you send a
 * message, which is exactly the "I clicked it and nothing happened" report.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { resolve, type StatusView } from '../src/client/chip-readout.ts'

const EXIT_A = 'socks5://127.0.0.1:1080'
const EXIT_B = 'socks5://127.0.0.1:1081'

function view(overrides: Partial<StatusView> = {}): StatusView {
  return {
    enabled: true,
    deferredReason: '',
    bypass: false,
    currentExit: null,
    pinned: null,
    exits: [
      { id: EXIT_A, exitIP: '1.2.3.4', exitLocation: 'Sofia', latencyMs: 120, state: 'ok', cooling: false, pinnedFlag: false, usage: null },
      { id: EXIT_B, exitIP: '', exitLocation: '', latencyMs: 0, state: 'dead', cooling: false, pinnedFlag: false, usage: null },
    ],
    ...overrides,
  }
}

describe('the chip readout follows the routing decision', () => {
  test('a pin shows immediately, without waiting for a request', () => {
    // The regression: the pin was applied but the label kept reading
    // "direct" until a message was sent through it.
    const state = resolve(view({ pinned: { id: EXIT_A, strict: true } }))
    assert.equal(state.mode, 'proxy')
    assert.equal(state.mode === 'proxy' && state.exitId, EXIT_A)
    assert.equal(state.mode === 'proxy' && state.label, 'Sofia')
    assert.equal(state.mode === 'proxy' && state.pinned, true)
  })

  test('a pin outranks the last completed request', () => {
    // Routing through B, then pinning A: the chip must show A, because that
    // is where the NEXT request goes.
    const state = resolve(view({
      currentExit: { exitId: EXIT_B, at: 1_000 },
      pinned: { id: EXIT_A, strict: true },
    }))
    assert.equal(state.mode === 'proxy' && state.exitId, EXIT_A)
  })

  test('"no proxy" outranks both a pin and the last request', () => {
    const state = resolve(view({
      bypass: true,
      pinned: { id: EXIT_A, strict: true },
      currentExit: { exitId: EXIT_A, at: 1_000 },
    }))
    assert.equal(state.mode, 'direct')
    assert.equal(state.mode === 'direct' && state.forced, true)
  })

  test('a dead pin is still shown, marked unusable', () => {
    // Pinning a dead exit is how you debug one, so the chip must not hide it
    // or pretend it routed.
    const state = resolve(view({ pinned: { id: EXIT_B, strict: true } }))
    assert.equal(state.mode === 'proxy' && state.exitId, EXIT_B)
    assert.equal(state.mode === 'proxy' && state.ok, false)
  })

  test('with no pin the readout tracks real traffic', () => {
    const routed = resolve(view({ currentExit: { exitId: EXIT_A, at: 1_000 } }))
    assert.equal(routed.mode === 'proxy' && routed.exitId, EXIT_A)
    assert.equal(routed.mode === 'proxy' && routed.pinned, false)

    // Enabled but nothing has routed: "direct", but not a chosen one.
    const none = resolve(view())
    assert.equal(none.mode, 'direct')
    assert.equal(none.mode === 'direct' && none.forced, false)
  })

  test('a disabled pool still shows the chip, as direct', () => {
    // Regression: the chip used to render nothing when `enabled` was false,
    // which hid it the moment the pool was switched off — taking with it the
    // only control that can switch it back on. The bridge answering at all
    // already proves the plugin is serving, so "off" is never a valid state.
    const off = resolve(view({ enabled: false }))
    assert.equal(off.mode, 'direct', 'a switched-off pool reads as direct, not absent')
    assert.equal(off.mode === 'direct' && off.forced, false, 'and not as a chosen decline')
  })

  test('deferral outranks every routing choice', () => {
    const state = resolve(view({
      deferredReason: 'another dispatcher owns the global slot',
      bypass: true,
      pinned: { id: EXIT_A, strict: true },
    }))
    assert.equal(state.mode, 'deferred')
  })
})
