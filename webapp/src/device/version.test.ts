/**
 * How a version is written, and — the part that matters — what must NOT be written to compare one.
 *
 * **THE TRAP THIS GUARDS.** Two places asked "is this thermostat already on that release?" by
 * formatting the radio's version and comparing the STRING against the catalogue's `expect`. That
 * works right up until the format changes, and then fails silently and in the worst direction: every
 * such test answers no, so the app offers an upgrade to the version already installed, and the
 * firmware card claims a device is out of date when it is not. Adding the `v` prefix is exactly that
 * change, which is why `chipIs` exists and compares numbers.
 *
 * So the load-bearing assertion here is the last one: it fails if anyone ever reaches for the
 * display string again.
 */
import { expect, test } from 'bun:test'

import { chipIs, chipNumber, chipText, fwText, relText, releaseText } from './protocol'

test('every version is written with a v', () => {
  expect(fwText(200)).toBe('v2.00')
  expect(fwText(148)).toBe('v1.48')
  expect(chipText({ product: 0, major:5, minor: 0 })).toBe('v5.0')
  expect(relText('1.20')).toBe('v1.20')
})

test('the bare form has no prefix, for the badge that supplies the word itself', () => {
  // The firmware card's badge reads `radio 5.0`, so a `v` here would be a second label. A lone `5.0`
  // is only safe where something beside it says which chip it belongs to — which is why this form
  // exists for exactly one caller and `chipText` is what everything else uses.
  expect(chipNumber({ product: 0, major: 5, minor: 0 })).toBe('5.0')
  expect(chipNumber({ product: 0, major: 4, minor: 6 })).toBe('4.6')
})

test('a release names BOTH chips, because that is what a version here is', () => {
  expect(releaseText('2.00', '5.0')).toBe('v2.00 (radio v5.0)')
  expect(releaseText('1.48', '4.6')).toBe('v1.48 (radio v4.6)')
})

test('chipIs matches the catalogue’s own spelling, which carries no v', () => {
  expect(chipIs({ product: 0, major:5, minor: 0 }, '5.0')).toBe(true)
  expect(chipIs({ product: 0, major:4, minor: 6 }, '4.6')).toBe(true)
  expect(chipIs({ product: 0, major:4, minor: 6 }, '5.0')).toBe(false)
  // Both parts must match: a right major with a wrong minor is a different image, and 1.05 and 1.06
  // ship the same radio while 1.46 and 1.48 differ only in the minor.
  expect(chipIs({ product: 0, major:4, minor: 4 }, '4.6')).toBe(false)
  // Nonsense does not match anything, rather than matching by accident through NaN or a short split.
  expect(chipIs({ product: 0, major:5, minor: 0 }, '')).toBe(false)
  expect(chipIs({ product: 0, major:5, minor: 0 }, 'v5.0')).toBe(false)
})

test('CHIPIS DOES NOT COMPARE DISPLAY TEXT — the whole point of it existing', () => {
  // If this ever becomes a string comparison against `chipText`, it breaks the moment the format
  // changes, and it breaks by reporting a device as NOT on the version it is on.
  const c = { product: 0, major:5, minor: 0 }
  expect(chipText(c)).not.toBe('5.0') // the display form and the catalogue form differ...
  expect(chipIs(c, '5.0')).toBe(true) // ...and the comparison is unaffected by that
})
