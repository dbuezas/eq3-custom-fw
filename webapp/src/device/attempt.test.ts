/**
 * One command out, one reply in — the ordering inside `attempt`, which nothing else covers.
 *
 * **WHY THIS FILE EXISTS.** `link.ts`'s header records that all three concurrency bugs found in one
 * evening were inside that file. `attempt` is the function every command in the app goes through,
 * and its three steps have to happen in one order:
 *
 *   1. register the waiter — BEFORE the write, because a reply can arrive while the write is still
 *      settling, and a waiter registered afterwards would miss it;
 *   2. write;
 *   3. start the reply clock — AFTER the write, or the window is `REPLY_TIMEOUT_MS` MINUS however
 *      long sending took. That bites the longest commands hardest: a sealed command over
 *      `ENV_MAXIN` bytes is three writes rather than one (`sealed.ts`'s `stageCommand`), which is
 *      every schedule write.
 *
 * And the step that makes the reordering dangerous rather than free: a write that THROWS happens
 * with the waiter already armed, so it has to be settled by hand. A waiter left unresolved is a
 * promise no caller's `await` ever returns from — worse than the bound it was fixing.
 *
 * **IT DRIVES `attempt` RATHER THAN `request`, for a reason worth knowing before moving it back.**
 * `flashfail.test.tsx` mocks `@/device/link`, and a bun module mock replaces the exports it names
 * and passes the rest through — so a test that went in through `request` would get that file's
 * canned version reply instead of the real path, and only when the whole suite runs. The link and
 * its `Io` are doubles here; everything inside `attempt` is real.
 */
import { expect, test } from 'bun:test'

import { attempt } from './link'
import type { Io } from './link'
import type { Match, Reply } from './protocol'

type FakeWaiter = { match: Match; resolve: (b: Reply | null) => void }

/**
 * The fields `attempt` and `writeCommand` actually read.
 *
 * No key and no session, so the command goes out on the plaintext characteristic — the encrypted
 * envelope has its own tests in `sealed.test.ts`, and the ordering under test here is the same
 * either way.
 */
const fakeLink = () => ({
  cmdCh: {} as unknown,
  waiters: [] as FakeWaiter[],
  sealKey: null,
  session: null,
  encCh: null,
})

/** An `Io` whose only live method is the write, whose timing each test controls. */
const fakeIo = (write: () => Promise<void>) => ({ write }) as unknown as Io

/** Let every pending microtask and zero-delay timer run. */
const tick = () => new Promise((r) => setTimeout(r, 0))

const anything: Match = () => true

test('A WRITE THAT FAILS SETTLES THE WAITER — it does not leave one armed for ever', async () => {
  // THE REGRESSION THIS FILE IS REALLY FOR. The waiter is pushed before the write, so a throwing
  // write has to remove and settle it. If it did not, this `await` would never return and the test
  // would hang rather than fail — which is exactly what the app would do.
  const l = fakeLink()
  const io = fakeIo(() => Promise.reject(new Error('the link went')))
  expect(await attempt(l as never, io, [0x00], anything)).toBeNull()
  expect(l.waiters).toHaveLength(0)
})

test('the waiter is listening BEFORE the write resolves, so a reply mid-write is not lost', async () => {
  let finishWrite!: () => void
  const l = fakeLink()
  const p = attempt(l as never, fakeIo(() => new Promise<void>((r) => (finishWrite = r))), [0x00], anything)
  await tick()
  // The write has not come back yet and the app is already listening.
  expect(l.waiters).toHaveLength(1)
  l.waiters[0]!.resolve(new Uint8Array([0x01, 0x09]))
  finishWrite()
  expect([...(await p)!]).toEqual([0x01, 0x09])
})

test('a reply that arrives after the write is delivered', async () => {
  const l = fakeLink()
  const p = attempt(l as never, fakeIo(() => Promise.resolve()), [0x00], anything)
  await tick()
  expect(l.waiters).toHaveLength(1)
  l.waiters[0]!.resolve(new Uint8Array([0x01, 0x16]))
  expect([...(await p)!]).toEqual([0x01, 0x16])
})

test('THE REPLY WINDOW STARTS AFTER THE WRITE, not when the command was queued', async () => {
  // A write deliberately slower than the whole reply timeout. Under the old ordering the clock was
  // armed first, so the window had already expired by the time the bytes were out and this reply —
  // arriving immediately after a successful write — was reported as "no answer". Real timers, so
  // the test is slow on purpose rather than coupled to the value of the constant.
  const l = fakeLink()
  const p = attempt(
    l as never,
    fakeIo(() => new Promise<void>((r) => setTimeout(r, 1700))),
    [0x00],
    anything,
  )
  await new Promise((r) => setTimeout(r, 1900))
  expect(l.waiters).toHaveLength(1)
  l.waiters[0]!.resolve(new Uint8Array([0x01, 0x00]))
  expect([...(await p)!]).toEqual([0x01, 0x00])
})
