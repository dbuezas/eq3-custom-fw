/**
 * The panel decoder, against a screen photographed off the real thermostat.
 *
 * THE FIXTURE AND THE EXPECTED READING BOTH COME FROM THE DEVICE, and the reading comes from an
 * INDEPENDENT decoder: `stm8/ble/lcd_read.py` read these thirteen bytes off a bench unit and rendered
 * them as `' 170'` with the moon, degree, dp-after-3, Auto and hour-tick icons lit. So this asserts
 * that two implementations of the same tables agree, rather than that this one is self-consistent.
 *
 * That matters more here than anywhere else in the app: the tables are generated from the firmware
 * image, and a wrong bit address does not throw — it draws a plausible screen that is not the one
 * on the glass.
 */
import { expect, test } from 'bun:test'

import { ICONS } from './lcd_tables'
import {
  PANEL_CANCEL,
  PANEL_LEASE,
  PANEL_ONCE,
  PANEL_RENEW_MS,
  barSlots,
  clearText,
  isPanel,
  litIcons,
  panelBytes,
  panelText,
  press,
  readPanel,
  releaseAll,
  showText,
  toGlyphs,
} from './panel'

/** The mapped segment RAM, read off the device while it showed 17.0 in auto mode on a Monday. */
const GLASS = new Uint8Array([
  0x0f, 0x00, 0x03, 0xa0, 0x42, 0x30, 0x00, 0x2e, 0x28, 0x03, 0x70, 0x80, 0x06,
])

test('the digits read as what the host tool rendered from the same bytes', () => {
  expect(panelText(GLASS)).toBe(' 170')
})

test('the icons read as what the host tool listed', () => {
  expect(litIcons(GLASS).map((i) => ICONS[i])).toEqual([
    'moon',
    'degree',
    'dp-after-3',
    'Auto',
    'hour-ticks',
  ])
})

test('the schedule bar reads as the host tool drew it', () => {
  // [------###--------######-] : slots 6,7,8 and 17..22, counting from the left.
  const on = barSlots(GLASS)
    .map((b, i) => (b ? i : -1))
    .filter((i) => i >= 0)
  expect(on).toEqual([6, 7, 8, 17, 18, 19, 20, 21, 22])
})

test('a whole panel is ONE read, and it names NO ADDRESS', () => {
  // The only argument is a MODE. The assertion that matters is that nothing longer appears: a third
  // byte would mean an address had come back into this app, which is what the command exists to
  // remove. The bytes it answers are held to the device in the fixtures above.
  expect(readPanel()).toEqual([0x23, PANEL_ONCE])
  expect(readPanel(PANEL_LEASE)).toEqual([0x23, 1])
  expect(readPanel(PANEL_CANCEL)).toEqual([0x23, 2])
})

/** What the firmware's `PANEL_LEASE_TICKS` is worth in milliseconds — 20 ticks of half a second. */
const LEASE_MS = 10_000

test('a renewal comes round well inside the lease', () => {
  // The floor that actually matters: renewing slower than the lease would drop the subscription on
  // every cycle rather than occasionally.
  expect(PANEL_RENEW_MS).toBeLessThan(LEASE_MS)

  // AND THE MARGIN AGAINST ONE LOST RENEWAL IS ZERO AT THIS PAIR, recorded rather than asserted
  // away: two renewals fill the lease EXACTLY, so a dropped frame puts the retry on the same tick
  // the lease expires on. It self-heals -- the next renewal re-arms -- but the mirror shows a gap.
  // Widening the LEASE is what buys margin; renewing faster only costs the thermostat wakes.
  expect(PANEL_RENEW_MS * 2).toBe(LEASE_MS)
})

test('the reply is unwrapped past its id and tag', () => {
  const reply = new Uint8Array([0x01, 0x23, ...GLASS])
  expect(isPanel(reply)).toBe(true)
  expect(panelBytes(reply)).toEqual(GLASS)
  // A short frame is refused rather than decoded into a half-screen.
  expect(panelBytes(new Uint8Array([0x01, 0x23, 1, 2, 3]))).toBeNull()
  // The old block read answered under the address low byte; that tag is not this command's.
  expect(isPanel(new Uint8Array([0x01, 0x0c, ...GLASS]))).toBe(false)
})

/**
 * A `cmd 0x23` reply EXACTLY AS THE DEVICE SENT IT, so this app's envelope is held to the wire and
 * not to a frame this file made up.
 *
 * Captured off a bench unit with both chips on this tree's build. The same connection was asked for
 * the old block read (`18 54 0C 0D`) and answered `01 0C` followed by these identical thirteen
 * bytes, which is what proves the new command returns the same glass and not merely a plausible
 * one. `stm8/ble/lcd_read.py` rendered them as ' 170' with moon, degree and Auto lit.
 */
const REPLY_23 = new Uint8Array([
  0x01, 0x23, 0x0f, 0x01, 0x03, 0xa0, 0x02, 0x30, 0x00, 0x2e, 0x28, 0x03, 0x70, 0x80, 0x06,
])

test('a REAL cmd 0x23 reply off the device is accepted and decodes to its screen', () => {
  expect(isPanel(REPLY_23)).toBe(true)
  const bits = panelBytes(REPLY_23)
  expect(bits).not.toBeNull()
  expect(bits!.length).toBe(13)
  expect(panelText(bits!)).toBe(' 170')
  expect(litIcons(bits!).map((i) => ICONS[i])).toEqual([
    'moon',
    'degree',
    'dp-after-3',
    'Auto',
    'hour-ticks',
  ])
})

test('a tap is hold 0, and a hold is in half-seconds', () => {
  expect(press(2)).toEqual([0x19, 2, 0]) // MODE, tapped
  expect(press(0x86, 3)).toEqual([0x19, 0x86, 3]) // the child-lock grip, 1.5 s
  expect(releaseAll()).toEqual([0x19, 0])
})

/**
 * THE EXPECTED GLYPHS COME FROM THE HOST TOOL, not from reading this app's own code back: each row
 * is `python3 stm8/ble/lcd_text.py`'s `to_glyphs()` for that string. Both sides are fed the same
 * table — `stm8/ble/lcd_font.py`, copied in here by the generator — so this asserts the two
 * implementations of the padding and alignment rules agree, which is the half no table can check.
 */
test('short messages are right-aligned in the window and long ones are not', () => {
  expect(toGlyphs('Hi').glyphs).toEqual([255, 255, 17, 18, 255, 255, 255, 255, 255])
  expect(toGlyphs('COLd').glyphs).toEqual([12, 24, 21, 13, 255, 255, 255, 255, 255])
  // Past four cells it scrolls, so it starts at the first letter instead.
  expect(toGlyphs('bAtt Lo').glyphs).toEqual([11, 10, 29, 29, 255, 21, 24, 255, 255])
  expect(toGlyphs('HEAt On').glyphs).toEqual([17, 14, 10, 29, 255, 24, 23, 255, 255])
})

test('a letter with no shape is reported, never quietly swapped', () => {
  // Lower case with no shape of its own borrows the case that has one, and that is not a failure.
  expect(toGlyphs('hi').glyphs).toEqual(toGlyphs('HI').glyphs)
  // These have no shape at all on seven segments.
  expect(toGlyphs('?').bad).toEqual(['?'])
  expect(toGlyphs('a?b!').bad).toEqual(['?', '!'])
  // The drawable characters still come through, so the field stays the right length either way.
  expect(toGlyphs('a?b!').glyphs.length).toBe(9)
})

test('a paint is always sixteen bytes, because the relay buffer is not cleared', () => {
  const { glyphs } = toGlyphs('Hi')
  const frame = showText(glyphs, 0xff)
  expect(frame.length).toBe(16)
  expect(frame[0]).toBe(0x0f)
  expect(frame[10]).toBe(0xff) // the hold
  expect(frame.slice(11)).toEqual([0, 0, 0, 0, 0]) // icons and bar, off — the message owns the panel
})

test('clearing is a hold of zero, with a blank field', () => {
  expect(clearText()).toEqual([0x0f, ...Array(9).fill(255), 0, 0, 0, 0, 0, 0])
})
