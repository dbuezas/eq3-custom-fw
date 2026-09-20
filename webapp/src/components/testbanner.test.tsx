/**
 * The `?test=1` banner. `App` decides whether to render it, so this needs no module mock — which is
 * the point: a `mock.module` in bun is global to the run, and mocking the flag here turned test
 * mode on for six other files.
 */
// The DOM comes from `test-preload.ts`, which registers it once for the whole run.
const { expect, test } = await import('bun:test')

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { TestBanner } = await import('./TestBanner')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

test('the banner says nothing here is real, and offers the way out', async () => {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(<TestBanner />))

  expect(host.textContent).toContain('nothing here is a real thermostat')
  const exit = [...host.querySelectorAll('button')].map((b) => b.textContent ?? '')
  expect(exit.some((t) => /Exit test mode/.test(t))).toBe(true)

  await act(async () => root.unmount())
  host.remove()
})
