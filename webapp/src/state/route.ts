/**
 * WHERE THE APP IS, WRITTEN IN THE ADDRESS BAR — `/` is the list, `/thermostat/<id>/<tab>` is a
 * thermostat.
 *
 * ================================================================================================
 * THE URL IS THE STATE, NOT A COPY OF IT
 * ================================================================================================
 * The app reads `openIdAtom`, `sectionAtom` and `unsavedAtom`, and every one of them is DERIVED from
 * the location rather than held beside it. That is the whole design: atoms mirrored into the URL
 * would be two sources of truth that drift the moment the phone's Back button moves one of them,
 * and drift here means an app showing one thermostat's tabs over another thermostat's connection.
 *
 * **No router.** Two path shapes do not need a tree, a matcher and a second idea of what a page is;
 * `jotai-location`'s `atomWithLocation` turns the address into an atom and the rest is a regular
 * expression. `[owner]`
 *
 * ================================================================================================
 * WHAT PUSHES AND WHAT REPLACES, because that is the whole of the Back button's behaviour
 * ================================================================================================
 * Opening a thermostat PUSHES; changing tab REPLACES. So Back is one hop from any tab back to the
 * list, rather than a walk back through every tab visited — and one more press from the list leaves
 * the app, because the list is where it started. `[owner]`
 *
 * That is also why leaving a thermostat is `leave()` and not `set(openIdAtom, null)`: the way back
 * from a pushed entry is history, and pushing `/` on top instead would leave the list sitting on a
 * stack whose next Back goes forward into the thermostat again. `leave()` falls back to replacing
 * the path when this session never pushed — which is exactly the deep-link case, where there is no
 * entry of ours to go back to and Back would leave the app entirely.
 *
 * ================================================================================================
 * A MAC IN THE URL IS A MAC IN HISTORY
 * ================================================================================================
 * Nothing leaves the device — this is a static page with no server — but the address goes into
 * browser history, and whatever syncs history syncs it. The alternative is an opaque
 * id, which costs the linkability that is the point of the feature. The plain MAC is the owner's
 * call `[owner]`.
 */
import { atom } from 'jotai'
import { atomWithLocation } from 'jotai-location'

import { normId } from './registry'

/** Which tab is showing. `App.tsx`'s header says what each one holds and why. */
export type Section = 'status' | 'settings' | 'display' | 'install'

const SECTIONS = ['status', 'settings', 'display', 'install'] as const
const isSection = (s: string | undefined): s is Section =>
  (SECTIONS as readonly string[]).includes(s ?? '')

/** `/thermostat/<id>` with an optional tab. Anything else is the list. */
const ROUTE = /^\/thermostat\/([^/]+)(?:\/([^/]+))?\/?$/

/**
 * `/connected` — **the device this link is attached to, which has no row** `[owner]`.
 *
 * Every other address names a saved thermostat, and a thermostat is named by what it says about
 * itself. **A device whose STM8 is sitting in its updater after an interrupted install says
 * nothing** — not its MAC, not its serial — so there is no identifier to put in an address, and yet
 * it is exactly the device somebody needs to reach, because the installer can still rescue it.
 *
 * So this one address means "whatever is on the other end right now". It is deliberately NOT
 * bookmarkable in any useful sense: reloading it lands on a page with no connection, which is the
 * truth — there is nothing to re-attach to, because there is nothing to re-attach BY.
 */
const CONNECTED = /^\/connected\/?$/

/**
 * Read a path. **Never throws and never 404s**: an address this app does not recognise is the list,
 * which is the only answer that leaves a person somewhere they can act. An unknown tab on a known
 * thermostat is Status for the same reason.
 */
/**
 * WHAT THE APP IS SERVED UNDER, with no trailing slash — `''` at a site root, `/eq3-custom-fw` on a
 * GitHub project page. Vite substitutes `BASE_URL` at build time from `base` in `vite.config.ts`, so
 * this is the ONE place the deployment path enters the app and neither half below can disagree with
 * the other about it.
 *
 * **Every address in this file is absolute, so without this the app is unusable anywhere but a
 * root.** `parsePath` would not match its own URLs (the prefix is in front of `/thermostat/...`), so
 * every deep link would land on the front-door list; and `pathFor` would push a path with no prefix,
 * navigating clean off the site. Both directions fail, and neither says why.
 *
 * `?? '/'` because a test runner is not Vite and does not define the variable. **That is also why
 * the two helpers below take the base as an ARGUMENT rather than closing over this one**: under
 * `bun test` `BASE_URL` is undefined, so every path here collapses to the no-op root case and the
 * prefixing would ship completely untested — which is precisely the half that only runs in the
 * deployment nobody can try locally. Parameterised, the tests exercise the real thing.
 */
const BASE = (import.meta.env?.BASE_URL ?? '/').replace(/\/+$/, '')

/** Take the deployment prefix off an incoming path, so the routes below see what they expect. */
export const stripBase = (base: string, p: string) =>
  base && p.startsWith(base) ? p.slice(base.length) || '/' : p

/** Put it back on, for every address this app hands to the browser. */
export const withBase = (base: string, p: string) => base + p

export function parsePath(pathname = '/'): {
  id: string | null
  /** `/connected`: a live link with no row behind it. See `CONNECTED`. */
  unsaved: boolean
  section: Section
} {
  pathname = stripBase(BASE, pathname)
  if (CONNECTED.test(pathname)) return { id: null, unsaved: true, section: 'install' }
  const m = ROUTE.exec(pathname)
  if (!m) return { id: null, unsaved: false, section: 'status' }
  // normId so a hand-typed or upper-case address still finds the row it names — and so a SERIAL,
  // which is what a row keyed by one carries here, survives unchanged rather than being mangled
  // into a MAC-shaped string that matches nothing (`registry.ts`, `normId`).
  return {
    id: normId(decodeURIComponent(m[1]!)),
    unsaved: false,
    section: isSection(m[2]) ? m[2] : 'status',
  }
}

/**
 * **A COLON IS LEGAL IN A PATH SEGMENT, and escaping it turns a readable address into a wall of
 * `%3A`.** The whole point of putting the identity in the bar is that a person can look at it and
 * see which thermostat it is. So encode — an id is the device's own string and is not trusted to be
 * path-safe — and then put the colons back, which is the one character a MAC needs and the only
 * one this ever produces.
 */
const encodeId = (id: string) => encodeURIComponent(id).replace(/%3A/gi, ':')

export const pathFor = (id: string | null, section: Section) =>
  withBase(BASE, id ? `/thermostat/${encodeId(id)}/${section}` : '/')

const locationAtom = atomWithLocation()

/** True once this session has pushed a thermostat entry — i.e. once there is history of ours. */
let pushed = false

/**
 * WHICH THERMOSTAT IS OPEN, and the app's largest piece of state: null means the front-door list is
 * covering everything and the tabs do not exist. It is a row's `id` — its serial, or its MAC when it
 * has no serial — because that is the identity a row keeps across a reconnect, a rename, an import
 * and a firmware change. `state/registry.ts`'s header says why it cannot simply be the MAC.
 *
 * Opening one always lands on Status: the tab is part of the address, so it cannot be carried over
 * from wherever the last thermostat was left — Install included.
 */
export const openIdAtom = atom(
  (get) => parsePath(get(locationAtom).pathname).id,
  (_get, set, id: string | null) => {
    if (id) pushed = true
    set(locationAtom, (l) => ({ ...l, pathname: pathFor(id, 'status') }), { replace: !id })
  },
)

/** Which tab is showing. Replaces rather than pushes — see the header. */
export const sectionAtom = atom(
  (get) => parsePath(get(locationAtom).pathname).section,
  (get, set, section: Section) => {
    const id = parsePath(get(locationAtom).pathname).id
    if (!id) return // there are no tabs on the list; ignore rather than invent a path
    set(locationAtom, (l) => ({ ...l, pathname: pathFor(id, section) }), { replace: true })
  },
)

/**
 * Whether the app is on `/connected` — a live link with no saved row behind it.
 *
 * Read-only and separate from `openIdAtom` rather than folded into it as some sentinel id, because
 * the two are genuinely different states and every consumer has to tell them apart: one has a row to
 * read a name, a key and a channel off, and this one has nothing but the link.
 */
export const unsavedAtom = atom((get) => parsePath(get(locationAtom).pathname).unsaved)

/** Go to `/connected`. Pushes, so Back returns to wherever the person was. */
export const openUnsavedAtom = atom(null, (_get, set) => {
  pushed = true
  set(locationAtom, (l) => ({ ...l, pathname: `${BASE}/connected` }))
})

/**
 * Go back to the list — the in-app answer to the same gesture the phone's Back button makes.
 *
 * History where there is history, so the entry this app pushed is spent rather than buried. On a
 * deep link there is none, so the path is replaced instead; going back there would leave the app,
 * which is not what a Back ARROW inside it means.
 */
export const leaveAtom = atom(null, (_get, set) => {
  if (pushed) {
    pushed = false
    window.history.back()
    return
  }
  set(locationAtom, (l) => ({ ...l, pathname: `${BASE}/` }), { replace: true })
})
