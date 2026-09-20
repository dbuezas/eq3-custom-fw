/**
 * The info reply's SERIAL, which is what identifies a thermostat the MAC command cannot reach.
 *
 * Worth a test of its own because the encoding is not the obvious one and the failure is silent:
 * read as plain ASCII the bytes yield unprintable rubbish, `serialOf` correctly returns null, and
 * the only visible symptom is a thermostat that quietly keys its row on something else. That is
 * exactly what happened on the device before the +0x30 was known.
 */
import { expect, test } from 'bun:test'

import { serialOf } from './protocol'

/** `01 <ver> <b3> <b4> <serial>` — the shape `isInfo` accepts, with the serial obfuscated as sent. */
const reply = (serial: string, ver = 200) =>
  new Uint8Array([
    0x01,
    ver,
    0,
    0,
    ...Array.from(serial, (c) => (c.charCodeAt(0) + 0x30) & 0xff),
    // the frame is padded to 11; 0x30 is what a zero byte looks like after the firmware's offset
    ...Array.from({ length: Math.max(0, 11 - serial.length) }, () => 0x30),
  ])

test('a serial is read back through the +0x30 the firmware applies', () => {
  // Real serials are ten characters in this shape -- `app_init` copies ten ASCII bytes out of the
  // UBC page and `build_info_reply` adds 0x30 to each on the way out. These two are invented; no
  // test here needs a real device's identity, and one would be published with this repo.
  // **KEEP THE LEADING `P`**: the last test in this file asserts it goes out as 0x80.
  expect(serialOf(reply('PEQ0000000'))).toBe('PEQ0000000')
  expect(serialOf(reply('OEQ0000001'))).toBe('OEQ0000001')
})

test('the ELEVENTH byte is not part of it, because that cell moves', () => {
  // The frame carries eleven; the serial in RAM is ten, and the byte after it is the pairing-PIN
  // cache. A row keyed on eleven would be re-filed under a new identity when the PIN changed.
  const withPin = reply('PEQ0000000')
  withPin[14] = 0x38 + 0x30 // whatever `g_pin_b0` happens to hold
  expect(serialOf(withPin)).toBe('PEQ0000000')
  withPin[14] = 0xff // ...the boot sentinel, a completely different value
  expect(serialOf(withPin)).toBe('PEQ0000000')
})

test('read as plain ASCII it would be rubbish, which is the bug this encodes', () => {
  // 'P' goes out as 0x80. Anything that treats the wire bytes as ASCII sees no serial at all.
  const raw = reply('PEQ0000000')
  expect(raw[4]).toBe(0x80)
  expect(String.fromCharCode(raw[4]!)).not.toBe('P')
})

test('bytes that do not decode to printable text are refused, not cleaned up', () => {
  // A row keyed on half-decoded rubbish cannot be matched again, so the same thermostat would join
  // the list afresh on every connection -- worse than having no row.
  const junk = new Uint8Array([0x01, 200, 0, 0, ...Array.from({ length: 11 }, () => 0x03)])
  expect(serialOf(junk)).toBeNull()
})

test('a reply too short to hold one yields null rather than a fragment', () => {
  expect(serialOf(new Uint8Array([0x01, 200, 0, 0, 0x80, 0x75]))).toBeNull()
})
