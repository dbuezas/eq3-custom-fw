/**
 * The weekly programme — reading it, editing it, and working out the fewest commands to send it.
 *
 * ================================================================================================
 * THE WIRE'S TWO SURPRISES, both the opposite of what an editor would assume
 * ================================================================================================
 * 1. **A WRITE takes a day GROUP; a READ does not.** `cmd 0x10`'s day byte 7, 8 and 9 mean the
 *    weekend pair, the five weekdays and all seven — so a whole week can go out in ONE command.
 *    `cmd 0x20` always answers with exactly one day, and a group byte merely selects which day
 *    answers, echoing the group byte back rather than the day it came from. **So loading a week is
 *    seven reads.** An editor that reads `20 09` once and calls it "the week" silently shows one
 *    day's programme as all seven.
 * 2. **THERE ARE ALWAYS SEVEN SLOTS.** There is no count field: a day with four real switch points
 *    is expressed by repeating the last temperature at 24:00 for the remaining three. Sending six
 *    pairs where the frame carries seven leaves the seventh filled from whatever was in the
 *    device's buffer — that is a live defect in another client (`homeassistant/PLAN.md` `HA1`), and
 *    it is the same mistake waiting to be made twice.
 *
 * **THE GROUPS ARE AN IMPLEMENTATION DETAIL OF THE SEND, NOT A UI FEATURE** `[owner]`. Copying a
 * day onto other days is an operation on the local model and is free; it is good UI because it
 * saves typing, not because a command exists behind it. `plan()` below is where the wire shape
 * lives, and it is the only place that knows about groups at all.
 *
 * **THE FIRMWARE VALIDATES NOTHING** `[binary]` — `ble_cmd_10_set_program` masks the temperatures
 * and copies the time bytes through untouched — so every constraint is this file's.
 *
 * ================================================================================================
 * DAY 0 IS SATURDAY
 * ================================================================================================
 * `[manually verified]` — the device reported weekday 2 on a Monday. The EEPROM tables are indexed
 * `base + weekday * 7` in that numbering, and it is why the "weekend" group is days 0–1. A person
 * is shown Monday first; only this file knows the device's order.
 */

/** One switch point: everything up to `until` is heated to `temp`. */
export type Slot = {
  /** Minutes from midnight, a multiple of 10, 0…1440. 1440 is the end of the day. */
  until: number
  /** Degrees C, on the half-degree grid. */
  temp: number
}

/** Exactly seven slots, always — see the header. */
export type Day = Slot[]
/** Seven days, indexed the DEVICE's way: 0 = Saturday. */
export type Week = Day[]

export const SLOTS = 7
export const END_OF_DAY = 1440

/** Device weekday → what a person calls it. Index is the device's, order is not. */
export const DAY_NAMES = ['Saturday', 'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']
/** The order a week is shown in: Monday first, which is device indices 2…6, 0, 1. */
export const DISPLAY_ORDER = [2, 3, 4, 5, 6, 0, 1]

/** Day bytes 7, 8 and 9 — the write-only groups. */
export const GROUP_WEEKEND = 7
export const GROUP_WEEKDAYS = 8
export const GROUP_ALL = 9
/** Which days each group command covers. The editor's copy shortcuts offer the same three sets. */
export const WEEKEND = [0, 1]
export const WEEKDAYS = [2, 3, 4, 5, 6]
export const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6]

/* ---- the wire ------------------------------------------------------------------------------- */

/** `cmd 0x20 <day>` — read ONE day. A group byte here does not read a group; see the header. */
export const readDay = (day: number) => [0x20, day]

/** The reply is `21 <day echoed> <temp,time> × 7`. */
export const isDayReply = (b: Uint8Array) => b.length >= 16 && b[0] === 0x21

export function decodeDay(b: Uint8Array): Day | null {
  if (!isDayReply(b)) return null
  const day: Day = []
  for (let i = 0; i < SLOTS; i++) {
    day.push({ temp: b[2 + i * 2]! / 2, until: b[3 + i * 2]! * 10 })
  }
  return day
}

/** `cmd 0x10 <day or group> <temp,time> × 7`. The day is padded to seven slots first. */
export function writeDay(dayOrGroup: number, day: Day): number[] {
  const full = pad(day)
  const out = [0x10, dayOrGroup]
  for (const s of full) out.push(Math.round(s.temp * 2), Math.round(s.until / 10))
  return out
}

/** The device acks a programme write with its own frame, `02 02 …`. */
export const isProgramAck = (b: Uint8Array) => b.length >= 2 && b[0] === 0x02 && b[1] === 0x02

/* ---- the model ------------------------------------------------------------------------------ */

/**
 * Pad a short day out to seven slots by repeating the last temperature at the end of the day.
 * NEVER send fewer — see the header for what the device does with the slots you leave out.
 */
export function pad(day: Day): Day {
  const real = day.slice(0, SLOTS)
  const last = real[real.length - 1] ?? { until: END_OF_DAY, temp: 17 }
  while (real.length < SLOTS) real.push({ until: END_OF_DAY, temp: last.temp })
  real[SLOTS - 1] = { ...real[SLOTS - 1]!, until: END_OF_DAY }
  return real
}

/** The slots a person edits: the padding at the end is not a switch point they put there. */
export function trim(day: Day): Day {
  const out = [...day]
  while (out.length > 1 && out[out.length - 2]!.until >= END_OF_DAY) out.pop()
  return out
}

/** What is wrong with this day, in words, or null. The firmware checks none of it. */
export function problem(day: Day): string | null {
  const full = pad(day)
  let prev = 0
  for (const s of full) {
    if (s.until <= prev && s.until !== END_OF_DAY) return 'the times must go forwards'
    if (s.until % 10 !== 0) return 'times move in ten-minute steps'
    if (s.temp < 4.5 || s.temp > 30) return 'temperatures run from 4.5 to 30 °C'
    if (Math.round(s.temp * 2) !== s.temp * 2) return 'temperatures move in half degrees'
    prev = s.until
  }
  if (full[SLOTS - 1]!.until !== END_OF_DAY) return 'the last period must run to midnight'
  return null
}

const sameDay = (a: Day, b: Day) => {
  const [x, y] = [pad(a), pad(b)]
  return x.every((s, i) => s.temp === y[i]!.temp && s.until === y[i]!.until)
}

const allSame = (week: Week, days: number[]) =>
  days.every((d) => sameDay(week[days[0]!]!, week[d]!))

/**
 * The fewest commands that express this week. All seven equal is one write; weekend-equal and
 * weekdays-equal is two; anything else falls back to one per day. The person sees "sent", not a
 * strategy.
 */
export function plan(week: Week): { day: number; slots: Day }[] {
  if (allSame(week, EVERY_DAY)) return [{ day: GROUP_ALL, slots: week[0]! }]
  const out: { day: number; slots: Day }[] = []
  if (allSame(week, WEEKEND)) out.push({ day: GROUP_WEEKEND, slots: week[0]! })
  else for (const d of WEEKEND) out.push({ day: d, slots: week[d]! })
  if (allSame(week, WEEKDAYS)) out.push({ day: GROUP_WEEKDAYS, slots: week[2]! })
  else for (const d of WEEKDAYS) out.push({ day: d, slots: week[d]! })
  return out
}

/* ---- helpers the editor uses ----------------------------------------------------------------- */

export const hhmm = (mins: number) =>
  mins >= END_OF_DAY ? '24:00' : `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`

/** Copy one day onto others. A local operation with no command behind it — see the header. */
export function copyDay(week: Week, from: number, to: number[]): Week {
  return week.map((d, i) => (to.includes(i) ? pad(week[from]!).map((s) => ({ ...s })) : d))
}

/** A week where every day is the thermostat's own first-run programme, for a preset to start from. */
export function defaultWeek(): Week {
  const day: Day = [
    { until: 360, temp: 17 },
    { until: 540, temp: 21 },
    { until: 1020, temp: 17 },
    { until: 1380, temp: 21 },
    { until: END_OF_DAY, temp: 17 },
  ]
  return Array.from({ length: 7 }, () => day.map((s) => ({ ...s })))
}
