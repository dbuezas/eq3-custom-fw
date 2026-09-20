/**
 * The capability gate — the one place the app decides what a thermostat can do.
 *
 * WHAT IS WORTH TESTING is the pair of mistakes that would each be invisible on the bench unit,
 * which runs our firmware on both chips: treating an UNREAD version as stock (which would grey out
 * a modded thermostat's whole app the moment a read was slow), and letting one chip's version
 * answer for the other's features.
 */
import { expect, test } from 'bun:test'

import { gate, pairing, type Caps } from './caps'

const MOD_CHIP = { product: 1, major: 5, minor: 0 }
const STOCK_CHIP = { product: 1, major: 4, minor: 6 }

const caps = (p: Partial<Caps> = {}): Caps => ({
  connected: true,
  fw: 200,
  chip: MOD_CHIP,
  advName: { name: 'Study', max: 15, error: null },
  access: {
    present: false,
    advertEncrypted: false,
    storeRead: true,
    broadcastOn: true,
    pinGateOn: false,
    mac: '00:1a:22:aa:bb:cc',
  },
  settings: {} as Caps['settings'],
  ...p,
})

test('nothing is usable while disconnected, and the reason says so', () => {
  const c = caps({ connected: false })
  for (const need of ['link', 'modThermostat', 'modRadio'] as const) {
    expect(gate(need, c).ok).toBe(false)
    expect(gate(need, c).reason).toContain('connect')
  }
})

test('a stock thermostat still works — the stock commands are not gated', () => {
  expect(gate('link', caps({ fw: 148, chip: STOCK_CHIP })).ok).toBe(true)
})

test('each chip gates its own features and not the other’s', () => {
  const stockThermostatModRadio = caps({ fw: 148, chip: MOD_CHIP })
  expect(gate('modThermostat', stockThermostatModRadio).ok).toBe(false)
  expect(gate('modRadio', stockThermostatModRadio).ok).toBe(true)

  const modThermostatStockRadio = caps({ fw: 200, chip: STOCK_CHIP })
  expect(gate('modThermostat', modThermostatStockRadio).ok).toBe(true)
  expect(gate('modRadio', modThermostatStockRadio).ok).toBe(false)
})

test('UNKNOWN IS NOT STOCK — an unread version reads as waiting, not as absent', () => {
  const unknown = caps({ fw: null, chip: null })
  expect(gate('modThermostat', unknown).ok).toBe(false)
  expect(gate('modThermostat', unknown).reason).toContain('still asking')
  expect(gate('modRadio', unknown).reason).toContain('still asking')
  // And it must NOT tell somebody to install firmware they may already have.
  expect(gate('modThermostat', unknown).reason).not.toContain('install')
})

test('a stock device is told what to do about it, not merely refused', () => {
  expect(gate('modThermostat', caps({ fw: 148 })).reason).toContain('install')
  expect(gate('modRadio', caps({ chip: STOCK_CHIP })).reason).toContain('install')
})

test('a radio newer than ours still counts as ours', () => {
  expect(gate('modRadio', caps({ chip: { product: 1, major: 6, minor: 2 } })).ok).toBe(true)
})

/* ---- the pairing, which decides whether ONE version can stand for the device ------------------- */

test('a device wholly on one firmware or the other is a MATCHED pair', () => {
  expect(pairing(200, MOD_CHIP)).toBe('matched')
  expect(pairing(148, STOCK_CHIP)).toBe('matched')
  // An older stock release is still stock on both, which is all this question asks.
  expect(pairing(120, { product: 1, major: 3, minor: 2 })).toBe('matched')
})

test('HALF INSTALLED IS MIXED, which is the state both numbers exist for', () => {
  expect(pairing(200, STOCK_CHIP)).toBe('mixed') // thermostat done, radio still to go
  expect(pairing(148, MOD_CHIP)).toBe('mixed') // the revert, half way
})

test('A VERSION NOT YET READ IS ITS OWN ANSWER, never quietly one of the others', () => {
  // This is the case the report was really about: with one unread, the bar drew the other alone and
  // it read as the device's version. Unknown must not collapse into matched.
  expect(pairing(null, MOD_CHIP)).toBe('unknown')
  expect(pairing(200, null)).toBe('unknown')
  expect(pairing(null, null)).toBe('unknown')
})
