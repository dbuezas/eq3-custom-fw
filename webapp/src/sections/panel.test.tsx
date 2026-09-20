/**
 * The panel renders, changes and goes away without taking the app with it.
 *
 * The drawing is `components/PanelArt.tsx` — ordinary tags — so the failures that used to be
 * possible here are gone by construction: nothing parses a document at startup, nothing translates
 * an attribute name, nothing can drop a text node on the way through. TypeScript sees the whole
 * drawing.
 *
 * What is left worth asserting is the part React does, and the part a person can still get wrong:
 * the ids the firmware tables name are on the page, a lit one gets its class and an unlit one does
 * not, the SAME nodes survive a re-render (the flicker, as an assertion), and unmounting is clean
 * (the crash, as an assertion).
 */
// The DOM comes from `test-preload.ts`, which registers it once for the whole run.
const { expect, test } = await import('bun:test')
const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { PanelArt } = await import('@/components/PanelArt')
const { litIds } = await import('./Display')

/** React 19 wants this set, and complains on every render otherwise. */
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const clsFor = (on: ReadonlySet<string>) => (id: string, base: string) =>
  on.has(id) ? `${base} on` : base

const mount = () => {
  const host = document.createElement('div')
  document.body.append(host)
  return { host, root: createRoot(host) }
}

test('the ids the firmware tables name are all on the page', async () => {
  const { host, root } = mount()
  await act(async () => root.render(<PanelArt cls={clsFor(new Set())} />))
  // One of each KIND of id — these are the contract between the artwork and the tables. The full
  // lists live in the generated tables; restating them here would be a second copy to drift.
  for (const id of ['bar0', 'bar23', 'day0', 'day6', 'd0.a', 'd3.g', 'colon', 'Auto', 'battery'])
    expect(`${id}: ${host.querySelector(`[id="${id}"]`) ? 'present' : 'MISSING'}`).toBe(
      `${id}: present`,
    )
  await act(async () => root.unmount())
})

test('a lit id gets `on`, an unlit one does not, and it flips back', async () => {
  const { host, root } = mount()
  const cls = (id: string) => host.querySelector(`[id="${id}"]`)?.getAttribute('class')

  await act(async () => root.render(<PanelArt cls={clsFor(new Set(['bar0']))} />))
  expect(cls('bar0')).toBe('seg on')
  expect(cls('bar1')).toBe('seg')

  await act(async () => root.render(<PanelArt cls={clsFor(new Set(['bar1']))} />))
  expect(cls('bar0')).toBe('seg')
  expect(cls('bar1')).toBe('seg on')
  await act(async () => root.unmount())
})

test('THE ELEMENTS SURVIVE A RE-RENDER — this is the flicker, as an assertion', async () => {
  const { host, root } = mount()
  await act(async () => root.render(<PanelArt cls={clsFor(new Set(['bar0']))} />))
  const seg = host.querySelector('[id="bar0"]')
  const glass = host.querySelector('svg')

  await act(async () => root.render(<PanelArt cls={clsFor(new Set(['bar0', 'bar1']))} />))
  // The SAME nodes, with one class changed. The version that flickered replaced every one of them
  // on every poll, and the eye reported that as a blink.
  expect(host.querySelector('[id="bar0"]')).toBe(seg)
  expect(host.querySelector('svg')).toBe(glass)
  await act(async () => root.unmount())
})

test('unmounting is clean — this is the crash on leaving the tab, as an assertion', async () => {
  const { host, root } = mount()
  await act(async () => root.render(<PanelArt cls={clsFor(new Set())} />))
  await act(async () => root.unmount())
  expect(host.innerHTML).toBe('')
})

test('the fixed labels on the glass keep their words', async () => {
  const { host, root } = mount()
  await act(async () => root.render(<PanelArt cls={clsFor(new Set())} />))
  // The weekday letters and "Auto"/"Manu" are real <text>. A conversion that kept only elements
  // would drop them silently, and the panel would look almost right.
  expect(host.textContent).toContain('Auto')
  await act(async () => root.unmount())
})

test('litIds is empty with no panel data, so nothing lights before the first read', () => {
  expect(litIds(null).size).toBe(0)
})
