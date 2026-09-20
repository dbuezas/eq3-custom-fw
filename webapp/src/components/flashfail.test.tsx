/**
 * `W14` — WHAT HAPPENS WHEN THE THERMOSTAT HALF FAILS, which is the half of the install flow a
 * device cannot easily be made to show.
 *
 * **THE ONE PROPERTY: the radio is NOT written unless the thermostat step finished AND verified.**
 * The two chips have to move together — a thermostat on 2.00 with a 1.48 radio NAKs every mod
 * command — and stopping BETWEEN them is the one safe place to stop, because a half-updated device
 * is still flashable in both directions. So every way the first half can fail has to end the run
 * before the second is touched, and say so.
 *
 * **IT IS A TEST RATHER THAN A DEVICE RUN because a device can only show one of these paths, and
 * awkwardly.** Provoking a refused chunk means interrupting a real transfer; provoking a wrong
 * version back means a thermostat that reboots into something unexpected, which is not a state you
 * can ask for. Here every one of them is an ordinary input, and the assertion is the same in each:
 * `flashRadio` was never called. That a thermostat stopped between the two steps is still flashable
 * is a DEVICE fact, measured separately, and is not this.
 *
 * The stubs answer at the MODEL level, like the rest of this app's tests: `flashThermostat` either
 * resolves or throws, and `request` answers the version read. Forging OTA frames here would be a
 * second copy of a protocol nothing on a radio ever checks.
 */
const { afterAll, afterEach, beforeEach, expect, mock, test } = await import('bun:test')
const { atom } = await import('jotai')

/**
 * THE REAL MODULE, CAPTURED BEFORE IT IS REPLACED, so it can be put back when this file is done.
 *
 * A bun module mock is PROCESS-WIDE: it replaces the exports its factory names and passes the rest
 * through, for every file discovered after this one. Without the restore below, they all get this
 * file's `request`, `flashThermostat`, `flashRadio` and `prepareForFlash` — silently, and only when
 * the whole suite runs, since each of them passes alone. `src/device/mock-isolation.test.ts` is the
 * probe that holds this honest; it fails without the `afterAll`.
 *
 * **SPREAD, NOT THE NAMESPACE ITSELF, and that is the whole trick** `[manually verified]`. A module
 * namespace object has LIVE bindings, so holding one does not snapshot anything: after the mock is
 * registered, `(await import(…)).request` IS the stand-in, and restoring from it restores the mock
 * over itself. Copying the exports into a plain object at this line is what captures them. The probe
 * caught exactly that mistake — it still failed with the naive version.
 */
const realLink = { ...(await import('@/device/link')) }

/**
 * THE LONG WAITS ARE COLLAPSED, and without this none of these tests can run at all.
 *
 * After the thermostat's transfer the run polls its version every two seconds for up to a minute
 * and a half, because a real thermostat reboots into its bootloader and out again and answers
 * nothing until it has. In real time that is ninety seconds for each of the failure cases — the ones
 * where the version never becomes what was asked for — which is a test suite nobody will run.
 *
 * Only the waits are shortened; every await, every ordering and every branch is the real one. A
 * clamp rather than a stub, so a timer this app uses for something else still fires in order.
 */
const realTimeout = globalThis.setTimeout
const collapseWaits = () => {
  globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) =>
    realTimeout(fn, ms && ms > 20 ? 0 : ms, ...rest)) as unknown as typeof setTimeout
}

/** Every call the run made, in order — the assertion target for every test here. */
let called: string[] = []
/** What `flashThermostat` does. Resolving is a transfer that delivered every chunk. */
let thermostat: () => Promise<void> = async () => {}
/** What the thermostat reports when its version is read back after the restart. */
let reportsVersion: number | null = 200
/** What `prepareForFlash` answers — the two checks that run before a byte is written. */
let ready = { paired: true, radioReady: true }

await mock.module('@/device/link', () => ({
  fwVersionAtom: atom<number | null>(148),
  chipVersionAtom: atom({ product: 0x1000, major: 4, minor: 6 }),
  connectedAtom: atom(true),
  linkStateAtom: atom('connected'),
  // `state/atoms.ts` joins a ROW to its link through this, so the stand-in has to have it even
  // though nothing here renders a row — a module mock replaces the whole module, not the parts a
  // test happens to use.
  linkStateFor: () => atom('connected'),
  deviceNameAtom: atom<string | null>(null),
  grantedAtom: atom<number | null>(1),
  grantedSettledAtom: atom(true),
  repliesAtom: atom(true),
  statusAtom: atom(null),
  advNameAtom: atom(undefined),
  keyStatusAtom: atom(null),
  settingsAtom: atom(null),
  radioFlashableAtom: atom(true),
  prepareForFlash: async () => {
    called.push('prepare')
    return ready
  },
  flashThermostat: async (_p: Uint8Array, onProgress: (d: number, t: number) => void) => {
    called.push('stm8')
    onProgress(0, 1)
    return thermostat()
  },
  flashRadio: async () => {
    called.push('radio')
  },
  // The version read that decides whether the second half runs at all. `01 <ver> …` is the info
  // reply's shape, and `protocol.ts`'s real matcher is what judges it — so a frame the app would
  // reject is rejected here too, rather than only in front of a radio.
  request: async () =>
    reportsVersion === null
      ? null
      : new Uint8Array([0x01, reportsVersion, 0, 0, ...Array.from({ length: 11 }, () => 0x41)]),
}))

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { FirmwareInstall } = await import('./FirmwareInstall')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** A payload the chunk parser accepts: the thermostat's images ship as hex TEXT. */
const HEX_PAYLOAD = '00'.repeat(1024)
/** What the radio half of the fake server answers with. */
const RADIO_BYTES = new Uint8Array(8)

/**
 * The checksums are COMPUTED from the bytes the fake server below returns, never pasted.
 *
 * A fixture carrying a hand-written hash is a fixture that can only be kept right by hand, and an
 * entry with NO hash is refused outright now — `checkImage` treats a catalogue it cannot check
 * against as a failure rather than a pass, which is what made this file fail when that landed.
 */
const { sha256Hex } = await import('@/device/flash')
const STM8_SHA = await sha256Hex(new TextEncoder().encode(HEX_PAYLOAD))
const RADIO_SHA = await sha256Hex(RADIO_BYTES)

/** One release carrying both chips, which is the only shape the app offers — half a release is not listed. */
const CATALOGUE = {
  releases: [
    {
      version: '2.00',
      mod: true,
      note: '',
      stm8: { file: 'stm8-2.00.enc', bytes: 4, sha256: STM8_SHA, expect: 200 },
      radio: { file: 'radio-2.00.bin', bytes: 8, sha256: RADIO_SHA, expect: '5.0' },
    },
  ],
}

let host: HTMLElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  called = []
  thermostat = async () => {}
  reportsVersion = 200
  ready = { paired: true, radioReady: true }
  collapseWaits()
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    const u = String(url)
    if (u.includes('catalogue')) return new Response(JSON.stringify(CATALOGUE), { status: 200 })
    if (u.includes('stm8')) return new Response(HEX_PAYLOAD, { status: 200 })
    return new Response(RADIO_BYTES, { status: 200 })
  }) as typeof fetch
})

/** Queried off `document.body`: `Sheet` is a Radix PORTAL — `advname.test.tsx` says why. */
const screen = () => document.body

const click = async (label: RegExp) => {
  const el = [...screen().querySelectorAll('button')].find((b) => label.test(b.textContent ?? ''))
  if (!el) {
    throw new Error(
      `no button matching ${label}; had: ` +
        [...screen().querySelectorAll('button')].map((b) => b.textContent).join(' | '),
    )
  }
  await act(async () => el.click())
}

/** Mount, open the confirm sheet for 2.00, press the go button, and let the run settle. */
const start = async () => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(<FirmwareInstall />))
  await act(async () => {}) // the catalogue arrives from an effect
  await click(/Upgrade to/)
  await click(/^Install /)
  // The version poll is up to 45 rounds, each of them a timer AND a request; with the waits
  // collapsed they still have to be let through a macrotask at a time. Waiting for the RUNNING
  // phase to end rather than for a fixed count, so a change to the poll cannot quietly turn these
  // assertions into "the dialog had not got there yet".
  for (let i = 0; i < 2000 && /Installing /.test(screen().textContent ?? ''); i++) {
    await act(async () => new Promise((r) => realTimeout(r, 0)))
  }
}

/** UNCONDITIONAL, so a failing assertion cannot leave its dialog in the body for the next test. */
afterEach(async () => {
  globalThis.setTimeout = realTimeout
  if (root) await act(async () => root.unmount())
  host?.remove()
})

/** PUT `@/device/link` BACK, so the stand-in above stops at this file. See `realLink`. */
afterAll(async () => {
  await mock.module('@/device/link', () => realLink)
})

test('the happy path writes the thermostat first and the radio second', async () => {
  await start()
  expect(called).toEqual(['prepare', 'stm8', 'radio'])
})

test('A MISSING IMAGE COMES BACK AS THE APP ITSELF, AT STATUS 200 — and is not written to a chip', async () => {
  // The exact shape `flash.ts` records for the catalogue and nothing guarded on the images: a dev
  // server answers an absent path with index.html and `response.ok` is TRUE. Before the checksum
  // was compared, these bytes reached `flashRadio`, which checks no length and no hash — and the
  // CRC it sends is computed over whatever it was handed, so it always agrees with itself.
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    if (String(url).includes('radio')) {
      return new Response('<!doctype html><title>eQ-3</title>', { status: 200 })
    }
    return realFetch(url)
  }) as typeof fetch
  await start()
  // The thermostat half ran and verified; the radio half refused its image before writing a byte.
  expect(called).toEqual(['prepare', 'stm8'])
  expect(called).not.toContain('radio')
  expect(screen().textContent).toMatch(/did not arrive intact/)
})

test('a thermostat image that does not match the list stops the run before ANY chip is written', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    if (String(url).includes('stm8')) return new Response('11'.repeat(1024), { status: 200 })
    return realFetch(url)
  }) as typeof fetch
  await start()
  // Not even `stm8`: the check happens on the bytes, before the transfer starts.
  expect(called).toEqual(['prepare'])
  expect(screen().textContent).toMatch(/did not arrive intact/)
})

test('A REFUSED TRANSFER LEAVES THE RADIO UNTOUCHED, and the page says what went wrong', async () => {
  thermostat = async () => {
    throw new Error('the thermostat refused chunk 12 of 236')
  }
  await start()
  expect(called).toEqual(['prepare', 'stm8'])
  expect(called).not.toContain('radio')
  // THE DEVICE'S OWN WORDS, not a rewritten summary: which chunk it stopped on is what separates a
  // bad image from a link that went away, and whoever reads it is standing at the radiator.
  expect(screen().textContent).toContain('refused chunk 12')
})

test('A THERMOSTAT THAT COMES BACK AS THE WRONG VERSION STOPS THE RUN, and says the radio is untouched', async () => {
  // Every chunk went and the device rebooted — into something that is not what was installed. This
  // is the case a device cannot be asked to produce, and the one where pressing on would leave the
  // two chips on firmware that does not match.
  reportsVersion = 148
  await start()
  expect(called).toEqual(['prepare', 'stm8'])
  expect(screen().textContent).toMatch(/came back as 148 rather than 200/)
  expect(screen().textContent).toMatch(/radio has NOT been touched/)
})

test('A THERMOSTAT THAT NEVER ANSWERS AGAIN STOPS THE RUN TOO', async () => {
  reportsVersion = null
  await start()
  expect(called).toEqual(['prepare', 'stm8'])
  expect(screen().textContent).toMatch(/came back as nothing/)
})

test('AND A RADIO THAT CANNOT BE REACHED STOPS BEFORE A BYTE IS WRITTEN', async () => {
  // Checked first on purpose: a run that could not finish the radio's half would leave the chips out
  // of step, and stopping here has cost nothing at all.
  ready = { paired: true, radioReady: false }
  await start()
  expect(called).toEqual(['prepare'])
  expect(screen().textContent).toContain('Nothing has been written')
})

test('an unpaired thermostat is told to pair rather than being flashed', async () => {
  ready = { paired: false, radioReady: false }
  await start()
  expect(called).toEqual(['prepare'])
  expect(screen().textContent).toMatch(/wants to be paired with/)
})
