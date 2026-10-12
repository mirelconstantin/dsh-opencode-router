/**
 * The free-lane blocklist is the one place a model that upstream still serves
 * gets denied, and a stale entry is silent: the model vanishes from the picker
 * with no error anywhere. These pin the list against the live lane's current
 * answer, so removing a genuinely dead id (or re-adding a resurrected one) is a
 * deliberate, tested edit.
 *
 * The muse pair was the case in point: blocklisted 2026-10-10 for a 403
 * RegionError, re-probed 2026-10-12 answering 200 on /zen/v1/responses.
 *
 * Run with: node --test "test/*.test.ts"
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { FREE_LANE_BLOCKLIST, staticFreeModels, isFreeModel } from '../src/adapter/catalog.ts'

describe('the free-lane blocklist', () => {
  test('holds only free-lane ids', () => {
    for (const id of FREE_LANE_BLOCKLIST) {
      assert.ok(id.includes('free'), `${id} is blocked but is not a free-lane id`)
    }
  })

  test('keeps the ids probed dead upstream', () => {
    assert.deepEqual([...FREE_LANE_BLOCKLIST].sort(), ['exo-free', 'jev-1.13-free', 'ling-3.0-flash-fin-free'])
  })

  test('does not block a model the static roster vouches for', () => {
    for (const id of staticFreeModels) {
      assert.equal(FREE_LANE_BLOCKLIST.has(id), false, `${id} is both vouched and blocked`)
    }
  })
})

describe('the static roster', () => {
  test('vouches for both muse contributor ids that answered 200 on 2026-10-12', () => {
    assert.ok(staticFreeModels.includes('muse-spark-1.3-contributor-free'))
    assert.ok(staticFreeModels.includes('muse-spark-1.2-contributor-free'))
    assert.equal(isFreeModel('muse-spark-1.3-contributor-free'), true)
  })
})