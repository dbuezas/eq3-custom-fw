import { expect, test } from 'bun:test'

import { ageTint, signalTint } from './tint'

/** The hue out of `hsl(H 70% 45%)`, which is the only part the ramp varies. */
const hue = (c: string) => Number(/hsl\((\d+)/.exec(c)![1])

// THE THREE NAMED STOPS, checked exactly, because they are the owner's numbers and everything else
// is interpolation between them. 140 is green, 48 gold, 0 red.
test('signal: the three stops land on green, yellow and red', () => {
  expect(hue(signalTint(-70))).toBe(140)
  expect(hue(signalTint(-80))).toBe(48)
  expect(hue(signalTint(-90))).toBe(0)
})

test('age: the three stops land on green, yellow and red', () => {
  expect(hue(ageTint(1))).toBe(140)
  expect(hue(ageTint(3))).toBe(48)
  expect(hue(ageTint(5))).toBe(0)
})

// PAST THE ENDS IT CLAMPS rather than wrapping the hue circle. Without this a very strong signal
// would run past green into cyan and a very old reading past red into magenta -- both of which look
// like a NEW state rather than more of the same one.
test('it clamps outside the range instead of wrapping', () => {
  expect(hue(signalTint(-30))).toBe(140)
  expect(hue(signalTint(-120))).toBe(0)
  expect(hue(ageTint(0))).toBe(140)
  expect(hue(ageTint(3600))).toBe(0)
})

// THE SIGN IS THE TRAP: RSSI arrives negative, so -90 is WORSE than -70 and a plain comparison gets
// it backwards. This is the test that would have caught that.
test('a weaker signal is redder, despite being a smaller number', () => {
  expect(hue(signalTint(-85))).toBeLessThan(hue(signalTint(-75)))
})

test('it really interpolates between the stops', () => {
  const mid = hue(signalTint(-75))
  expect(mid).toBeLessThan(140)
  expect(mid).toBeGreaterThan(48)
  const old = hue(ageTint(4))
  expect(old).toBeLessThan(48)
  expect(old).toBeGreaterThan(0)
})
