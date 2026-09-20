/**
 * What the app believes when a broadcast arrives WITHOUT readings in it.
 *
 * The thermostat's BThome switch does not stop it advertising — it keeps a plain connectable advert
 * up with no `0xFCD2` service data in it at all (`ble_chip/mod/bthome.S`, `.Le_quiet`). Those adverts
 * used to be dropped here without a word, so the last readings stayed on screen as current for as
 * long as the switch was off. That is the one failure this file exists to catch: a stale temperature
 * and a live one look identical.
 *
 * It drives the real `watch()` with a fake `BluetoothDevice` rather than calling the handler
 * directly, because the handler is not exported and the wiring — one listener, per-device state — is
 * part of what is being asserted.
 */
import { beforeEach, expect, test } from 'bun:test'

import { MIN_GAP_MS, QUIET_MS, reportFor, shouldRearm, watch } from './advert'

// The two globals the module reaches for at runtime. `getService` is identity here: the module only
// uses it to key the service-data map, and the test supplies both sides of that key.
;(globalThis as Record<string, unknown>).BluetoothUUID = { getService: (u: unknown) => u }

type Handler = (e: unknown) => void

function fakeDevice(id: string) {
  let handler: Handler | null = null
  const device = {
    id,
    watchAdvertisements: () => Promise.resolve(),
    addEventListener: (_n: string, h: Handler) => {
      handler = h
    },
    removeEventListener: () => {},
  }
  const send = async (serviceData: Map<unknown, DataView> | undefined) => {
    handler?.({ device: { id }, rssi: -54, serviceData })
    await Promise.resolve() // the handler is async past the decrypt branch
    await Promise.resolve()
  }
  return { device, send }
}

/** A plain (unsealed) BThome set-0 payload: current, target, battery, valve. */
const SET0 = new Uint8Array([
  0x40, 0x02, 0x9a, 0x0b, 0x02, 0x78, 0x05, 0x0c, 0xde, 0x0c, 0x2f, 0x00,
])
const withData = () => new Map([[0xfcd2, new DataView(SET0.buffer)]])

/** The OTHER half: window, lock, boost, battery-low, mode — the flags, whose first value is
 *  `window`, which is how `setCounts` tells the two apart. */
const SET1 = new Uint8Array([
  0x40, 0x2d, 0x01, 0x1f, 0x00, 0x0f, 0x00, 0x15, 0x00, 0x09, 0x01,
])
const withFlags = () => new Map([[0xfcd2, new DataView(SET1.buffer)]])

let rig: ReturnType<typeof fakeDevice>

beforeEach(async () => {
  rig = fakeDevice(`dev-${Math.random()}`)
  await watch(rig.device as unknown as BluetoothDevice)
})

test('a broadcast with readings fills the report', async () => {
  await rig.send(withData())
  const r = reportFor(rig.device.id)
  expect(r.sensorData).toBe(true)
  expect(r.values['temperature']).toBe(29.7)
  expect(r.count).toBe(1)
})

test('a broadcast with NO BThome data clears the readings instead of keeping them', async () => {
  await rig.send(withData())
  expect(reportFor(rig.device.id).values['temperature']).toBe(29.7)

  await rig.send(new Map()) // still advertising, nothing in it — the switch is off
  const r = reportFor(rig.device.id)
  expect(r.sensorData).toBe(false)
  // THE POINT OF THE WHOLE FILE: not a stale 29.7.
  expect(r.values).toEqual({})
  expect(r.valuesAt).toEqual({})
  expect(r.setsSeen).toBe(0)
  // ...and it is still HEARD. A cleared report must not read as a device that went quiet, so the
  // broadcast counts and the age restarts.
  expect(r.count).toBe(2)
  expect(r.lastAt).not.toBeNull()
  expect(r.rssi).toBe(-54)
})

test('readings come back when the broadcast does', async () => {
  await rig.send(withData())
  await rig.send(new Map())
  await rig.send(withData())
  const r = reportFor(rig.device.id)
  expect(r.sensorData).toBe(true)
  expect(r.values['temperature']).toBe(29.7)
  expect(r.count).toBe(3)
})

test('an advert with no serviceData map at all is the same case', async () => {
  // Trap 1 in the module header: a device this origin has no `0xFCD2` permission for delivers an
  // empty map, and some adverts carry no map. Both mean no readings are arriving.
  await rig.send(withData())
  await rig.send(undefined)
  expect(reportFor(rig.device.id).values).toEqual({})
  expect(reportFor(rig.device.id).sensorData).toBe(false)
})

/**
 * THE TWO HALVES ARE COUNTED SEPARATELY, which is what says the traffic is DIVIDED evenly rather
 * than merely present. On a platform that is dropping the scan, a healthy-looking total can be one
 * half arriving and the other never — and then half the readings on screen are as old as the page,
 * while every other indicator says the device is being heard.
 */
test('each object set is tallied under its own first value name', async () => {
  await rig.send(withData())
  await rig.send(withFlags())
  await rig.send(withData())

  const r = reportFor(rig.device.id)
  expect(r.setCounts).toEqual({ temperature: 2, window: 1 })
  // The total still counts every broadcast; the halves are how it splits, not a second total.
  expect(r.count).toBe(3)
  expect(r.setsSeen).toBe(2)
})

test('a broadcast with no readings tallies no half', async () => {
  // The BThome switch is off: the device is heard, so `count` moves, but there is no set to divide.
  await rig.send(new Map())
  const r = reportFor(rig.device.id)
  expect(r.count).toBe(1)
  expect(r.setCounts).toEqual({})
})

/**
 * THE SILENCE WATCHDOG'S DECISION, which nothing else can reach.
 *
 * On macOS the platform keeps ending the scan by itself — verified in Chrome's own
 * `chrome://bluetooth-internals`, where discovery switches off over and over — so the app
 * re-subscribes when a device that WAS being heard goes quiet. There is no event for a dropped
 * scan, so silence is the only evidence, and these are the four cases that decide.
 */
const NOW = 1_000_000

test('a device that has never been heard is left alone', () => {
  // Out of range or switched off. Hammering the platform on its behalf buys nothing and costs
  // power; the first broadcast is what proves there is a stream to lose.
  expect(shouldRearm(null, 0, NOW)).toBe(false)
})

test('an ordinary gap between broadcasts does not trigger it', () => {
  // One a second, and a dropped one is normal. Re-arming on every miss would restart the scan
  // constantly and defeat the thing it is for.
  expect(shouldRearm(NOW - 1000, 0, NOW)).toBe(false)
  expect(shouldRearm(NOW - (QUIET_MS - 1), 0, NOW)).toBe(false)
})

test('silence past the threshold re-arms', () => {
  expect(shouldRearm(NOW - QUIET_MS, 0, NOW)).toBe(true)
  expect(shouldRearm(NOW - 60_000, 0, NOW)).toBe(true)
})

test('a device that cannot be revived is not re-armed in a loop', () => {
  // Still silent, but only just re-armed: the gap is what stops a dead device pinning the radio.
  expect(shouldRearm(NOW - 60_000, NOW - (MIN_GAP_MS - 1), NOW)).toBe(false)
  expect(shouldRearm(NOW - 60_000, NOW - MIN_GAP_MS, NOW)).toBe(true)
})
