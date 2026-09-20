/**
 * The Bluetooth-name row, as a person meets it — the wiring the encoder's own tests cannot see.
 *
 * Three things are worth asserting here and nowhere else. **The row has three states and two of
 * them look the same from the data**: a device that has not answered yet and one that cannot answer
 * at all both leave the app with no name, and only the second may say "update the firmware" — the
 * same trap as `storeRead` on the key row, which has misled twice. **The limit comes off the wire**,
 * so a device that reports a bigger one must accept a longer name without this file being touched.
 * And **the writes that go out are the ones the device was measured to take**, in order, with the
 * stages unwaited and only the apply asked for an answer.
 */
// The DOM comes from `test-preload.ts`, which registers it once for the whole run — see there for
// why it cannot be done here.
const { afterAll, afterEach, beforeEach, expect, mock, test } = await import('bun:test')

/**
 * The real `@/device/link`, SPREAD into a plain object so it is a snapshot rather than a live
 * namespace, ready to be put back when this file is done. `flashfail.test.tsx` carries the full
 * reasoning; `src/device/mock-isolation.test.ts` is the probe that fails if any of the three files
 * mocking this module forgets to restore it.
 */
const realLink = { ...(await import('@/device/link')) }
const { atom, getDefaultStore } = await import('jotai')
const store = getDefaultStore()
// The REAL decoder and matcher, so the stand-in for `chaseAdvName` turns bytes into a report exactly
// as `link.ts` does. A second decoder here would be a second thing to get wrong.
const { decodeAdvName: decode } = await import('@/device/advname')
const { isAdvName: isAdvNameReply } = await import('@/device/protocol')

/** What the fake device was asked, in order — the assertion target for every write test. */
let sent: number[][] = []
/** Names handed to the app's single name writer. A rename that does not reach it never leaves this
 *  sheet, which is the shape of the bug that left the saved list showing an old name. */
let noted: string[] = []
/** How the fake device answers a command. `null` is a device that says nothing. */
let answer: (bytes: number[]) => number[] | null = () => null
/** WRITABLE, so a test can connect after the tab is already open. */
const linkState = atom<'disconnected' | 'connecting' | 'connected'>('connected')
/** Where the row reads the name from. Writable so a test can fill it BEFORE the row mounts, which
 *  is the real sequence: by the time anybody can tap Install, the connect path has already asked. */
const advName = atom<{ name: string; max: number; error: string | null } | null | undefined>(undefined)

await mock.module('@/device/link', () => ({
  // The atoms `state/atoms.ts` re-exports. Real atoms, so the store and the derived `capsAtom`
  // behave exactly as they do in the app — a connected thermostat running our firmware on both
  // chips, which is the only state in which this row is reachable at all.
  linkStateAtom: linkState,
  // DERIVED FROM THE ONE ABOVE, exactly as the real one is — a second flag here would let a test
  // reach a state the app cannot: connected and not connected at the same time.
  connectedAtom: atom((get) => get(linkState) === 'connected'),
  chipVersionAtom: atom({ product: 0x1000, major: 5, minor: 0 }),
  fwVersionAtom: atom(200),
  deviceNameAtom: atom<string | null>(null),
  grantedAtom: atom<number | null>(1),
  grantedSettledAtom: atom(true),
  repliesAtom: atom(0),
  statusAtom: atom(null),
  advNameAtom: advName,
  keyStatusAtom: atom(null),
  request: async (bytes: number[], match: (b: Uint8Array) => boolean) => {
    sent.push(bytes)
    const r = answer(bytes)
    const b = r && new Uint8Array(r)
    return b && match(b) ? b : null
  },
  send: async (bytes: number[]) => {
    sent.push(bytes)
  },
  disconnect: () => {},
  expectReplyUnderNewKey: () => {},
  // Files the reply and records the name — a stub that only counted the call would leave the row
  // empty and every assertion below meaningless. A REFUSAL is not a new name, same as the real one.
  noteAdvName: (got: { name: string; error: string | null } | null) => {
    store.set(advName, got as never)
    if (got && !got.error) noted.push(got.name)
  },
  // The connect path's read, which the tab re-fires when it opens.
  chaseAdvName: async () => {
    const r = answer([0x5b, 0x02])
    const b = r && new Uint8Array(r)
    sent.push([0x5b, 0x02])
    const got = b && isAdvNameReply(b) ? decode(b) : null
    // Silence only counts while nothing is known — the real one's rule, and what the last test here
    // guards.
    if (!got && store.get(advName) !== undefined) return
    store.set(advName, got as never)
  },
  refreshKeyStatus: async () => null,
  noteKeyStatus: () => {},
  rearmSealing: async () => {},
}))

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { AccessSettings } = await import('./AccessSettings')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ascii = (s: string) => Array.from(new TextEncoder().encode(s))
/** A name report: `5b | sub | rc | max | name`. */
const report = (name: string, max = 16, rc = 0) => [0x5b, 0x02, rc, max, ...ascii(name)]

let host: HTMLElement
let root: ReturnType<typeof createRoot>

const mount = async () => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(<AccessSettings />))
  // The read is fired from an effect, so one more flush is needed before its answer is on screen.
  await act(async () => {})
}

/**
 * EVERYTHING IS QUERIED OFF `document.body`, NOT OFF THE MOUNT POINT. `Sheet` is a Radix dialog and
 * therefore a PORTAL — its contents are appended to the body, outside the tree this test rendered —
 * so a query scoped to the mount point finds the row and none of the sheet it opens.
 */
const screen = () => document.body

/** The row's own text, which is where all three states are said. The sheet has no `li`. */
const rowText = () =>
  [...host.querySelectorAll('li')].map((li) => li.textContent ?? '').find((t) => t.includes('Bluetooth name')) ?? ''

const click = async (label: string | RegExp) => {
  const el = [...screen().querySelectorAll('button')].find((b) =>
    typeof label === 'string' ? b.textContent?.includes(label) : label.test(b.textContent ?? ''),
  )
  if (!el) throw new Error(`no button matching ${label}; had: ${[...screen().querySelectorAll('button')].map((b) => b.textContent).join(' | ')}`)
  await act(async () => el.click())
}

const typeName = async (value: string) => {
  const input = screen().querySelector<HTMLInputElement>('#advname')
  if (!input) throw new Error('the name field is not on screen')
  await act(async () => {
    // React listens for `input`, not for the property write, so both are needed.
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  sent = []
  noted = []
  answer = () => null
  store.set(linkState, 'connected')
  store.set(advName, undefined)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

/** PUT `@/device/link` BACK, so the stand-in above stops at this file. See `realLink`. */
afterAll(async () => {
  await mock.module('@/device/link', () => realLink)
})

test('a device that answers shows the name it is actually called', async () => {
  answer = (b) => (b[0] === 0x5b ? report('Living room') : null)
  await mount()
  // THE AIRED NAME, NOT THE STORED ONE. The row is about what a person will see in their browser's
  // device list, and the thermostat adds the prefix — so an assertion on the bare text would pass on
  // a row that had silently dropped it. `toContain('Living room')` is exactly that weak assertion.
  expect(rowText()).toContain('eQ3-Living room')
})

test('the default name is reported AS the problem it is, not as a name', async () => {
  answer = (b) => (b[0] === 0x5b ? report('CC-RT-BLE') : null)
  await mount()
  // The point of the feature is that this name identifies nothing, so the row says so rather than
  // printing it as though it were an answer.
  expect(rowText()).toMatch(/every other thermostat/)
})

test('a radio that does not answer says what to do, and the row cannot be opened', async () => {
  // A stock radio, and an older build of ours, both land here — and the app-info version cannot
  // tell them apart from a current one, which is why the read IS the probe.
  answer = () => null
  await mount()
  // The sentence is `caps.ts`'s, not this row's — a control says what it NEEDS and the gate says
  // why it is not met, so this asserts the sentence a person actually reads.
  expect(rowText()).toMatch(/does not answer the name command/)
  const row = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Bluetooth name'))!
  expect(row.hasAttribute('disabled')).toBe(true)
})

test('saving sends the stages and then the guarded apply, in that order', async () => {
  answer = (b) => (b[0] === 0x5b ? report(b[1] === 0x01 ? 'Living room' : 'CC-RT-BLE') : null)
  await mount()
  await click('Bluetooth name')
  await typeName('Living room')
  await click('Save')
  const writes = sent.filter((w) => w[0] === 0x5b && w[1] !== 0x02)
  expect(writes).toEqual([
    [0x5b, 0x00, 0, ...ascii('Living r')],
    [0x5b, 0x00, 8, ...ascii('oom'), 0, 0, 0, 0, 0],
    [0x5b, 0x01, 11, 0xa5],
  ])
})

test('the limit is the device`s, so a longer one accepts a longer name', async () => {
  answer = (b) => (b[0] === 0x5b ? report('CC-RT-BLE', 24) : null)
  await mount()
  await click('Bluetooth name')
  await typeName('123456789012345678')
  // Eighteen bytes is over the sixteen this firmware allows and inside the twenty-four this fake
  // device reports. Nothing in the app may hold the smaller number.
  const save = [...screen().querySelectorAll('button')].find((b) => b.textContent?.includes('Save'))!
  expect(save.hasAttribute('disabled')).toBe(false)
  expect(screen().textContent).toContain('18 of 24 bytes')
})

test('a name that is too long cannot be sent at all', async () => {
  answer = (b) => (b[0] === 0x5b ? report('CC-RT-BLE') : null)
  await mount()
  await click('Bluetooth name')
  await typeName('12345678901234567')
  const save = [...screen().querySelectorAll('button')].find((b) => b.textContent?.includes('Save'))!
  expect(save.hasAttribute('disabled')).toBe(true)
  expect(screen().textContent).toContain('too long')
})

test('the counter is in BYTES, which is the only count the device agrees with', async () => {
  answer = (b) => (b[0] === 0x5b ? report('CC-RT-BLE') : null)
  await mount()
  await click('Bluetooth name')
  await typeName('Küche')
  expect(screen().textContent).toContain('6 of 16 bytes')
  expect(screen().textContent).toContain('accents and emoji count more')
})

test('"Use CC-RT-BLE" is one guarded apply of length zero, and no stage', async () => {
  answer = (b) => (b[0] === 0x5b ? report(b[1] === 0x01 ? 'CC-RT-BLE' : 'Living room') : null)
  await mount()
  await click('Bluetooth name')
  await click(/^Use CC-RT-BLE$/)
  expect(sent.filter((w) => w[0] === 0x5b && w[1] !== 0x02)).toEqual([[0x5b, 0x01, 0, 0xa5]])
})

test('a refused name leaves the row showing what the thermostat is STILL called', async () => {
  answer = (b) =>
    b[0] !== 0x5b ? null : b[1] === 0x01 ? report('Hall', 16, 1) : report('Hall')
  await mount()
  await click('Bluetooth name')
  await typeName('Kitchen')
  await click('Save')
  // The sheet stays open — the name was not accepted, so there is something still to do — and the
  // device's own words are on screen rather than a guess about why.
  expect(screen().textContent).toMatch(/refused that name/)
  expect(rowText()).toContain('eQ3-Hall')
  expect(rowText()).not.toContain('Kitchen')
})

test('a successful rename reaches the app`s single name writer', async () => {
  // WITHOUT THIS THE NEW NAME NEVER LEAVES THIS SHEET. The saved list and the top bar both show the
  // name, and the browser's own copy of it is a cache that does not refresh when a thermostat is
  // renamed — so this reply is the only thing that knows, and handing it on is the whole fix for a
  // list that kept showing the old name after a rename.
  answer = (b) =>
    b[0] !== 0x5b ? null : b[1] === 0x01 ? report('Living room', 15) : report('CC-RT-BLE', 15)
  await mount()
  await click('Bluetooth name')
  await typeName('Living room')
  await click('Save')
  // The OWNER'S text, not the aired one: applying the prefix is the writer's job, done once.
  expect(noted).toEqual(['Living room'])
})

test('a REFUSED rename tells nothing to the name writer', async () => {
  // The device kept the name it had, so announcing the rejected one would put a name on the saved
  // list that no thermostat answers to.
  answer = (b) =>
    b[0] !== 0x5b ? null : b[1] === 0x01 ? report('Hall', 15, 1) : report('Hall', 15)
  await mount()
  await click('Bluetooth name')
  await typeName('Kitchen')
  await click('Save')
  expect(noted).toEqual([])
})

test('the prefix sits in the field itself, outside the editable part', async () => {
  // A field that did not show it would ask for one thing and produce another, and a person who
  // typed it themselves would get `eQ3-eQ3-Kitchen`. It lives in the addon, so what `value` holds
  // stays the owner's text and everything counting bytes keeps counting the right string.
  answer = (b) => (b[0] === 0x5b ? report('CC-RT-BLE', 15) : null)
  await mount()
  await click('Bluetooth name')
  const addon = screen().querySelector('[data-slot="input-group-addon"]')
  expect(addon?.textContent).toBe('eQ3-')
  await typeName('Kitchen')
  expect(screen().querySelector<HTMLInputElement>('#advname')?.value).toBe('Kitchen')
})

test('the sheet says a rename is not visible until you disconnect', async () => {
  // THE TWO REASONS A RENAME LOOKS LIKE IT FAILED, and the first is the device's own doing: the name
  // rides the scan response, a connected peripheral advertises non-connectable, and a
  // non-connectable advert is not scannable — so it sends no scan response to anyone while this app
  // holds the link, and a client cannot observe its own rename `[manually verified]`. The second is
  // the platform's name cache, which the page cannot clear. Both end at the same instruction.
  answer = (b) => (b[0] === 0x5b ? report('CC-RT-BLE', 15) : null)
  await mount()
  await click('Bluetooth name')
  expect(screen().textContent).toMatch(/only goes out once nothing is connected/)
  expect(screen().textContent).toMatch(/Bluetooth settings/)
})

test('opening this tab BEFORE the link is up still reads the name once it is', async () => {
  // This tab is reachable while the link is still coming up, and a row that asks only once — at
  // mount — says `…` for the rest of the session.
  answer = (b) => (b[0] === 0x5b ? report('Living room') : null)
  store.set(linkState, 'connecting')
  await mount()
  expect(rowText()).not.toContain('Living room')
  await act(async () => store.set(linkState, 'connected'))
  await act(async () => {})
  expect(rowText()).toContain('eQ3-Living room')
})

test('the row shows what the CONNECTION already learnt, and a lost re-read does not take it away', async () => {
  // `link.ts` reads the name on every connect, so by the time anybody can tap Install the answer
  // exists and the row shows it at once. The silent device is the second half: opening the tab
  // re-asks, that ask gets nothing, and the row must keep the name rather than decide this radio is
  // too old to be renamed.
  store.set(advName, { name: 'Living room', max: 15, error: null })
  answer = () => null
  await mount()
  expect(rowText()).toContain('eQ3-Living room')
  const row = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Bluetooth name'))!
  expect(row.hasAttribute('disabled')).toBe(false)
})
