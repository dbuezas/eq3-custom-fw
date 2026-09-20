/**
 * Copying one day's programme onto any set of the others.
 *
 * The three group buttons cannot say "Saturday onto Sunday", which is what the day row is for. What
 * is worth asserting here is the part no unit test of `schedule.ts` can see: that an INDIVIDUAL day
 * is reachable at all, that a group shortcut never aims at the day being copied FROM, and that what
 * lands is the source day's programme.
 *
 * Everything is read off the send summary, which `plan()` derives from the whole week — so it moves
 * only when the week really changed, and it says exactly how.
 */
// The DOM comes from `test-preload.ts`, which registers it once for the whole run.
const { afterAll, beforeEach, afterEach, expect, mock, test } = await import('bun:test')

/**
 * The real `@/device/link`, SPREAD into a plain object so it is a snapshot rather than a live
 * namespace, ready to be put back when this file is done. `flashfail.test.tsx` carries the full
 * reasoning; `src/device/mock-isolation.test.ts` is the probe that fails if any of the three files
 * mocking this module forgets to restore it.
 */
const realLink = { ...(await import('@/device/link')) }
const { atom } = await import('jotai')

/** How the fake device answers `cmd 0x20 <day>`. */
let answer: (day: number) => number[] = () => []

await mock.module('@/device/link', () => ({
  linkStateAtom: atom('connected'),
  connectedAtom: atom(true),
  chipVersionAtom: atom({ product: 0x1000, major: 5, minor: 0 }),
  fwVersionAtom: atom(200),
  deviceNameAtom: atom<string | null>(null),
  grantedAtom: atom<number | null>(1),
  grantedIdsAtom: atom<string[] | null>([]),
  grantedSettledAtom: atom(true),
  repliesAtom: atom(0),
  statusAtom: atom(null),
  advNameAtom: atom(undefined),
  keyStatusAtom: atom(null),
  settingsAtom: atom(null),
  request: async (bytes: number[]) => new Uint8Array(answer(bytes[1]!)),
}))

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { ScheduleSheet } = await import('./ScheduleSheet')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** A whole day at one temperature: `21 <day> (temp*2, 1440min) x 7`. */
const flat = (day: number, temp: number) =>
  [0x21, day, ...Array.from({ length: 7 }, () => [temp * 2, 144]).flat()]

let host: HTMLElement
let root: ReturnType<typeof createRoot>

const mount = async () => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(<ScheduleSheet onClose={() => {}} />))
  // Seven reads, each its own await.
  for (let i = 0; i < 10; i++) await act(async () => {})
}

/** Everything is in a portal, so queries go to the body. */
const buttons = (within: ParentNode = document.body) => [...within.querySelectorAll('button')]
const click = async (label: string | RegExp, within?: ParentNode) => {
  const el = buttons(within).find((b) =>
    typeof label === 'string' ? b.textContent?.trim() === label : label.test(b.textContent ?? ''),
  )
  if (!el) throw new Error(`no button ${label}; had: ${buttons(within).map((b) => b.textContent).join(' | ')}`)
  await act(async () => el.click())
}
/**
 * The copy panel, so a day can be TICKED rather than switched to.
 *
 * Both rows carry `Mon`…`Sun`: the strip picks what is being edited, the panel picks what it is
 * copied onto. A query over the whole sheet finds the strip first, which is a different action.
 */
const panel = () => {
  const cancel = buttons().find((b) => b.textContent?.trim() === 'Cancel')
  const el = cancel?.closest('.rounded-xl')
  if (!el) throw new Error('the copy panel is not open')
  return el
}
/** The "n commands" line, which is `plan()` on the whole week. */
const summary = () => document.body.textContent ?? ''

beforeEach(() => {
  // Weekdays at 21, weekend at 17 — two commands, and every copy below changes that number.
  answer = (day) => flat(day, day === 0 || day === 1 ? 17 : 21)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

/** PUT `@/device/link` BACK, so the stand-in above stops at this file. See `realLink`. */
afterAll(async () => {
  await mock.module('@/device/link', () => realLink)
})

test('a group shortcut never aims at the day being copied FROM', async () => {
  await mount()
  await click(/Copy Monday to/)
  await click('every day', panel())
  // Six, not seven: Monday is the source and cannot be a target of its own copy.
  expect(summary()).toContain('Copy onto 6 days')
  await click('Mon–Fri', panel())
  expect(summary()).toContain('Copy onto 4 days')
})

test('the day being copied from cannot be ticked', async () => {
  await mount()
  await click(/Copy Monday to/)
  const mon = buttons(panel()).find((b) => b.textContent?.trim() === 'Mon')!
  expect(mon.hasAttribute('disabled')).toBe(true)
})

test('one individual day can be copied onto, which the group buttons cannot express', async () => {
  await mount()
  expect(summary()).toContain('weekend and weekdays — two commands')
  await click(/Copy Monday to/)
  await click('Sat', panel())
  await click('Copy onto 1 day', panel())
  // Saturday now holds Monday's programme and Sunday does not, so the weekend is no longer a group:
  // Sat, Sun, then the five weekdays together.
  expect(summary()).toContain('3 commands')
})

test('copying onto the whole weekend makes the week one command', async () => {
  await mount()
  await click(/Copy Monday to/)
  await click('Sat & Sun', panel())
  await click('Copy onto 2 days', panel())
  expect(summary()).toContain('all seven days are the same — one command')
})

test('cancel copies nothing', async () => {
  await mount()
  await click(/Copy Monday to/)
  await click('Sat & Sun', panel())
  await click('Cancel', panel())
  expect(summary()).toContain('weekend and weekdays — two commands')
})

test('changing the day being edited shuts the panel, so a stale Copy cannot fire', async () => {
  await mount()
  await click(/Copy Monday to/)
  await click('Sat & Sun', panel())
  // The STRIP's Sat, which is the first one in the document.
  await click('Sat')
  expect(summary()).toContain('Copy Saturday to')
  expect(summary()).not.toContain('Copy onto')
})
