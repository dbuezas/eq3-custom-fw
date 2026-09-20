import { expect, test } from 'bun:test'

import { reassembler } from './sealed'

const frame = (ctr: number, more: boolean, ...bytes: number[]) => ({
  ctr,
  more,
  data: new Uint8Array(bytes),
})

// A COMPLETE REPLY MUST NOT BE THROWN AWAY BECAUSE OF WHAT CAME BEFORE IT.
//
// The counter check exists to notice a missing FIRST fragment, so that a lone tail is not delivered
// as though it were a whole message. But it also discarded a single-frame reply whose counter merely
// jumped -- and a counter jumps whenever anything at all was missed earlier in the connection. The
// effect is that ONE lost notification silently eats the NEXT good reply, which presents as a
// command that never answered.
test('a whole single-frame reply survives a counter jump', () => {
  const r = reassembler()
  expect(r.push(frame(0, false, 0x01, 0x00, 0xc8))).not.toBeNull() // first reply, in order
  // ...something is missed here, so the next counter is not the one expected...
  const late = r.push(frame(7, false, 0x01, 0x16, 0x2a))
  expect(late).not.toBeNull()
  expect(Array.from(late!)).toEqual([0x01, 0x16, 0x2a])
})

test("the FIRST reply of a connection survives even if its counter is not 0", () => {
  const r = reassembler()
  const first = r.push(frame(3, false, 0x01, 0x00, 0xc8))
  expect(first).not.toBeNull()
})

// THE TRADE-OFF, WRITTEN AS A TEST so it is a decision rather than an accident. A tail whose head
// was lost is now DELIVERED, because nothing distinguishes it from a whole single-frame reply: both
// are authenticated frames with `more` clear and no buffered head. The caller's matcher is what
// rejects it — and a matcher declining a frame is recoverable, while a reply deleted in here is not,
// since nothing above ever learns it existed.
test('a tail whose head was lost is delivered, for the caller to reject', () => {
  const r = reassembler()
  r.push(frame(0, false, 0x01, 0x00, 0xc8)) // establish the counter
  // A head (more=true) at ctr 1 is LOST; its tail arrives at ctr 2.
  expect(r.push(frame(2, false, 0xaa, 0xbb))).not.toBeNull()
})

// The head-and-tail pairing is still enforced, which is the half of the check that works: a buffered
// head is only completed by the very next counter, never spliced onto an unrelated frame.
test('a buffered head is abandoned rather than spliced onto the wrong tail', () => {
  const r = reassembler()
  expect(r.push(frame(0, true, 0x01, 0x00))).toBeNull() // head, waiting for ctr 1
  const wrong = r.push(frame(5, false, 0xaa, 0xbb)) // not its tail
  expect(Array.from(wrong!)).toEqual([0xaa, 0xbb]) // delivered alone, NOT joined to the head
})

test('two fragments in order still join', () => {
  const r = reassembler()
  expect(r.push(frame(0, true, 0x01, 0x00))).toBeNull()
  const whole = r.push(frame(1, false, 0xc8, 0x2a))
  expect(Array.from(whole!)).toEqual([0x01, 0x00, 0xc8, 0x2a])
})
