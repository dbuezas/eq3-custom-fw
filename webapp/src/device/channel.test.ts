/**
 * Which of the thermostat's two command channels the app uses, and what "not chosen" means.
 *
 * **THE STORED CHOICE WINS IN BOTH DIRECTIONS, which is the whole point of the setting** `[owner]`.
 * The interesting combination is the one the default can never produce — a key stored and the paired
 * channel used anyway — because when something is wrong the two are not interchangeable, and the
 * reasons to prefer one are things the app cannot see. A key the thermostat does not actually hold
 * looks exactly like a thermostat that stopped answering.
 */
import { expect, test } from 'bun:test'

import { channelDefault } from './link'

test('with no choice stored, a key means encrypted and no key means paired', () => {
  expect(channelDefault({ key: 'e4999b0511c4389d1c0cad79d868dbcb' })).toBe('sealed')
  expect(channelDefault({})).toBe('plain')
  // A row this browser has never met is the same case as a row with nothing on it.
  expect(channelDefault(null)).toBe('plain')
})

test('A STORED CHOICE OVERRIDES THE KEY, including the way round the default never picks', () => {
  expect(channelDefault({ key: 'e4999b0511c4389d1c0cad79d868dbcb', channel: 'plain' })).toBe('plain')
  // And the reverse: chosen encrypted with no key. Nothing can arm, so the connection uses the paired
  // channel and says so — but the CHOICE is kept, so it takes effect when a key arrives.
  expect(channelDefault({ channel: 'sealed' })).toBe('sealed')
})
