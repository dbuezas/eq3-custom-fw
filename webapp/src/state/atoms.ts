/**
 * App state — what the UI shows, and where the pieces are JOINED.
 *
 * ================================================================================================
 * IT DOES NOT DECLARE THE DEVICE'S VALUES; IT RE-EXPORTS AND DERIVES THEM
 * ================================================================================================
 * The link state, the two firmware versions, the status, whether replies arrive, the granted count
 * and the broadcasts all belong to the modules that produce them, and each is an atom *there* —
 * ONE FACT, ONE HOME (`webapp/README.md`). **Re-exported rather than re-declared**, so a component
 * still writes `import { statusAtom } from '@/state/atoms'` and gets the real one. A second atom
 * copied across by an effect is the shape to refuse: a copy that is never written typechecks and
 * renders perfectly.
 *
 * THE OTHER RULE THIS FILE KEEPS: an atom may hold a value read from the device, and an action may
 * ASK for one — but every actual byte goes through `device/link.ts`'s `request()`, which is the one
 * place with a queue. Nothing here may reach a characteristic, and it cannot: `link.ts` does not
 * export one. See that file's header for why pipelining faults the radio chip in ~30 s.
 */
import { atom } from 'jotai'
// `jotai-family`, not `jotai/utils`: the built-in atomFamily is deprecated and goes in Jotai 3, and
// it says so on every test run.
import { atomFamily } from 'jotai-family'

import { EMPTY_REPORT, advertsAtom, type AdvertReport } from '@/device/advert'
import { openIdAtom } from './route'
import {
  advNameAtom,
  chipVersionAtom,
  connectedAtom,
  deviceNameAtom,
  fwVersionAtom,
  keyStatusAtom,
  grantedAtom,
  grantedSettledAtom,
  linkStateAtom,
  linkStateFor,
  repliesAtom,
  settingsAtom,
  statusAtom,
  type LinkState,
} from '@/device/link'
import { TEST_MODE } from '@/device/testMode'
import type { Caps } from '@/device/caps'
import { logAtom } from '@/state/log'
import { registryAtom as storedRegistryAtom, type Preset, type Thermostat } from '@/state/registry'

export {
  advertsAtom,
  chipVersionAtom,
  connectedAtom,
  deviceNameAtom,
  fwVersionAtom,
  grantedAtom,
  grantedSettledAtom,
  linkStateAtom,
  logAtom,
  repliesAtom,
  statusAtom,
}
export type { LogLine } from '@/state/log'

/** The saved thermostats, derived from the one stored value — see `state/registry.ts`. */
export const registryAtom = atom<Thermostat[]>((get) => get(storedRegistryAtom).devices)

/** The saved weekly programmes, kept beside the thermostats so one can go on several. */
export const registryPresetsAtom = atom<Preset[]>((get) => get(storedRegistryAtom).presets)

/**
 * ONE THERMOSTAT'S BROADCAST, BY ITS ROW `id` — the identity everything else in this app uses.
 *
 * **The two identifiers are the whole reason this exists.** Broadcasts arrive keyed on the
 * browser's per-origin handle, which is the only thing an advert event carries; a saved row is
 * keyed on `id`, which is what survives an export, a rename and a new grant. Every view wants the
 * second and only the first is available, so the join lives here once rather than at each call
 * site — where it yields nothing when a row has no handle yet, and a different nothing when a
 * handle has no report yet.
 *
 * A thermostat that has never been heard from reads as an empty report rather than as `undefined`,
 * so no view has to guard for it.
 */
export const advertFor = atomFamily((rowId: string) =>
  atom((get) => {
    const handle = get(registryAtom).find((d) => d.id === rowId)?.deviceId
    return (handle && get(advertsAtom)[handle]) || EMPTY_REPORT
  }),
)

/**
 * ONE THERMOSTAT'S LINK, BY ITS ROW `id` — the same handle/`id` join as `advertFor` above, for the
 * same reason, because `link.ts` also keys every connection on the browser's per-origin handle.
 *
 * A row this browser has never been granted has no handle and therefore no link, which reads as
 * `disconnected` — correct, and what the row's Connect button acts on.
 */
export const linkFor = atomFamily((rowId: string) =>
  atom((get) => {
    const handle = get(registryAtom).find((d) => d.id === rowId)?.deviceId
    // In test mode a row has no handle at all and the ROW's id stands in — the same substitution
    // `activeIdAtom` makes, and it has to agree with it or a row would never look connected.
    const key = handle ?? (TEST_MODE ? rowId : null)
    return key ? get(linkStateFor(key)) : ('disconnected' as LinkState)
  }),
)

/**
 * WHICH THERMOSTAT IS OPEN and WHICH TAB IS SHOWING both live in the address bar — `state/route.ts`
 * owns the mapping and says why. They are re-exported here so every reader still has one place to
 * ask where the app is.
 */
export { sectionAtom, leaveAtom, unsavedAtom, openUnsavedAtom, type Section } from './route'
export { openIdAtom }

/** The open thermostat's row, or null. */
export const openDeviceAtom = atom((get) => {
  const id = get(openIdAtom)
  return id ? (get(registryAtom).find((d) => d.id === id) ?? null) : null
})

/** The open thermostat's broadcast. Empty rather than absent, so a view never guards for it. */
export const advertAtom = atom<AdvertReport>((get) => {
  const id = get(openIdAtom)
  return id ? get(advertFor(id)) : EMPTY_REPORT
})

/**
 * What the open thermostat can actually do, derived once so no control decides for itself.
 *
 * Read it with `useGate(need)` (`components/Gate.tsx`) rather than picking it apart — that keeps
 * "disabled, with a reason" in one place instead of in every button.
 */
export const capsAtom = atom<Caps>((get) => ({
  connected: get(connectedAtom),
  fw: get(fwVersionAtom),
  chip: get(chipVersionAtom),
  advName: get(advNameAtom),
  access: get(keyStatusAtom),
  settings: get(settingsAtom),
}))
