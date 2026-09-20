/**
 * TWO THERMOSTATS AT ONCE — that each one's facts stay its own, and that "the" device means the
 * one the address bar is on.
 *
 * **THIS IS THE RISK `W30` NAMES, and it is the only one worth a test here**: a half-plural device
 * layer is worse than the singleton, because the failure is one device's answer written into
 * another's screen. It is also invisible — the wrong setpoint is a plausible setpoint — so it
 * cannot be found by looking, on a bench that has one thermostat.
 *
 * What it does NOT assert is that two GATT links can really be held open, which no test can say:
 * that is the browser's and the platform's answer and it is taken on the device.
 *
 * **IT NEEDS THE REAL `device/link.ts`**, and three files under `src/components/` replace that
 * module with a stand-in. A `mock.module` in bun is global to the whole run and is NOT undone by
 * `mock.restore()`; what does undo it is re-registering the module, which each of those three now
 * does in an `afterAll`. So the real module is the real module everywhere, and
 * `src/device/mock-isolation.test.ts` is the probe that says so.
 *
 * Sitting at the top of `src/` also puts this file before them either way, which is belt and
 * braces rather than the reason it works. Before the restores existed, a file under `src/device/`
 * failed with "Export named … not found" naming an export sitting right there in the source, and
 * passed when run on its own — the worst pair to meet.
 */
const { beforeEach, expect, test } = await import('bun:test')
const { Provider, createStore } = await import('jotai')
const { renderToString } = await import('react-dom/server')

const { activeIdAtom, deviceNameFor, fwVersionFor, linkStateFor, statusFor } = await import(
  '@/device/link'
)
const { deviceNameAtom, fwVersionAtom, linkFor, linkStateAtom, statusAtom } = await import(
  '@/state/atoms'
)
const { openIdAtom } = await import('@/state/route')
const { registryAtom: storedRegistryAtom } = await import('@/state/registry')
const { DeviceList } = await import('@/components/DeviceList')

/** Two saved thermostats, each with the browser handle its link is keyed on. */
const TWO = {
  version: 1 as const,
  devices: [
    { id: 'OEQ0000001', serial: 'OEQ0000001', name: 'Bedroom', deviceId: 'handle-bedroom' },
    { id: 'OEQ0000002', serial: 'OEQ0000002', name: 'Study', deviceId: 'handle-study' },
  ],
  presets: [],
}

const aStatus = (setpoint: number) => ({
  at: Date.now(),
  setpoint,
  mode: 'auto' as const,
  boost: false,
  dst: false,
  lock: false,
  window: false,
  batteryLow: false,
  valve: 0,
  uiState: 4,
})

let store: ReturnType<typeof createStore>

beforeEach(() => {
  store = createStore()
  store.set(storedRegistryAtom, TWO)
})

test('each thermostat has its own link state, and a row reads the one that is its own', () => {
  store.set(linkStateFor('handle-bedroom'), 'connected')
  store.set(linkStateFor('handle-study'), 'waiting')

  expect(store.get(linkFor('OEQ0000001'))).toBe('connected')
  expect(store.get(linkFor('OEQ0000002'))).toBe('waiting')
  // A row this browser has never been granted has no handle and therefore no link. That is
  // `disconnected` rather than an error — it is what the row's Connect button acts on.
  expect(store.get(linkFor('never-granted'))).toBe('disconnected')
})

test('THE SINGULAR ATOMS DESCRIBE THE THERMOSTAT THE ADDRESS BAR IS ON, not another live one', () => {
  // Both connected, and they disagree about everything a screen shows. This is the state the whole
  // item exists for: with one set of atoms it cannot be reached, and with a family keyed on
  // anything but the open device it is reached silently and looks right.
  store.set(linkStateFor('handle-bedroom'), 'connected')
  store.set(linkStateFor('handle-study'), 'connected')
  store.set(statusFor('handle-bedroom'), aStatus(21))
  store.set(statusFor('handle-study'), aStatus(17))
  store.set(fwVersionFor('handle-bedroom'), 200)
  store.set(fwVersionFor('handle-study'), 148)
  store.set(deviceNameFor('handle-bedroom'), 'Bedroom')
  store.set(deviceNameFor('handle-study'), 'Study')

  store.set(openIdAtom, 'OEQ0000002')
  expect(store.get(activeIdAtom)).toBe('handle-study')
  expect(store.get(statusAtom)?.setpoint).toBe(17)
  expect(store.get(fwVersionAtom)).toBe(148)
  expect(store.get(deviceNameAtom)).toBe('Study')

  store.set(openIdAtom, 'OEQ0000001')
  expect(store.get(activeIdAtom)).toBe('handle-bedroom')
  expect(store.get(statusAtom)?.setpoint).toBe(21)
  expect(store.get(fwVersionAtom)).toBe(200)
  expect(store.get(deviceNameAtom)).toBe('Bedroom')

  // On the LIST there is no open thermostat, so there is no "the" device — and a singular atom must
  // say it does not know rather than picking whichever link happens to be up.
  store.set(openIdAtom, null)
  expect(store.get(activeIdAtom)).toBeNull()
  expect(store.get(statusAtom)).toBeNull()
  expect(store.get(linkStateAtom)).toBe('disconnected')
})

/**
 * The button on every row, which is what `W30` is FOR: connecting no longer means opening a
 * thermostat, and it no longer ends when you walk back to the list.
 *
 * All four words are asserted because three of them are the fix: "Connect" during an attempt is the
 * misleading press `W29` removes, and a row that cannot say it is connected is a row somebody
 * disconnects by pressing Connect on the next one.
 */
test('a row says what its own link is doing, one word per state', () => {
  store.set(linkStateFor('handle-bedroom'), 'connected')
  store.set(linkStateFor('handle-study'), 'waiting')
  store.set(openIdAtom, null)

  const html = renderToString(
    <Provider store={store}>
      <DeviceList />
    </Provider>,
  )
  expect(html).toContain('Disconnect')
  expect(html).toContain('Searching…')
  expect(html).not.toContain('Connecting…')

  store.set(linkStateFor('handle-study'), 'connecting')
  store.set(linkStateFor('handle-bedroom'), 'disconnected')
  const second = renderToString(
    <Provider store={store}>
      <DeviceList />
    </Provider>,
  )
  expect(second).toContain('Connecting…')
  expect(second).toContain('Connect')
  expect(second).not.toContain('Searching…')
  expect(second).not.toContain('Disconnect')
})
