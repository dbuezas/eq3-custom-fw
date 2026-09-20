/**
 * The broadcast's fields, described for a person.
 *
 * The case worth a test is the one that would otherwise be silent: an object this table has no row
 * for must still be SHOWN, because a value the device airs and the app hides looks exactly like a
 * value the device never sent.
 */
import { expect, test } from 'bun:test'

import type { BthomeValue } from './bthome.js'
import { decodeObjects } from './bthome.js'
import { BROADCAST_FIELDS, describeAll, describeSets, describeValues } from './readings'

const bytes = (s: string) => new Uint8Array(s.match(/../g)!.map((h) => parseInt(h, 16)))

test('a real set-0 payload reads as measurements, not as wire names', () => {
  // The bytes this thermostat actually aired, off a scan: current, target, battery, valve.
  const { values } = decodeObjects(bytes('029a0b0278050cde0c2f00'))
  expect(describeValues(values)).toEqual([
    { key: 'temperature', label: 'current', text: '29.7°' },
    { key: 'temperature #2', label: 'target', text: '14.0°' },
    { key: 'moisture/valve', label: 'valve', text: '0%' },
    { key: 'voltage', label: 'battery', text: '3.29 V' },
  ])
})

test('a real set-1 payload reads as words, never true or false', () => {
  const { values } = decodeObjects(bytes('2d001f010f0015000900'))
  expect(describeValues(values).map((r) => `${r.label} ${r.text}`)).toEqual([
    // NO "battery warning none": a warning that is not warning is the absence of news, and it
    // appeared on every row, pushing the readings that ARE news along the line.
    'window closed',
    'buttons unlocked',
    'boost off',
    // The wire object is a COUNT and the value is the mode -- the same two bits the status reply
    // carries, so `0` is auto. It read as `mode 0`, which is a number nobody can act on.
    'mode auto',
  ])
})

test('a battery warning appears only when there is one', () => {
  const say = (v: Record<string, boolean>) => describeValues(v).map((r) => `${r.label} ${r.text}`)
  expect(say({ battery_low: false })).toEqual([])
  expect(say({ battery_low: true })).toEqual(['battery LOW'])
  // The same rule, and the same reason, for the other flag that means "nothing is wrong".
  expect(say({ problem: false })).toEqual([])
  expect(say({ problem: true })).toEqual(['problem yes'])
})

test('the full table has the same rows before, during and after the two sets arrive', () => {
  // The shape is the guarantee: a panel that grows from four rows to nine while somebody watches
  // it, and rearranges again when a connection opens, reads as data being lost.
  const shape = (v: Record<string, BthomeValue>) => describeAll(v).map((r) => r.key)
  const nothing = shape({})
  expect(nothing).toEqual(BROADCAST_FIELDS)
  expect(shape(decodeObjects(bytes('029a0b0278050cde0c2f00')).values)).toEqual(nothing)
  expect(shape(decodeObjects(bytes('2d001f010f0015000900')).values)).toEqual(nothing)
  // Nothing heard yet is a dash per row, not a missing row.
  expect(describeAll({}).every((r) => r.text === null)).toBe(true)
  // And a warning that the compact view hides still has its line here.
  expect(describeAll({ battery_low: false }).find((r) => r.key === 'battery_low')?.text).toBe('ok')
})

test('the two columns are the two adverts — one fills while the other stays empty', () => {
  // The grouping is a claim about the WIRE, so it is held to real payloads: a set-0 advert must
  // fill the first column and leave the second entirely unheard, and the other way round. If the
  // firmware ever moves an object between sets, this is what says so.
  const set0 = decodeObjects(bytes('029a0b0278050cde0c2f00')).values
  const set1 = decodeObjects(bytes('2d001f010f0015000900')).values
  const heard = (v: Record<string, BthomeValue>) =>
    describeSets(v).map((g) => g.every((r) => r.text !== null))

  expect(heard(set0)).toEqual([true, false])
  expect(heard(set1)).toEqual([false, true])
  expect(heard({ ...set0, ...set1 })).toEqual([true, true])
})

test('an object with no row in the table is still shown, under its wire name', () => {
  const described = describeValues({ temperature: 21, 'something new': 7 })
  expect(described).toEqual([
    { key: 'temperature', label: 'current', text: '21.0°' },
    { key: 'something new', label: 'something new', text: '7' },
  ])
})
