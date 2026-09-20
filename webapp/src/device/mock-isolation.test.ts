/**
 * A MODULE MOCK IN ONE TEST FILE MUST NOT REACH THIS ONE.
 *
 * `src/components/flashfail.test.tsx` replaces `@/device/link` with a stand-in so it can drive the
 * install flow without a radio. A bun module mock is PROCESS-WIDE and replaces the exports its
 * factory names while passing the rest through — so without a restore, every file discovered after
 * it silently gets that file's `request`, `flashThermostat`, `flashRadio` and `prepareForFlash`.
 *
 * **IT FAILS SILENTLY AND ONLY IN THE FULL SUITE.** A test written against `request` passes on its
 * own and gets a canned reply when the suite runs. That really happened: an earlier
 * `attempt.test.ts` went in through `request`, passed alone, and returned `01 c8 …` — a component
 * test's fake — under `bun run test`.
 *
 * **THREE FILES MOCK `@/device/link`** — `advname`, `flashfail` and `schedule-copy` — and each now
 * restores it in an `afterAll`. **THE RESTORES ARE A CHAIN, not three independent fixes:** each file
 * snapshots whatever is registered when it loads, so one missing restore is inherited by every
 * snapshot after it and this probe fails. Measured: removing any one of the three fails it.
 *
 * **THIS FILE IS THE PROBE, and it is only meaningful because of where it sits.** bun discovers
 * `src/components/` before `src/device/`, so this runs after those mocks are registered. If that
 * order ever changes the probe still passes, but it stops proving anything — so if you move it,
 * move it somewhere still later, never earlier.
 *
 * WHAT IT ASKS: does `request` still WRITE to the link it was handed? The real one goes
 * `retrying → withLink → attempt → writeCommand → io.write`. The stand-in takes no arguments and
 * answers a canned frame, so it never touches the link at all. That is a property of the function
 * rather than of any test's leftover state, which matters because flashfail's own `reportsVersion`
 * is whatever its last test left behind.
 */
import { expect, test } from 'bun:test'

import { request } from './link'

test('a module mock registered by an EARLIER test file does not reach this one', async () => {
  let wrote = false
  const link = {
    queue: Promise.resolve(),
    dead: false,
    // Rejecting keeps this fast: `attempt` settles its waiter at once instead of spending the
    // whole reply timeout. What is under test is that the write was ATTEMPTED.
    cmdCh: {
      writeValueWithResponse: () => {
        wrote = true
        return Promise.reject(new Error('probe: the link is a double'))
      },
    },
    waiters: [],
    sealKey: null,
    session: null,
    encCh: null,
  }

  const r = await request([0x00], () => true, 1, link as never)

  expect(wrote).toBe(true) // the real `request` reaches the wire; the stand-in never would
  expect(r).toBeNull() // and a failed write is "no reply", not a thrown error
  expect(link.waiters).toHaveLength(0) // nor a waiter left armed behind it
})
