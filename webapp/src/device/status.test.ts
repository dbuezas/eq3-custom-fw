/**
 * The status decoder, against bytes taken off the real thermostat.
 *
 * THE FIXTURE IS A MEASUREMENT, not a construction: `0201080004240000000018032a2207` is what
 * A bench unit answered `cmd 0x03` with `[manually verified]`. Decoding it wrongly would show the
 * wrong setpoint on the everyday screen, which is the one failure a person would act on.
 */
import { expect, test } from 'bun:test'

import { decodeStatus, isStatus, setDateTime } from './status'

const hex = (s: string) => new Uint8Array(s.match(/../g)!.map((h) => parseInt(h, 16)))

test('the reply measured on the device decodes to what the glass showed', () => {
  const s = decodeStatus(hex('0201080004240000000018032a2207'))!
  expect(s.mode).toBe('auto')
  expect(s.boost).toBe(false)
  expect(s.dst).toBe(true) // bit 3, and the device confirmed $009d = 0x01
  expect(s.window).toBe(false)
  expect(s.lock).toBe(false)
  expect(s.batteryLow).toBe(false)
  expect(s.valve).toBe(0)
  expect(s.uiState).toBe(4) // running
  expect(s.setpoint).toBe(18) // 0x24 = 36 half-degrees
})

test('every status bit is read from the position the protocol spec gives it', () => {
  const at = (status: number) => decodeStatus(hex(`0201${status.toString(16).padStart(2, '0')}326404`))!
  expect(at(0x00).mode).toBe('auto')
  expect(at(0x01).mode).toBe('manual')
  expect(at(0x02).mode).toBe('vacation')
  expect(at(0x04).boost).toBe(true)
  expect(at(0x10).window).toBe(true)
  expect(at(0x20).lock).toBe(true)
  expect(at(0x80).batteryLow).toBe(true)
  // Bit 6 is unused, and reading it as anything would be inventing a field. Compared field by
  // field rather than whole: a status carries the moment it arrived, so two decodes taken either
  // side of a millisecond are legitimately different objects and an object comparison is flaky.
  const { at: _a, ...unused } = at(0x40)
  const { at: _b, ...none } = at(0x00)
  expect(unused).toEqual(none)
})

test('half-degree steps, including the halves', () => {
  expect(decodeStatus(hex('02010000042a'))!.setpoint).toBe(21)
  expect(decodeStatus(hex('02010000042b'))!.setpoint).toBe(21.5)
})

test('anything that is not a status is refused rather than half-decoded', () => {
  expect(isStatus(hex('01c800008075816068606560686736'))).toBe(false) // the info reply
  expect(decodeStatus(hex('0280'))).toBeNull() // the NAK, which is type 0x02 but far too short
  expect(decodeStatus(hex('210322242a3622662a8a229022902290'))).toBeNull() // a programme
})

test('the clock command carries the fields in the device’s order, two-digit year', () => {
  expect(setDateTime(new Date(2026, 8, 7, 22, 46, 7))).toEqual([0x03, 26, 9, 7, 22, 46, 7])
})
