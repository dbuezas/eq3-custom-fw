/**
 * The address bar IS the app's state, so this is the contract every screen depends on.
 *
 * A row is keyed by its `id` — its serial when the thermostat reports one, its MAC otherwise
 * (`registry.ts`'s header) — so both shapes have to survive a round trip through a path. They are
 * normalised differently and the serial is the one that used to get mangled, which is why it has
 * tests of its own.
 */
import { expect, test } from 'bun:test'

import { parsePath, pathFor, stripBase, withBase } from './route'

const MAC = '00:1a:22:aa:bb:cc'
const SERIAL = 'OEQ0000001'

/**
 * THE DEPLOYMENT PREFIX, which every test above this line is blind to.
 *
 * The app is served from `dbuezas.github.io/eq3-custom-fw/`, a subdirectory, while every address in
 * `route.ts` is absolute. Under `bun test` Vite's `BASE_URL` is undefined, so the module's own
 * constant is `''` and both halves of the prefixing collapse to no-ops — meaning the deployed
 * behaviour would otherwise ship with no test at all, and it is the one arrangement that cannot be
 * tried on this machine. The helpers take the base as an argument so it can be supplied here.
 */
const BASE = '/eq3-custom-fw'

test('at a root the prefix is not there and nothing is touched', () => {
  expect(stripBase('', `/thermostat/${MAC}/status`)).toBe(`/thermostat/${MAC}/status`)
  expect(withBase('', '/')).toBe('/')
})

test('a project page strips its prefix off an incoming address', () => {
  expect(stripBase(BASE, `${BASE}/thermostat/${MAC}/status`)).toBe(`/thermostat/${MAC}/status`)
  expect(stripBase(BASE, `${BASE}/connected`)).toBe('/connected')
  // The bare base is the front door, and must come back as `/` rather than the empty string --
  // empty matches no route, so the list would be reached by falling through instead of by matching.
  expect(stripBase(BASE, BASE)).toBe('/')
  expect(stripBase(BASE, `${BASE}/`)).toBe('/')
})

test('a path that does not carry the prefix is left alone', () => {
  // Nothing should ever hand one of these in, and mangling it would be worse than passing it
  // through: the routes below simply fail to match and the person lands on the list.
  expect(stripBase(BASE, '/somewhere/else')).toBe('/somewhere/else')
})

test('a project page puts its prefix back on every address it hands the browser', () => {
  expect(withBase(BASE, `/thermostat/${MAC}/status`)).toBe(`${BASE}/thermostat/${MAC}/status`)
  expect(withBase(BASE, '/')).toBe(`${BASE}/`)
})

test('the two are inverses, which is what keeps a deep link working', () => {
  for (const p of [`/thermostat/${MAC}/status`, `/thermostat/${SERIAL}/display`, '/connected', '/'])
    expect(stripBase(BASE, withBase(BASE, p))).toBe(p)
})

test('a thermostat address reads back as its id and its tab', () => {
  expect(parsePath(`/thermostat/${MAC}/status`)).toEqual({ id: MAC, unsaved: false, section:'status' })
  expect(parsePath(`/thermostat/${MAC}/settings`)).toEqual({ id: MAC, unsaved: false, section:'settings' })
  expect(parsePath(`/thermostat/${MAC}/display`)).toEqual({ id: MAC, unsaved: false, section:'display' })
  expect(parsePath(`/thermostat/${MAC}/install`)).toEqual({ id: MAC, unsaved: false, section:'install' })
})

test('a MAC id is normalised, so a hand-typed address still finds its row', () => {
  expect(parsePath('/thermostat/00:1A:22:AA:BB:CC/status').id).toBe(MAC)
  expect(parsePath('/thermostat/001a22aabbcc/status').id).toBe(MAC)
  expect(parsePath(`/thermostat/${encodeURIComponent(MAC)}/status`).id).toBe(MAC)
})

test('a SERIAL id survives the trip unchanged', () => {
  // The failure this guards: MAC normalisation strips every non-hex character and re-inserts
  // colons, so run over a serial it yields a MAC-shaped string that matches no row at all.
  expect(parsePath(`/thermostat/${SERIAL}/status`).id).toBe(SERIAL)
  expect(parsePath(pathFor(SERIAL, 'install'))).toEqual({
    id: SERIAL,
    unsaved: false,
    section: 'install',
  })
})

test('a trailing slash and a missing tab both mean Status', () => {
  expect(parsePath(`/thermostat/${MAC}`)).toEqual({ id: MAC, unsaved: false, section:'status' })
  expect(parsePath(`/thermostat/${MAC}/`)).toEqual({ id: MAC, unsaved: false, section:'status' })
})

test('an address this app does not know is the list, never an error', () => {
  for (const p of ['/', '', '/thermostat', '/thermostat/', '/nope', '/thermostat/x/y/z'])
    expect(parsePath(p).id).toBeNull()
})

test('/connected is a live link with no row, and it opens on Install', () => {
  // The device it is for cannot say which one it is, so it has no id -- and the installer is the
  // only thing it can do, which is why that is where it lands rather than Status.
  expect(parsePath('/connected')).toEqual({ id: null, unsaved: true, section: 'install' })
  expect(parsePath('/connected/')).toEqual({ id: null, unsaved: true, section: 'install' })
})

test('every other address is NOT the unsaved one', () => {
  // `unsaved` gates a whole screen, so a false positive would hide the list behind an installer.
  for (const p of ['/', '/connecte', '/connectedx', '/connected/status', `/thermostat/${MAC}`])
    expect(parsePath(p).unsaved).toBe(false)
})

test('a tab that no longer exists falls back to Status rather than showing nothing', () => {
  // The case a bookmark from an older build lands in.
  expect(parsePath(`/thermostat/${MAC}/programme`)).toEqual({ id: MAC, unsaved: false, section:'status' })
})

test('what is written is what is read', () => {
  expect(pathFor(null, 'status')).toBe('/')
  expect(pathFor(MAC, 'install')).toBe(`/thermostat/${MAC}/install`)
  for (const id of [MAC, SERIAL])
    for (const s of ['status', 'settings', 'display', 'install'] as const)
      expect(parsePath(pathFor(id, s))).toEqual({ id, unsaved: false, section: s })
})
