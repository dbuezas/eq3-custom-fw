/**
 * What the browser's device chooser is actually asked for.
 *
 * **THIS IS THE ONE CALL IN THE APP WHOSE MISTAKES ARE INVISIBLE.** A wrong filter does not throw:
 * the chooser simply comes up empty, which reads exactly like a thermostat that is out of range or
 * switched off — and the same is true of a missing `optionalServices` entry, which makes a whole
 * service unreachable later with no error worth the name. So the options are asserted here rather
 * than trusted.
 *
 * **THERE IS ONE CASE, NOT TWO.** A renamed thermostat is aired under the `eQ3-` prefix the RADIO
 * adds rather than the text somebody typed, so the ordinary filter reaches it and the app has no
 * unfiltered route to maintain.
 */
import { expect, test } from 'bun:test'

import { ADV_NAME_DEFAULT, ADV_NAME_PREFIX, ADV_NAME_STOCK } from './advname'
import { connect } from './link'
import { BTHOME_SVC, OTA_SVC, SVC } from './protocol'

/**
 * What we are actually asserting about. `RequestDeviceOptions` is a UNION of the filtered and the
 * accept-all shapes, so neither member's fields can be read off it without narrowing — and
 * `acceptAllDevices` is named here so the test can assert it is ABSENT.
 */
type Asked = {
  filters?: unknown[]
  acceptAllDevices?: boolean
  optionalServices?: unknown[]
}

/** Record what `requestDevice` was handed, then fail the way a cancelled chooser does. */
async function optionsOf(): Promise<Asked> {
  let got: RequestDeviceOptions | undefined
  Object.defineProperty(globalThis.navigator, 'bluetooth', {
    configurable: true,
    value: {
      requestDevice: (o: RequestDeviceOptions) => {
        got = o
        // The message matters: the app tells a cancelled chooser from a real failure by it.
        return Promise.reject(new Error('User cancelled the requestDevice() chooser.'))
      },
      getDevices: () => Promise.resolve([]),
    },
  })
  await connect().catch(() => {})
  if (!got) throw new Error('requestDevice was never called')
  return got as Asked
}

test('the ordinary chooser is narrowed to thermostats, by NAME and never by service', () => {
  // The advert deliberately drops the 128-bit service UUID to make room for the BThome objects, so
  // `filters: [{ services: [SVC] }]` would match nothing at all and the list would come up empty.
  return optionsOf().then((o) => {
    expect(o.filters).toEqual([
      { name: 'CC-RT-BLE' },
      { name: 'CC-RT-M-BLE' },
      { namePrefix: ADV_NAME_PREFIX },
    ])
    expect('acceptAllDevices' in o).toBe(false)
  })
})

test('every way a thermostat can be named has an entry, and none covers another', () => {
  // Three states: the two names eQ-3 ships, and a renamed unit aired as `eQ3-<name>`. Dropping any
  // entry hides part of the estate SILENTLY, since a filter that matches nothing looks exactly like
  // a device out of range.
  return optionsOf().then((o) => {
    const f = o.filters as ({ name?: string } & { namePrefix?: string })[]
    for (const n of ADV_NAME_STOCK) expect(f.some((x) => x.name === n)).toBe(true)
    expect(f.some((x) => x.namePrefix === ADV_NAME_PREFIX)).toBe(true)
    // The stock names are matched EXACTLY, so neither may begin with our prefix — otherwise the
    // entries would overlap and one of them would be doing nothing.
    for (const n of ADV_NAME_STOCK) expect(n.startsWith(ADV_NAME_PREFIX)).toBe(false)
    expect(ADV_NAME_STOCK).toContain(ADV_NAME_DEFAULT)
  })
})

test('it asks for every service the app will need later', async () => {
  // A service not granted HERE cannot be reached at all afterwards: the command service, the
  // BThome service data the front-door watcher reads, and the radio chip's own version record.
  const o = await optionsOf()
  expect(o.optionalServices).toEqual([SVC, BTHOME_SVC, OTA_SVC])
})
