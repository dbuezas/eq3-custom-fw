/**
 * The sealed envelope, held BYTE FOR BYTE to the implementation the device's firmware was built
 * against.
 *
 * THE FIXTURE IS NOT A RECORDING OF THIS CODE. Every frame in `sealed_fixture.json` was produced by
 * `ble_chip/mod/bthome_crypto.py` — the same module the radio's own sealing was written from — and
 * `gen_sealed_fixture.py` is what regenerates it. So these tests can fail in the one way that
 * matters: a nonce byte order, a length field, the direction byte or the staging split that is
 * plausible in isolation and produces a frame the device silently DROPS. A test written against
 * this file's own output could not.
 *
 * If one of these fails, the Python is right and `sealed.ts` is wrong. Never regenerate the fixture
 * to make a test pass.
 */
import { expect, test } from 'bun:test'

import {
  ENV_MAXCOMMIT,
  ENV_MAXIN,
  PLAINTEXT_IDS,
  openReply,
  reassembler,
  sealCommand,
  stageCommand,
} from './sealed'
import fixture from './sealed_fixture.json'

const unhex = (s: string) => new Uint8Array(s.match(/../g)!.map((h) => parseInt(h, 16)))
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')

const KEY = unhex(fixture.key)
const SESSION = unhex(fixture.session)

test('an inline sealed command is byte-identical to the Python envelope', async () => {
  for (const c of fixture.inline) {
    const got = await sealCommand(KEY, SESSION, c.seq, unhex(c.inner))
    expect(`${c.what}: ${hex(got)}`).toBe(`${c.what}: ${c.frame}`)
  }
  expect(fixture.inline.length).toBeGreaterThan(3) // the fixture actually carries cases
})

test('a STAGED command produces the same writes, in the same order, with the same split', async () => {
  for (const c of fixture.staged) {
    const got = await stageCommand(KEY, SESSION, c.seq, unhex(c.inner))
    expect(`${c.what}: ${got.map(hex).join(' ')}`).toBe(`${c.what}: ${c.writes.join(' ')}`)
  }
})

test('THE INLINE CEILING IS 8 INNER BYTES, and one more is a refusal rather than a truncation', async () => {
  expect(ENV_MAXIN).toBe(fixture.env_maxin)
  expect(ENV_MAXCOMMIT).toBe(fixture.env_maxcommit)
  const nine = new Uint8Array(9)
  // A silently shortened command would be sealed, accepted and WRONG. It must throw.
  expect(sealCommand(KEY, SESSION, 1, nine)).rejects.toThrow(/1\.\.8 inline/)
  expect(sealCommand(KEY, SESSION, 1, new Uint8Array(0))).rejects.toThrow()
  // ...and nothing longer than the command attribute reaches the thermostat by any route.
  expect(stageCommand(KEY, SESSION, 1, new Uint8Array(17))).rejects.toThrow(/holds 16/)
})

test('a sealed reply opens to its plaintext, and says whether another fragment follows', async () => {
  for (const r of fixture.uplink) {
    const got = await openReply(KEY, SESSION, unhex(r.frame))
    expect(`${r.what}: ${hex(got.data)}`).toBe(`${r.what}: ${r.plain}`)
    expect(got.ctr).toBe(r.ctr)
    expect(got.more).toBe(r.more)
  }
})

test('A FRAME THAT IS NOT SEALED COMES BACK UNTOUCHED, because the notify channel is mixed', async () => {
  // The radio's own status codes and its serial arrive in the clear on the same handle. Only the
  // marker separates them, and LENGTH CANNOT: a sealed 1-byte reply is exactly the 8 bytes of the
  // nonce answer, which is why this test uses that exact length.
  const nonceAnswer = unhex('a1b2c3d4e5f60718')
  const got = await openReply(KEY, SESSION, nonceAnswer)
  expect(hex(got.data)).toBe('a1b2c3d4e5f60718')
  expect(got.ctr).toBe(null)
  expect(got.more).toBe(false)
})

test('a reply sealed with a DIFFERENT key is refused by the tag, not half-decoded', async () => {
  const wrong = new Uint8Array(16).fill(0xaa)
  expect(openReply(wrong, SESSION, unhex(fixture.uplink[0]!.frame))).rejects.toThrow(/tag mismatch/)
})

test('THE DIRECTION BYTE IS LOAD-BEARING: a downlink frame does not open as an uplink one', async () => {
  // Both directions share one key and one session nonce and differ only in that byte. If it were
  // dropped, a reply would share its keystream with the command that triggered it — and commands
  // are low-entropy, so one captured pair would give up the reply. The tag is what catches it here.
  const down = await sealCommand(KEY, SESSION, 0, new Uint8Array([0x02, 0x01, 0x09, 0x2a]))
  // Re-shape the downlink frame as though it were an uplink one of the same counter.
  const asUp = new Uint8Array([0x55, 0x00, 0x00, ...down.slice(8), ...down.slice(3, 7)])
  expect(openReply(KEY, SESSION, asUp)).rejects.toThrow(/tag mismatch/)
})

test('the plaintext ids are exactly the radio’s own pass-list', () => {
  expect([...PLAINTEXT_IDS].sort((a, b) => a - b)).toEqual(fixture.plaintext_ids)
})

/* ---- reassembly: the failure here is a WRONG ANSWER, not a missing one ------------------------ */

const part = (ctr: number, more: boolean, ...bytes: number[]) => ({
  data: new Uint8Array(bytes),
  ctr,
  more,
})

test('two fragments become one reply, in order', () => {
  const r = reassembler()
  expect(r.push(part(0, true, 0x01, 0x16))).toBe(null) // nothing to deliver yet
  expect([...r.push(part(1, false, 0x2a, 0x22))!]).toEqual([0x01, 0x16, 0x2a, 0x22])
})

test('a one-notification reply passes straight through', () => {
  const r = reassembler()
  expect([...r.push(part(0, false, 0x02, 0x01))!]).toEqual([0x02, 0x01])
  expect([...r.push(part(1, false, 0x02, 0x02))!]).toEqual([0x02, 0x02])
})

// THESE TWO ASSERTED THE OPPOSITE UNTIL A DEVICE DISAGREED, and they are kept — inverted — because
// the reversal is the point `[owner]` `[manually verified]`. The rule was "a complete frame whose
// counter is not the expected next one is a lost fragment, so drop it". On a phone that meant the
// thermostat's version never arrived over an encrypted link: the first reply of the connection was
// not counter 0, so it was deleted, and nothing above ever knew a reply had existed.
//
// The cost of each mistake is what decides it. Delivering a stray tail hands the caller's matcher a
// frame it will decline — recoverable, and invisible. Dropping a whole reply loses a command's
// answer with no trace, and it happens after ANY missed notification, so one loss becomes two.
test('a first frame that is not counter 0 is still delivered', () => {
  const r = reassembler()
  expect([...r.push(part(1, false, 0x18, 0x03))!]).toEqual([0x18, 0x03])
})

test('a lost first fragment leaves its tail deliverable, for the matcher to reject', () => {
  const r = reassembler()
  expect([...r.push(part(0, false, 0xaa))!]).toEqual([0xaa]) // a normal reply first
  // ctr 1 was the fragment that went missing; ctr 2 is its tail, marked as a last-or-only frame.
  // Nothing here can tell it from a one-notification reply, so it goes on and is judged above.
  expect([...r.push(part(2, false, 0xbb, 0xcc))!]).toEqual([0xbb, 0xcc])
})

test('a gap DURING a reply abandons the partial rather than splicing unrelated bytes into it', () => {
  const r = reassembler()
  expect(r.push(part(0, true, 0x01, 0x02))).toBe(null)
  // ctr 2, not 1: the middle fragment was lost. THE BUFFERED START MUST NOT BE JOINED TO THIS, which
  // is the half of the check that survives — the frame goes on ALONE, carrying none of the partial.
  // Splicing is the failure that would corrupt a reply; dropping was the one that deleted them.
  expect([...r.push(part(2, false, 0x03, 0x04))!]).toEqual([0x03, 0x04])
  // ...and the machine recovers: the next contiguous run delivers normally.
  expect(r.push(part(3, true, 0x05))).toBe(null)
  expect([...r.push(part(4, false, 0x06))!]).toEqual([0x05, 0x06])
})

test('reset() forgets a partial, which is what a frame that failed to OPEN must do', () => {
  const r = reassembler()
  expect(r.push(part(0, true, 0x01))).toBe(null)
  r.reset()
  // The counter is still tracked across the unopened frame, so ctr 1 is contiguous and delivers.
  expect([...r.push(part(1, false, 0x02))!]).toEqual([0x02])
})

test('the counter wraps at 16 bits, and a wrap is not a gap', () => {
  const r = reassembler()
  expect([...r.push(part(0, false, 0x00))!]).toEqual([0x00])
  // Walk it to the wrap without asserting each step, then check 0xffff -> 0x0000 is contiguous.
  for (let c = 1; c <= 0xffff; c++) r.push(part(c, false, c & 0xff))
  expect([...r.push(part(0, false, 0x99))!]).toEqual([0x99])
})
