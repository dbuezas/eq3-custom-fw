/**
 * The advertised-name command: what goes on the wire, and what the reply means.
 *
 * The two that would actually bite are the ones about COUNTING and about the LIMIT. A name is
 * measured in UTF-8 bytes and not characters, so a field that counts `.length` accepts a name the
 * device refuses; and the limit belongs to the firmware and arrives in the reply, so a test that
 * hard-codes sixteen would pass here and be wrong on the next release. Both are asserted below
 * against a `max` the test supplies, never against a constant from the module.
 */
import { expect, test } from 'bun:test'

import {
  ADV_NAME_DEFAULT,
  ADV_NAME_PREFIX,
  aired,
  clearAdvName,
  count,
  decodeAdvName,
  isDefaultAdvName,
  readAdvName,
  setAdvName,
} from './advname'

const reply = (...b: number[]) => new Uint8Array(b)
const ascii = (s: string) => Array.from(new TextEncoder().encode(s))

test('a name is counted in UTF-8 bytes, not characters', () => {
  expect(count('Kitchen')).toBe(7)
  expect(count('Küche')).toBe(6) // five characters
  expect(count('🔥')).toBe(4) // one character
})

test('a short name is one stage, padded, plus the apply', () => {
  const w = setAdvName('Hall', 16)!
  expect(w).toHaveLength(2)
  expect(w[0]).toEqual([0x5b, 0x00, 0, ...ascii('Hall'), 0, 0, 0, 0])
  // The length in the apply is what says how many staged bytes are the name, so the zero padding
  // above is never aired.
  expect(w[1]).toEqual([0x5b, 0x01, 4, 0xa5])
})

test('a name over eight bytes is two stages, at 0 and 8', () => {
  const w = setAdvName('Living room', 16)!
  expect(w).toHaveLength(3)
  expect(w[0]).toEqual([0x5b, 0x00, 0, ...ascii('Living r')])
  expect(w[1]).toEqual([0x5b, 0x00, 8, ...ascii('oom'), 0, 0, 0, 0, 0])
  expect(w[2]).toEqual([0x5b, 0x01, 11, 0xa5])
})

test('the apply always carries its guard byte', () => {
  // A three-byte apply would take its LENGTH from the previous write's tail, which is name bytes.
  for (const n of ['a', 'exactly 16 bytes']) expect(setAdvName(n, 16)!.at(-1)!).toHaveLength(4)
  expect(clearAdvName()).toEqual([0x5b, 0x01, 0, 0xa5])
})

test('the limit is the caller`s, so a longer device can accept a longer name', () => {
  expect(setAdvName('12345678901234567', 16)).toBeNull()
  expect(setAdvName('12345678901234567', 20)).not.toBeNull()
  // ...and it is bytes that are measured, so five accented characters can be too long at 8.
  expect(setAdvName('ÄÖÜäö', 8)).toBeNull()
  expect(count('ÄÖÜäö')).toBe(10)
})

test('an empty name never reaches the wire as a set — clearing is its own command', () => {
  expect(setAdvName('', 16)).toBeNull()
})

test('the reply carries the name as its tail, so its length is the frame`s', () => {
  const r = decodeAdvName(reply(0x5b, 0x02, 0, 16, ...ascii('Küche')))!
  expect(r.name).toBe('Küche')
  expect(r.max).toBe(16)
  expect(r.error).toBeNull()
})

test('an empty name is a four-byte reply, not a malformed one', () => {
  const r = decodeAdvName(reply(0x5b, 0x01, 0, 16))!
  expect(r.name).toBe('')
  expect(r.max).toBe(16)
})

test('a refusal is reported and still carries the name that is STILL in force', () => {
  const r = decodeAdvName(reply(0x5b, 0x01, 1, 16, ...ascii('Hall')))!
  expect(r.error).toMatch(/refused/)
  // The row must keep showing this, not the name that was rejected.
  expect(r.name).toBe('Hall')
})

test('a result code this app does not know is reported rather than treated as success', () => {
  expect(decodeAdvName(reply(0x5b, 0x01, 9, 16))!.error).toMatch(/\(9\)/)
})

test('another command`s reply is not mistaken for this one', () => {
  expect(decodeAdvName(reply(0x51, 0x02, 0, 16))).toBeNull()
  expect(decodeAdvName(reply(0x5b, 0x02, 0))).toBeNull()
})

test('the default name is what clearing restores, and what discovery looks for', () => {
  expect(isDefaultAdvName(ADV_NAME_DEFAULT)).toBe(true)
  expect(isDefaultAdvName('Living room')).toBe(false)
  expect(readAdvName()).toEqual([0x5b, 0x02])
})

test('a custom name is aired under the prefix, and the default is aired bare', () => {
  // The thermostat adds the prefix; nothing here sends it. So what is SET and what is REPORTED are
  // the owner's text, and only the air differs — mixing those up makes a working rename read as a
  // device that never took the name.
  expect(aired('Kitchen')).toBe('eQ3-Kitchen')
  // The default must stay bare or an un-renamed thermostat stops matching the stock matchers, which
  // is the discovery the prefix exists to protect.
  expect(aired(ADV_NAME_DEFAULT)).toBe(ADV_NAME_DEFAULT)
  expect(aired('')).toBe('')
  // ...and the two must stay distinguishable: a default that began with the prefix would make the
  // chooser's two filter entries collapse into one.
  expect(ADV_NAME_DEFAULT.startsWith(ADV_NAME_PREFIX)).toBe(false)
})

test('the prefix is not counted against the limit the device reports', () => {
  // `max` applies to the text a person types. Counting the prefix here would refuse names the
  // thermostat accepts, and the limit would stop coming off the wire.
  const max = 15
  expect(setAdvName('123456789012345', max)).not.toBeNull()
  expect(count('123456789012345')).toBe(max)
  expect(aired('123456789012345').length).toBe(max + ADV_NAME_PREFIX.length)
})
