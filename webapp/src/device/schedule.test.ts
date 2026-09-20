/**
 * The weekly programme's encoding and its send plan.
 *
 * THE FIXTURE IS A MEASUREMENT: `210322242a3622662a8a229022902290` is what a bench unit answered
 * `20 03` with, and `../../../PROTOCOL.md` reads it as 17.0 until 06:00, 21.0 until 09:00, 17.0 until 17:00,
 * 21.0 until 23:00. If this decoder disagrees with that sentence, one of them is wrong.
 *
 * The plan is tested because it is the only place that knows day GROUPS exist, and getting it wrong
 * is silent: a week sent as seven writes is merely slow, but a week sent as one group write when
 * the days differ puts the wrong programme on five days.
 */
import { expect, test } from 'bun:test'

import {
  END_OF_DAY,
  GROUP_ALL,
  GROUP_WEEKDAYS,
  GROUP_WEEKEND,
  decodeDay,
  defaultWeek,
  pad,
  plan,
  problem,
  trim,
  writeDay,
  type Day,
} from './schedule'

const hex = (s: string) => new Uint8Array(s.match(/../g)!.map((h) => parseInt(h, 16)))
const REAL = hex('210322242a3622662a8a229022902290')

test('the day measured on the device decodes to what the protocol spec says it means', () => {
  const day = decodeDay(REAL)!
  expect(day).toHaveLength(7)
  expect(day[0]).toEqual({ temp: 17, until: 360 }) // 17.0 until 06:00
  expect(day[1]).toEqual({ temp: 21, until: 540 }) // 21.0 until 09:00
  expect(day[2]).toEqual({ temp: 17, until: 1020 }) // 17.0 until 17:00
  expect(day[3]).toEqual({ temp: 21, until: 1380 }) // 21.0 until 23:00
  expect(day[4]).toEqual({ temp: 17, until: END_OF_DAY })
  // ...and the padding, which is how a five-switch day fills a seven-slot frame.
  expect(day[5]).toEqual({ temp: 17, until: END_OF_DAY })
  expect(day[6]).toEqual({ temp: 17, until: END_OF_DAY })
})

test('a decoded day re-encodes to the SAME BYTES it arrived as', () => {
  // Everything after the id: the write is `10 <day> …` and the reply `21 <day> …`, so the ids
  // differ by construction and the payload must not.
  expect(writeDay(3, decodeDay(REAL)!).slice(1)).toEqual([...REAL].slice(1))
})

test('a short day is PADDED to seven slots, never truncated or sent short', () => {
  const short: Day = [
    { until: 480, temp: 18 },
    { until: END_OF_DAY, temp: 21 },
  ]
  const bytes = writeDay(9, short)
  expect(bytes).toHaveLength(2 + 7 * 2) // the frame carries seven whatever the day holds
  expect(pad(short)).toHaveLength(7)
  // The padding repeats the LAST temperature at 24:00 -- it does not invent one.
  expect(pad(short).slice(2).every((s) => s.temp === 21 && s.until === END_OF_DAY)).toBe(true)
})

test('trim gives back only the switch points a person put there', () => {
  expect(trim(decodeDay(REAL)!)).toHaveLength(5)
})

test('the whole week goes out as ONE command when every day is the same', () => {
  const p = plan(defaultWeek())
  expect(p).toHaveLength(1)
  expect(p[0]!.day).toBe(GROUP_ALL)
})

test('weekend and weekdays are two commands, in that shape', () => {
  const week = defaultWeek()
  for (const d of [0, 1]) week[d] = [{ until: END_OF_DAY, temp: 19 }]
  const p = plan(week)
  expect(p.map((x) => x.day)).toEqual([GROUP_WEEKEND, GROUP_WEEKDAYS])
})

test('an irregular week falls back to one command per day, and never a wrong group', () => {
  const week = defaultWeek()
  week[4] = [{ until: END_OF_DAY, temp: 23 }] // one weekday differs
  const p = plan(week)
  expect(p.map((x) => x.day)).toEqual([GROUP_WEEKEND, 2, 3, 4, 5, 6])
  // The days that were the same are still each sent their OWN programme, not day 2's.
  expect(p.find((x) => x.day === 4)!.slots[0]!.temp).toBe(23)
})

test('a plan always covers all seven days exactly once', () => {
  const week = defaultWeek()
  week[0] = [{ until: 600, temp: 20 }, { until: END_OF_DAY, temp: 16 }]
  const covered = plan(week).flatMap((p) =>
    p.day === GROUP_ALL ? [0, 1, 2, 3, 4, 5, 6] : p.day === GROUP_WEEKEND ? [0, 1] : p.day === GROUP_WEEKDAYS ? [2, 3, 4, 5, 6] : [p.day],
  )
  expect([...covered].sort()).toEqual([0, 1, 2, 3, 4, 5, 6])
})

test('the constraints the firmware does not check', () => {
  expect(problem(decodeDay(REAL)!)).toBeNull()
  expect(problem([{ until: 600, temp: 20 }, { until: 300, temp: 18 }, { until: END_OF_DAY, temp: 17 }]))
    .toContain('forwards')
  expect(problem([{ until: 605, temp: 20 }, { until: END_OF_DAY, temp: 17 }])).toContain('ten-minute')
  expect(problem([{ until: END_OF_DAY, temp: 31 }])).toContain('4.5 to 30')
  expect(problem([{ until: END_OF_DAY, temp: 20.3 }])).toContain('half degrees')
})
