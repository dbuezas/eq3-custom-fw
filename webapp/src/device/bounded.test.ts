/**
 * A Bluetooth operation that never answers must not be able to stop the app.
 *
 * **THIS IS A LIVENESS PROPERTY, and the failure it guards is a FREEZE, not a wrong answer**
 * `[owner]`. The app serialises every operation on the link, because Android allows exactly one
 * outstanding GATT operation. The reply to a command was bounded; the operation that SENT it was
 * not — so a browser-side call that never called back held the lock, and every later command in the
 * app queued behind it silently. From the outside the thermostat had simply stopped listening, and
 * the only way out was to disconnect and let the browser reject the stuck call.
 *
 * Nothing here can cancel such a call — Web Bluetooth has no cancel. What is under test is that we
 * stop WAITING for it, which is the part that was wedging everything.
 */
import { expect, test } from 'bun:test'

import { bounded } from './link'

const never = new Promise<string>(() => {}) // the shape of the defect: it never settles

test('AN OPERATION THAT NEVER ANSWERS GIVES UP, rather than waiting for ever', async () => {
  const started = Date.now()
  // **AWAITED, AND THAT IS THE WHOLE OF THE ASSERTION BELOW.** Without it the rejection is still
  // checked -- bun fails an un-awaited `.rejects` that does not hold -- but the elapsed-time line
  // runs the instant `bounded` is CALLED, so it measured about 0 ms and would have passed with the
  // bound set to an hour. The comment claimed the test watched it give up; it watched it start.
  await expect(bounded('a read', 30, never)).rejects.toThrow(/a read did not finish/)
  // ...and it gave up on its OWN clock: the operation it was given never settles, so anything short
  // of for ever can only have come from the timeout.
  expect(Date.now() - started).toBeLessThan(1000)
})

test('the message says WHICH operation, because the log is where this gets diagnosed', () => {
  expect(bounded('subscribing', 10, never)).rejects.toThrow(/subscribing/)
})

test('an operation that answers in time passes its value straight through', async () => {
  expect(await bounded('a read', 1000, Promise.resolve('bytes'))).toBe('bytes')
})

test('a REAL failure is not hidden by the bound — it arrives as itself', () => {
  const refused = Promise.reject(new Error('GATT operation not permitted'))
  // The device refusing a write is the case the app explains to a person (a wrong key, a gate). It
  // must not be turned into a timeout, which would send them looking at the wrong thing.
  expect(bounded('a write', 1000, refused)).rejects.toThrow(/not permitted/)
})

test('a slow-but-finishing operation is not cut off early', async () => {
  const slow = new Promise<string>((r) => setTimeout(() => r('late'), 40))
  expect(await bounded('a write', 400, slow)).toBe('late')
})
