/**
 * The registry's codec and store, tested off a browser.
 *
 * WHAT IS WORTH TESTING HERE is exactly what a person would only notice after losing something: an
 * export that cannot be restored, an import that silently drops a key, or a reconnect handle that
 * travels between origins and produces rows that look connectable and are not.
 *
 * Run with `bun test src/state` — `bun run test` does both this and the decoder's own harness.
 */
import { expect, test } from 'bun:test'

import { getDefaultStore } from 'jotai'

import { EMPTY, merge, normMac, parse, registry, registryAtom, toExport } from './registry'

/**
 * The registry is ONE atom now, so a test empties it rather than constructing a store of its own.
 * Bun has no `localStorage`, so the atom's backing falls back to memory here — which is what lets
 * these run off a browser at all, and why emptying the atom is enough to isolate them.
 */
const fresh = () => {
  getDefaultStore().set(registryAtom, EMPTY)
  return registry
}

const KEY = '000102030405060708090a0b0c0d0e0f'

test('a stock thermostat, which can only say its serial, still gets a row', () => {
  // The defect this pair exists to stop: the MAC comes from OUR radio's command, so keying on it
  // meant a stock device joined no list -- and since the installer lives behind a row, the app
  // could only upgrade a thermostat that had already been upgraded.
  const r = fresh()
  const row = r.upsert({ serial: 'OEQ0000001', name: 'Study' })
  expect(row.id).toBe('OEQ0000001')
  expect(row.mac).toBeUndefined()
  expect(r.get('OEQ0000001')?.name).toBe('Study')
})

test('upgrading that thermostat keeps its row and its key, and takes the new name', () => {
  // It now reports a MAC as well. Matching on the MAC alone would find nothing and file a SECOND
  // row -- the empty one, under a name nobody chose.
  const r = fresh()
  r.upsert({ serial: 'OEQ0000001', name: 'Study', key: KEY })
  const after = r.upsert({ serial: 'OEQ0000001', mac: '00:1a:22:aa:bb:cc', name: 'CC-RT-BLE' })

  expect(r.list()).toHaveLength(1)
  expect(after.id).toBe('OEQ0000001') // the id never moves, which is what keeps the address valid
  expect(after.mac).toBe('00:1a:22:aa:bb:cc') // ...and the new identifier is stored beside it
  expect(after.key).toBe(KEY)
  // THE NAME FOLLOWS THE DEVICE. It is a cache of what the thermostat advertises, not an alias this
  // browser owns, so a fresh reading REPLACES it -- that is what lets a rename made from another
  // phone, or from this app's Install tab, reach the saved list at all.
  expect(after.name).toBe('CC-RT-BLE')
})

test('a patch changes what it names and nothing else', () => {
  // THIS IS THE BUG THAT SHOWED AN OLD NAME AFTER A RENAME. A caller holding a row and spreading it
  // to change one field republishes every other field from whatever it captured, so a key written
  // from a form opened before a rename put the old name back. Only an identifier is required now,
  // so the narrow call is the natural one to write.
  const r = fresh()
  r.upsert({ serial: 'OEQ0000001', name: 'eQ3-Study', key: KEY })
  const after = r.upsert({ id: 'OEQ0000001', channel: 'plain' })
  expect(after.name).toBe('eQ3-Study')
  expect(after.key).toBe(KEY)
  expect(after.channel).toBe('plain')
})

test('a row keeps the name it had when a caller has none to offer', () => {
  // The browser does not always name a handle it hands back, and a row that went blank would look
  // like one that had failed to load. Falling back is not the same as the stored name winning: an
  // EMPTY name is the caller saying it has nothing, which is the only case the stored one survives.
  const r = fresh()
  r.upsert({ serial: 'OEQ0000001', name: 'eQ3-Study' })
  expect(r.upsert({ serial: 'OEQ0000001', mac: '00:1a:22:aa:bb:cc', name: '' }).name).toBe('eQ3-Study')
})

test('a row that predates the serial keeps its MAC as its id', () => {
  // Files written before `id` existed carry a MAC and nothing else. A row keyed by MAC is still a
  // perfectly good row, so it keeps that key rather than being re-filed under a serial later.
  const r = parse(JSON.stringify({ version: 1, devices: [{ mac: '00:1A:22:AA:BB:CC', name: 'Bedroom' }], presets: [] }))
  expect(r.devices[0]!.id).toBe('00:1a:22:aa:bb:cc')

  const store = fresh()
  getDefaultStore().set(registryAtom, r)
  const after = store.upsert({ mac: '00:1a:22:aa:bb:cc', serial: 'OEQ0000001', name: 'Bedroom' })
  expect(store.list()).toHaveLength(1)
  expect(after.id).toBe('00:1a:22:aa:bb:cc')
  expect(after.serial).toBe('OEQ0000001')
})

test('a MAC is stored in one spelling however it is written', () => {
  expect(normMac('00:1A:22:AA:BB:CC')).toBe('00:1a:22:aa:bb:cc')
  expect(normMac('001a22aabbcc')).toBe('00:1a:22:aa:bb:cc')
  expect(normMac(' 00-1a-22-aa-bb-cc ')).toBe('00:1a:22:aa:bb:cc')
})

test('a corrupt store reads as empty rather than throwing', () => {
  expect(parse(null).devices).toEqual([])
  expect(parse('not json').devices).toEqual([])
  expect(parse('{"version":1}').devices).toEqual([])
  expect(parse('{"version":1,"devices":[{"name":"no mac"}]}').devices).toEqual([])
})

test('the export carries the key and the PIN, and drops the reconnect handle', () => {
  const r = fresh()
  r.upsert({ mac: '00:1a:22:aa:bb:cc', name: 'Bedroom', key: KEY, pin: '123456', deviceId: 'abc' })
  const file = JSON.parse(r.exportJson()) as { devices: Record<string, unknown>[] }
  expect(file.devices[0]!.key).toBe(KEY)
  expect(file.devices[0]!.pin).toBe('123456')
  expect(file.devices[0]).not.toHaveProperty('deviceId')
})

test('an export re-imported into a fresh registry restores the names and the keys', () => {
  const a = fresh()
  a.upsert({ mac: '00:1a:22:aa:bb:cc', name: 'Bedroom', key: KEY })
  a.upsert({ mac: '00:1a:22:dd:ee:ff', name: 'Study' })
  a.upsert({ mac: '00:1a:22:01:02:03', name: 'Hall', pin: '424242' })
  const file = a.exportJson()

  const b = fresh() // the same registry, emptied — a new phone, or a reinstalled browser
  expect(b.importJson(file)).toBe(3)
  expect(b.get('00:1A:22:AA:BB:CC')?.name).toBe('Bedroom')
  expect(b.get('00:1a:22:aa:bb:cc')?.key).toBe(KEY)
  expect(b.get('00:1a:22:01:02:03')?.pin).toBe('424242')
})

test('an import keeps THIS origin’s reconnect handle, which the file cannot carry', () => {
  const local = fresh()
  local.upsert({ mac: '00:1a:22:aa:bb:cc', name: 'old name', deviceId: 'granted-here' })

  const file = toExport({
    version: 1,
    devices: [{ id: '00:1a:22:aa:bb:cc', mac: '00:1a:22:aa:bb:cc', name: 'new name', key: KEY }],
    presets: [],
  })
  local.importJson(file)

  const row = local.get('00:1a:22:aa:bb:cc')!
  expect(row.name).toBe('new name') // a restore wins over what was here
  expect(row.key).toBe(KEY)
  expect(row.deviceId).toBe('granted-here') // ...except for the handle, which is not in the file
})

test('an empty or unreadable file is refused with something a person can read', () => {
  expect(() => merge({ version: 1, devices: [], presets: [] },'{"version":1,"devices":[]}')).toThrow(
    'no thermostats in that file',
  )
  expect(() => merge({ version: 1, devices: [], presets: [] },'garbage')).toThrow()
})

test('upsert merges rather than replacing, so learning one field keeps the others', () => {
  const r = fresh()
  r.upsert({ mac: '00:1a:22:aa:bb:cc', name: 'Bedroom', key: KEY })
  r.upsert({ mac: '00:1a:22:aa:bb:cc', name: 'Bedroom', deviceId: 'handle' })
  expect(r.get('00:1a:22:aa:bb:cc')?.key).toBe(KEY)
  expect(r.byDeviceId('handle')?.name).toBe('Bedroom')
  expect(r.list()).toHaveLength(1)
})

test('what the store holds reads back as the same rows — a reload keeps the keys', () => {
  const r = fresh()
  r.upsert({ mac: '00:1a:22:aa:bb:cc', name: 'Bedroom', key: KEY })
  // What persistence actually is here: the value is serialised and `parse` reads it again.
  expect(parse(JSON.stringify(r.all())).devices[0]?.key).toBe(KEY)
})

test('forget removes exactly one row', () => {
  const r = fresh()
  r.upsert({ mac: '00:1a:22:aa:bb:cc', name: 'A' })
  r.upsert({ mac: '00:1a:22:dd:ee:ff', name: 'B' })
  r.forget('00:1A:22:AA:BB:CC')
  expect(r.list().map((d) => d.name)).toEqual(['B'])
})
