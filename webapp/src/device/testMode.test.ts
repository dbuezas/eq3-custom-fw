/**
 * The `?test=1` double: off unless asked, and made of values the app's own decoders accept.
 *
 * A test double that drifts from the wire is worse than none — it makes a broken app look fine on
 * the one machine that is away from the device. So the canned programme goes through `decodeDay`
 * and `problem`, and the model values through the same limits the editors enforce.
 */
import { expect, test } from 'bun:test'

import { TEMP_MAX, TEMP_MIN } from './commands'
import { TEST_DEVICE, TEST_MODE, testReply } from './testMode'
import { decodeDay, isDayReply, problem } from './schedule'

test('test mode is OFF unless the address asks for it', () => {
  // The one failure here that would matter: a build that fakes a thermostat for everybody.
  expect(TEST_MODE).toBe(false)
})

test('the canned programme is a frame the real decoder accepts', () => {
  const r = testReply([0x20, 2])
  expect(r).not.toBeNull()
  const b = new Uint8Array(r!)
  expect(isDayReply(b)).toBe(true)
  const day = decodeDay(b)
  expect(day).not.toBeNull()
  // Seven slots, and a week the editor will not refuse to send.
  expect(day!.length).toBe(7)
  expect(problem(day!)).toBeNull()
})

test('the weekend differs from the weekdays, so the editor opens on a real shape', () => {
  const sat = decodeDay(new Uint8Array(testReply([0x20, 0])!))!
  const mon = decodeDay(new Uint8Array(testReply([0x20, 2])!))!
  expect(sat[0]!.temp).not.toBe(mon[0]!.temp)
})

test('a command with nothing behind it says nothing, rather than a made-up frame', () => {
  expect(testReply([0x99])).toBeNull()
})

test('the made-up thermostat is inside the limits the app enforces', () => {
  const { settings, status, advName } = TEST_DEVICE
  for (const t of [settings.comfort, settings.eco, settings.windowTemp, status.setpoint])
    expect(t >= TEMP_MIN && t <= TEMP_MAX).toBe(true)
  expect(settings.screenSeconds >= 1 && settings.screenSeconds <= 9).toBe(true)
  expect(settings.contrast >= 1 && settings.contrast <= 8).toBe(true)
  expect(status.valve >= 0 && status.valve <= 100).toBe(true)
  // The name row reads the limit off the wire; a double that reported one its own name broke would
  // show an error the device never gives.
  expect(advName.name.length).toBeLessThanOrEqual(advName.max)
})
