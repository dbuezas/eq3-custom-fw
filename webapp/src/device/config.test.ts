/**
 * The settings report, and the command builders that have to invert it.
 *
 * THE FIXTURE IS A MEASUREMENT: `cmd 0x16` was sent to a bench unit and the reply below is what came
 * back, beside a `cmd 0x18` read of the same cells that agreed with it byte for byte. It is worth
 * pinning because the report is where three encodings stop being this app's problem — the offset
 * stored plus 7, the duration cell in minutes against a five-minute argument, and the inverted
 * auto-detect flag — and a decoder that got any of them wrong would still look plausible.
 */
import { expect, test } from 'bun:test'

import {
  DESCALE_4_WEEKS,
  DESCALE_8_WEEKS,
  DESCALE_OFF,
  DESCALE_WEEKLY,
  SCREEN_BAR_VALVE,
  decodeSettings,
  isSettings,
  readSettings,
  setAutodetect,
  setBoostConfig,
  setComfortEco,
  setDescale,
  setOffset,
  setScreen,
  setWindowConfig,
} from './config'

const hex = (s: string) => new Uint8Array(s.match(/../g)!.map((h) => parseInt(h, 16)))

/**
 * `01 16` + thirteen bytes, as the device answered: comfort 21, eco 17, an offset cell of 11 =
 * +2.0 °C, window 12 °C for 3 five-minute units, boost unset (so the firmware reported the 5 min
 * and 80 % it really runs), the target+room screens rotating every 2 s, contrast 5, the thermostat
 * allowed to spot a window itself, and the anti-limescale stroke every week whatever the battery
 * says.
 *
 * ITS LAST TWO BYTES DID NOT MOVE WHEN THE STROKE SETTING LANDED. They were already `00 00` here,
 * because the mod reply envelope is padded to its full length whatever the handler emitted — so
 * this measurement, taken before that setting existed, decodes correctly under the new reader and
 * is the proof that older 2.00 thermostats still do.
 */
const REPORT = hex('0116' + '2a22' + '0b' + '1803' + '0550' + '0302' + '05' + '01' + '0000')

test('the report decodes to what the device showed', () => {
  const s = decodeSettings(REPORT)!
  expect(s.comfort).toBe(21)
  expect(s.eco).toBe(17)
  expect(s.windowTemp).toBe(12)
  expect(s.boostMinutes).toBe(5)
  expect(s.boostPercent).toBe(80)
  expect(s.screenMask).toBe(0x03)
  expect(s.screenSeconds).toBe(2)
  expect(s.contrast).toBe(5)
})

test('the report is matched by its tag AND its length, so a short frame is not decoded', () => {
  expect(isSettings(REPORT)).toBe(true)
  expect(readSettings()).toEqual([0x16]) // no arguments at all
  expect(decodeSettings(hex('011600'))).toBe(null) // a truncated reply is not half a settings page
  expect(decodeSettings(hex('0115' + '2a220b1803055003020501'))).toBe(null) // another command's reply
})

/**
 * The three encodings the report hides, each checked in BOTH directions — the value the device
 * reported must be the value that goes back out, or a row that shows a setting cannot send it.
 */
test('THE OFFSET IS REPORTED AS THE COMMAND TAKES IT: the cell is offset+7, in half degrees', () => {
  expect(decodeSettings(REPORT)!.offset).toBe(2)
  expect(setOffset(2)).toEqual([0x13, 11]) // the byte the report carried
  expect(setOffset(0)).toEqual([0x13, 7])
  expect(setOffset(-3.5)).toEqual([0x13, 0])
  expect(setOffset(3.5)).toEqual([0x13, 14])
  // The command refuses anything above 15, and the menu's own range stops at 14.
  expect(setOffset(99)[1]).toBeLessThanOrEqual(14)
  expect(setOffset(-99)[1]).toBe(0)
})

test('THE WINDOW DURATION IS REPORTED IN FIVE-MINUTE UNITS, and shown as minutes', () => {
  const s = decodeSettings(REPORT)!
  expect(s.windowMinutes).toBe(15) // 3 units on the wire
  expect(setWindowConfig(s.windowTemp, s.windowMinutes)).toEqual([0x14, 24, 3]) // and back unchanged
  expect(setWindowConfig(12, 0)).toEqual([0x14, 24, 0])
  expect(setWindowConfig(12, 75)).toEqual([0x14, 24, 15])
  expect(setWindowConfig(12, 999)[2]).toBe(15)
})

test('THE AUTO-DETECT FLAG IS REPORTED IN THE COMMAND’S SENSE, so nothing here inverts it', () => {
  expect(decodeSettings(REPORT)!.windowAutoDetect).toBe(true)
  const off = hex('0116' + '2a22' + '0b' + '1803' + '0550' + '0302' + '05' + '00' + '0000')
  expect(decodeSettings(off)!.windowAutoDetect).toBe(false)
  expect(setAutodetect(true)).toEqual([0xe0, 1])
  expect(setAutodetect(false)).toEqual([0xe0, 0])
})

test('ZERO IS A VALUE FOR THE STROKE, not the unset sentinel every other cell uses', () => {
  // Every week, running whatever the battery says -- which is what an unconfigured thermostat does,
  // so there is nothing to resolve and the two bytes are read raw.
  const s = decodeSettings(REPORT)!
  expect(s.descale).toBe(DESCALE_WEEKLY)
  expect(s.descaleBatterySkip).toBe(false)

  const monthly = hex('0116' + '2a22' + '0b' + '1803' + '0550' + '0302' + '05' + '01' + '0101')
  expect(decodeSettings(monthly)!.descale).toBe(DESCALE_4_WEEKS)
  expect(decodeSettings(monthly)!.descaleBatterySkip).toBe(true)

  const never = hex('0116' + '2a22' + '0b' + '1803' + '0550' + '0302' + '05' + '01' + '0300')
  expect(decodeSettings(never)!.descale).toBe(DESCALE_OFF)
})

test('the stroke command carries BOTH values every time, so neither can be lost', () => {
  expect(setDescale(DESCALE_WEEKLY, false)).toEqual([0x17, 0, 0])
  expect(setDescale(DESCALE_4_WEEKS, true)).toEqual([0x17, 1, 1])
  expect(setDescale(DESCALE_8_WEEKS, false)).toEqual([0x17, 2, 0])
  expect(setDescale(DESCALE_OFF, true)).toEqual([0x17, 3, 1])
})

test('AN UNSET CELL ARRIVES AS ITS DEFAULT, so this app carries no defaults table', () => {
  // Boost was unset on the device, and the report said 5 min / 80 % -- what boost_seed really runs.
  const s = decodeSettings(REPORT)!
  expect(s.boostMinutes).not.toBe(0)
  expect(s.boostPercent).not.toBe(0)
  expect(setBoostConfig(s.boostMinutes, s.boostPercent)).toEqual([0x0e, 5, 80])
})

test('comfort and eco are half degrees, clamped to what the device accepts', () => {
  expect(setComfortEco(21, 17)).toEqual([0x11, 42, 34])
  expect(setComfortEco(99, -99)).toEqual([0x11, 60, 9])
})

test('the idle-screen mask is passed WHOLE, so bit 4 survives', () => {
  // Bit 4 is the top bar's selector, not a screen: rebuilding the mask would switch it off.
  expect(setScreen(SCREEN_BAR_VALVE | 0x06, 4)).toEqual([0x15, 0x16, 4])
  expect(setScreen(0x1f, 99)).toEqual([0x15, 0x1f, 9]) // seconds are one digit
  expect(setScreen(0x1f, 0)).toEqual([0x15, 0x1f, 1])
})

test('boost keeps both halves, and the valve percentage is clamped to 100', () => {
  expect(setBoostConfig(7, 65)).toEqual([0x0e, 7, 65])
  expect(setBoostConfig(999, 999)).toEqual([0x0e, 240, 100])
})
