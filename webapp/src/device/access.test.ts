/**
 * The access commands: the PIN's packed BCD, the key's three writes, and the status reply's flags.
 *
 * The one that has actually misled people is `storeRead`: "the radio has not read its key store
 * yet" and "there is no key" both leave `present` at 0, and reporting the first as the second has
 * happened twice. A decoder that loses that distinction cannot be corrected by the UI above it.
 */
import { expect, test } from 'bun:test'

import {
  KEY_CHARS,
  cleanKey,
  clearDeviceKey,
  clearPin,
  decodeKeyStatus,
  setDeviceKey,
  setPin,
  spellsClear,
  switchStored,
} from './access'

const hex = (s: string) => new Uint8Array(s.match(/../g)!.map((h) => parseInt(h, 16)))
const KEY = '000102030405060708090a0b0c0d0e0f'

test('the PIN is packed BCD, two digits per byte', () => {
  expect(setPin('123456')).toEqual([0x1e, 0x12, 0x34, 0x56])
  expect(setPin('000001')).toEqual([0x1e, 0x00, 0x00, 0x01])
})

test('anything that is not six digits never reaches the wire', () => {
  expect(setPin('12345')).toBeNull()
  expect(setPin('1234567')).toBeNull()
  expect(setPin('12345a')).toBeNull()
  expect(setPin('')).toBeNull()
})

test('clearing the PIN is all zeros, which is why 000000 cannot be chosen', () => {
  expect(clearPin()).toEqual([0x1e, 0, 0, 0])
  // ...and the app must not offer it as a PIN, because the device reads it as "forget".
  expect(setPin('000000')).toEqual(clearPin())
})

test('a key goes out as three writes: low half, high half, apply', () => {
  const w = setDeviceKey(KEY)!
  expect(w).toHaveLength(3)
  expect(w[0]).toEqual([0x51, 0x00, 0, 0, 1, 2, 3, 4, 5, 6, 7])
  expect(w[1]).toEqual([0x51, 0x00, 8, 8, 9, 10, 11, 12, 13, 14, 15])
  expect(w[2]).toEqual([0x51, 0x01, 0xa5])
})

test('clearing is sixteen zero bytes, in the same three writes', () => {
  const w = clearDeviceKey()
  expect(w[0]!.slice(3)).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  expect(w[2]).toEqual([0x51, 0x01, 0xa5])
})

test('a malformed key is refused rather than padded or truncated', () => {
  expect(setDeviceKey('00')).toBeNull()
  expect(setDeviceKey(KEY + '00')).toBeNull()
  expect(setDeviceKey('z'.repeat(32))).toBeNull()
})

test('"not asked yet" is NOT "no key" — the flag that separates them', () => {
  //            51 sub present enc loaded cfg rc  mac x6
  const asked = decodeKeyStatus(hex('510201010103' + '00' + '001a22aabbcc'))!
  expect(asked.present).toBe(true)
  expect(asked.storeRead).toBe(true)

  const notAsked = decodeKeyStatus(hex('510200000003' + '00' + '001a22aabbcc'))!
  expect(notAsked.present).toBe(false)
  expect(notAsked.storeRead).toBe(false) // so the UI must say "not known", never "no key"
})

test('page 6’s flags, including both of them off, which is a state and not a silence', () => {
  const on = decodeKeyStatus(hex('510201010103' + '00' + '001a22aabbcc'))!
  expect(on.broadcastOn).toBe(true)
  expect(on.pinGateOn).toBe(true)

  // ZERO IS BOTH SWITCHES OFF. It was read as "the radio has said nothing yet", which disabled
  // both rows in the UI and left no way to turn the broadcast back on -- reachable in one tap
  // from an ungated device. The radio's copy powers up at CFG_BTHOME, so there is no silence to
  // detect: 0 is only ever something somebody turned off.
  const bothOff = decodeKeyStatus(hex('510201010100' + '00' + '001a22aabbcc'))!
  expect(bothOff.broadcastOn).toBe(false)
  expect(bothOff.pinGateOn).toBe(false)
})

test('the address comes back in printed order, which is what the broadcast needs', () => {
  expect(decodeKeyStatus(hex('510201010103' + '00' + '001a22aabbcc'))!.mac).toBe('00:1a:22:aa:bb:cc')
})

test('a key survives being pasted out of somewhere that formatted it', () => {
  const key = '0123456789abcdef0123456789abcdef'
  // The shapes a key actually arrives in: from a YAML file, from a table, from a phone keyboard
  // that capitalised the first letter. Each has to land as the same 32 characters, because the
  // field applies this to every paste and the alternative is refusing a key that is correct.
  expect(cleanKey('0123456789ABCDEF0123456789ABCDEF')).toBe(key)
  expect(cleanKey('01234567 89abcdef 01234567 89abcdef')).toBe(key)
  expect(cleanKey('01:23:45:67:89:ab:cd:ef:01:23:45:67:89:ab:cd:ef')).toBe(key)
  expect(cleanKey(`  ${key}\n`)).toBe(key)
  // Longer than a key is truncated rather than rejected, so the field cannot exceed its own length.
  expect(cleanKey(key + key)).toHaveLength(KEY_CHARS)
  // And what it lets through is exactly what the writer accepts.
  expect(setDeviceKey(cleanKey('0123456789ABCDEF0123456789ABCDEF'))).not.toBeNull()
})

test('AN ALL-ZERO KEY IS "CLEAR", SO A FORM MUST REFUSE IT AND THE WRITER MUST NOT', () => {
  // `key_restore` in `ble_chip/mod/bthome.S` puts BKEY to zeros and KEY_PRESENT to 0, which is the
  // same convention the pairing passkey uses. So somebody typing 32 zeros into a key field would
  // switch encryption OFF while the counter read 32/32 and everything looked like a set.
  expect(spellsClear('0'.repeat(KEY_CHARS))).toBe(true)
  expect(spellsClear('0123456789abcdef0123456789abcdef')).toBe(false)
  // Trailing zeros are a perfectly good key; it is ALL of them that spells clear.
  expect(spellsClear('a0000000000000000000000000000000')).toBe(false)

  // **AND THE ENCODER STILL TAKES IT**, which is the half a guard in the wrong place would break:
  // `clearDeviceKey` IS those sixteen zeros, and the Forget button is the one caller that means it.
  expect(clearDeviceKey()).toEqual(setDeviceKey('0'.repeat(KEY_CHARS))!)
  expect(clearDeviceKey()).toHaveLength(3)
})

test('a refused switch row is null, not a stored zero', () => {
  // Row 3 is "start pairing", which the firmware refuses: `01 1d 03 ff`.
  expect(switchStored(hex('011d03ff'))).toBeNull()
  expect(switchStored(hex('011d0001'))).toBe(1)
  expect(switchStored(hex('011d0000'))).toBe(0)
})
