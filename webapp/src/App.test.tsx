/**
 * The front door renders, off a browser.
 *
 * IT IS THE FIRST PAINT OF THE FIRST SCREEN, so a throw here is a blank page rather than a degraded
 * one — and everything it touches on the way is exactly what has no browser to fall back on: the
 * registry reading a store that may not exist, the advert layer feature-detecting an API that is
 * absent, and the link module being imported at all. All three are the paths a person meets before
 * they have granted anything.
 *
 * `renderToString` runs no effects, which is the point: this asserts the render, not the plumbing.
 */
import { expect, test } from 'bun:test'
import { Provider, createStore } from 'jotai'
import { renderToString } from 'react-dom/server'

import App from './App'
import { UnsavedDevice } from './components/UnsavedDevice'
import { linkIdsAtom, linkStateFor } from './device/link'
import { registryAtom as storedRegistryAtom } from './state/registry'
import { openUnsavedAtom } from './state/route'

test('with nothing saved, the app renders its empty front door', () => {
  const html = renderToString(<App />)
  expect(html).toContain('Thermostats')
  expect(html).toContain('No thermostats yet')
  // The tabs do not exist until a thermostat is picked — see App.tsx's header. It asserts the tab
  // BAR and not a tab's LABEL, because `Install` is also the word on the front door's own
  // install-this-app row. `<nav>` is the tab bar and the app has no other.
  expect(html).not.toContain('<nav')
})

test('saved thermostats render as rows, before any broadcast has arrived', () => {
  // A store of its own, seeded with the ONE stored value the app derives everything from — one
  // value, not two that a bridge keeps in step. It is not the app's default store, so this test
  // cannot be disturbed by whatever `localStorage` holds.
  const store = createStore()
  store.set(storedRegistryAtom, {
    version: 1,
    devices: [
      { id: '00:1a:22:aa:bb:cc', mac: '00:1a:22:aa:bb:cc', name: 'Bedroom' },
      { id: 'OEQ0000001', serial: 'OEQ0000001', name: 'Study' },
    ],
    presets: [],
  })

  const html = renderToString(
    <Provider store={store}>
      <App />
    </Provider>,
  )
  expect(html).toContain('Bedroom')
  expect(html).toContain('Study')
  expect(html).not.toContain('No thermostats yet')
  // A ROW WITH NO BROADCAST SAYS SO rather than showing a blank or a stale number — a thermostat
  // out of range and one that was never granted look identical from here.
  expect(html).toContain('nothing heard yet')
  expect(html).toContain('not granted to this page')
  // Forgetting is destructive and irreversible — the thermostat will not give a key back — so the
  // row offers it and never does it in one tap.
  expect(html).toContain('Forget')
  expect(html).not.toContain('Forget <strong>')
})

/**
 * `/connected` — the screen for a thermostat that cannot say which one it is.
 *
 * **Rendered directly rather than through the app's routing**, which reads `window.location` and has
 * no window here. The route itself is held by `state/route.test.ts`; this is the screen.
 *
 * It is worth a render at all because the device it serves is one we cannot produce on the bench: an
 * STM8 sitting in its updater after an interrupted install. Making one means deliberately
 * interrupting a flash, so this is as close as a test gets to proving the two states are right.
 */
test('a connected thermostat with no row is offered the installer', () => {
  const store = createStore()
  // THREE PIECES, BECAUSE "IS THE LINK UP" IS DERIVED NOW — the app holds a connection per
  // thermostat rather than one connection: a link state keyed by the
  // browser's handle, that handle being live, and the address being `/connected` — which is what
  // makes it the ACTIVE one, since a handle with no saved row behind it is exactly this screen's
  // device.
  store.set(openUnsavedAtom)
  store.set(linkIdsAtom, ['a-handle-with-no-row'])
  store.set(linkStateFor('a-handle-with-no-row'), 'connected')

  const html = renderToString(
    <Provider store={store}>
      <UnsavedDevice />
    </Provider>,
  )
  // The one thing this device can do, and the sentence that says why it is not in the list.
  expect(html).toContain('Firmware')
  expect(html).toContain('has not said which one it is')
  expect(html).not.toContain('That connection is gone')
})

test('...and when that link drops it says so, because there is no way back to it', () => {
  // No id means nothing to re-attach BY, so offering a retry here would be offering nothing.
  const html = renderToString(
    <Provider store={createStore()}>
      <UnsavedDevice />
    </Provider>,
  )
  expect(html).toContain('That connection is gone')
  expect(html).not.toContain('Firmware')
})
