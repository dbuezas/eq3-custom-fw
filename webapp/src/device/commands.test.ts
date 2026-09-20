/**
 * The command builders — the bytes, and only the bytes.
 *
 * WHAT IS WORTH TESTING is what the device would accept and then behave badly on. Stock's `cmd
 * 0x41` writes whatever arrives straight into the setpoint: 127.5 °C was accepted, displayed, and
 * held the valve wide open forever against a target no room reaches. So the clamp is not tidiness,
 * it is the difference between a control and a way to break somebody's heating.
 */
import { expect, test } from 'bun:test'

import {
  TEMP_MAX,
  TEMP_MIN,
  setBoost,
  selectComfort,
  selectEco,
  setLock,
  setMode,
  setTemperature,
  setWindow,
  tempByte,
  tempText,
} from './commands'

test('a temperature is half-degree steps, as the device stores it', () => {
  expect(tempByte(21)).toBe(42)
  expect(tempByte(21.5)).toBe(43)
  expect(tempByte(TEMP_MIN)).toBe(9)
  expect(tempByte(TEMP_MAX)).toBe(60)
})

test('nothing outside the thermostat’s own range can leave here', () => {
  expect(tempByte(127.5)).toBe(60) // the value that held a real valve wide open
  expect(tempByte(1000)).toBe(60)
  expect(tempByte(0)).toBe(9)
  expect(tempByte(-40)).toBe(9)
})

test('the two ends read as the words the glass shows', () => {
  expect(tempText(4.5)).toBe('Off')
  expect(tempText(30)).toBe('On')
  expect(tempText(21)).toBe('21.0°')
})

test('setting a temperature does not set a mode', () => {
  // cmd 0x40 packs the mode into the top two bits of its argument, so it is NOT used for this.
  expect(setTemperature(21)).toEqual([0x41, 42])
})

test('the mode goes out with sub-command 0, which changes no temperature', () => {
  expect(setMode('auto')).toEqual([0x40, 0x00])
  expect(setMode('manual')).toEqual([0x40, 0x40])
})

test('the child lock flag is the FIRST argument byte', () => {
  // The second is ignored -- reading the frame the other way round would silently never lock.
  expect(setLock(true)).toEqual([0x80, 1, 0])
  expect(setLock(false)).toEqual([0x80, 0, 0])
})

test('boost and window are one flag each', () => {
  expect(setBoost(true)).toEqual([0x45, 1])
  expect(setBoost(false)).toEqual([0x45, 0])
  expect(setWindow(true)).toEqual([0x30, 1])
  expect(setWindow(false)).toEqual([0x30, 0])
})

test('comfort and eco carry no argument — the temperature is the one already stored', () => {
  expect(selectComfort()).toEqual([0x43])
  expect(selectEco()).toEqual([0x44])
})
