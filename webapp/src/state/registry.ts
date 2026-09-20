/**
 * The thermostats a person owns — the app's front door, and the only thing it persists.
 *
 * ================================================================================================
 * THREE IDENTIFIERS, AND CONFLATING THEM IS THE WHOLE TRAP
 * ================================================================================================
 * A row is keyed on `id`, which is **the serial when the thermostat reports one and its MAC
 * otherwise**. Both are real identities — the same everywhere, surviving an export, never typed in
 * because the device answers with them — but only one of them exists on every thermostat.
 *
 * **THE MAC ALONE CANNOT BE THE KEY, BECAUSE A STOCK THERMOSTAT CANNOT SAY IT** `[binary]`. The
 * command that reports it, `cmd 0x51 02` (report MAC), belongs to OUR radio firmware — so keying on
 * it means a stock device connects, answers nothing this app can file, and joins no list; and since
 * the firmware installer lives behind a row, **the app could then only upgrade a thermostat that had
 * already been upgraded**. The serial comes from `cmd 0x00` (device info), which is stock's own
 * command and answers on both, so it is the identifier every thermostat has.
 *
 * **`id` IS STICKY, and that is what makes an upgrade seamless.** `upsert` finds an existing row by
 * EITHER identifier and keeps the `id` it already had, so a thermostat added while stock — keyed by
 * serial — keeps its row, its name and its key when our firmware starts reporting a MAC as well.
 * Without that it would appear twice, and the second one would be the empty one.
 *
 * The MAC is still stored whenever it is known, because things other than identity need it: the
 * BThome nonce is built from it, and it is what a person recognises.
 *
 * `deviceId` is Chrome's `BluetoothDevice.id` and is a **per-origin reconnect handle, nothing more**
 * — opaque, scoped to the origin, and MEANINGLESS IN AN EXPORTED FILE. So it is written down beside
 * the MAC and dropped on export; an imported row picks a new one up the first time that origin is
 * granted the device. Carrying it across would produce rows that look connectable and are not.
 *
 * PER-ORIGIN ISOLATION IS ACCEPTED, NOT WORKED AROUND `[owner]`. Storage, the Bluetooth permission
 * and `deviceId` are all origin-scoped, so a registry on one address is simply not the registry on
 * another. **Import/export IS the bridge** — that is why it is a feature and not a nicety.
 *
 * ================================================================================================
 * THE EXPORT CARRIES THE KEYS AND THE PINs, DELIBERATELY `[owner]`
 * ================================================================================================
 * It is a backup, and a backup that does not restore is not one: a file without keys imports into a
 * registry that can decrypt nothing and pair with nothing. **The threat model is the neighbour** —
 * these settings exist so somebody in the next flat cannot turn the heating up — so there is no
 * warning banner, no keys-excluded variant and no second confirmation.
 *
 * ================================================================================================
 * WHY THE STORAGE IS AN INTERFACE
 * ================================================================================================
 * A hosted store is intended later, so every read and write goes through `Storage2` and components
 * never touch `localStorage` themselves. It also makes this file testable off a browser
 * (`registry.test.ts`).
 */

import { getDefaultStore } from 'jotai'
import { atomWithStorage } from 'jotai/utils'

/** One saved thermostat. Everything except `id` and `name` is optional and often absent. */
export type Thermostat = {
  /**
   * The key, and what the address bar carries. The serial when the thermostat reports one, its MAC
   * otherwise — assigned once and never changed. See the header for why it is not simply the MAC.
   */
  id: string
  /**
   * Printed order, lower case — `00:1a:22:aa:bb:cc`. **Absent on a thermostat that has not told us
   * one**, which a stock one never does: the command that reports it is ours. The BThome nonce is
   * built from it, so a row without it cannot decrypt a sealed broadcast — which costs nothing,
   * because a thermostat that cannot say its MAC cannot encrypt one either.
   */
  mac?: string
  /**
   * The 11-byte serial the thermostat prints on itself, as ASCII. **Stock answers this and so do we**
   * (`cmd 0x00`), which is what makes it the identifier every device has.
   */
  serial?: string
  /**
   * **The name the THERMOSTAT advertises — a cache of it, not an alias of ours** `[owner]`.
   *
   * There is no owner-editable alias beside it: the device's own name is settable
   * (`device/advname.ts`), and a second one would be two answers to one question — a name true in
   * this browser and nowhere else, while Home Assistant, the eQ-3 app and every other phone saw the
   * other one.
   *
   * Written from the browser's own `device.name` on every connect, and again by the Install tab's
   * name row when it sets one — the single moment the browser's copy is known to be stale. It is a
   * DISPLAY value and never an identity: `mac`/`serial` are what match a row, which is what lets two
   * thermostats be given the same name without the list losing track of either.
   */
  name: string
  /** The AES bind key, 32 hex characters, if this origin has been told it. */
  key?: string
  /** The pairing PIN, six digits, if it has been set from here. */
  pin?: string
  /**
   * Which door this app talks through — `'sealed'` for the encrypted one, `'plain'` for the one a
   * pairing opens. **Absent means "decide from whether a key is stored"**, which is what almost every
   * row wants and is why it is not written until somebody chooses `[owner]`.
   *
   * It is a CHOICE and not a consequence: the two doors both work on our firmware whatever else is
   * set, and which is preferable depends on things the app cannot see — whether the phone is already
   * bonded, whether the key is the one the device really holds, whether a mismatch is being
   * diagnosed. `channelFor` in `device/link.ts` is where the absence is resolved.
   */
  channel?: 'sealed' | 'plain'
  /** Chrome's per-origin handle. NOT identity, NOT exported — see the header. */
  deviceId?: string
  /** When a row was first stored, so a list can be shown in a stable order. */
  addedAt?: number
}

/**
 * A named weekly programme, kept so the same one can be put on several thermostats.
 *
 * It belongs to the REGISTRY rather than to a device: a preset's whole point is that it is applied
 * to more than one, and it travels in the same exported file for the same reason the keys do — a
 * backup that restores the thermostats but not their programmes is half a backup.
 *
 * The week is stored the DEVICE's way round (index 0 = Saturday), because that is the only
 * numbering the wire has; `device/schedule.ts` owns the translation to what a person sees.
 */
export type Preset = { name: string; week: { until: number; temp: number }[][] }

export type Registry = { version: 1; devices: Thermostat[]; presets: Preset[] }

/** The two calls this module needs from a store. `localStorage` satisfies it; so does a Map. */
export type Storage2 = {
  getItem(k: string): string | null
  setItem(k: string, v: string): void
}

export const STORE_KEY = 'eq3:registry'

export const EMPTY: Registry = { version: 1, devices: [], presets: [] }

/** Normalise a MAC to the one spelling the whole app compares on. */
export const normMac = (m: string) => m.trim().toLowerCase().replace(/[^0-9a-f]/g, '')
  .replace(/(..)(?=.)/g, '$1:')

/** Twelve hex digits with or without separators — what `normMac` is safe to be pointed at. */
const MAC_SHAPED = /^[0-9a-f]{2}([:-]?[0-9a-f]{2}){5}$/i

/**
 * Put an identifier in the form rows are stored and compared in.
 *
 * **A SERIAL MUST SURVIVE THIS UNTOUCHED**, which is why it tests the shape first: `normMac` strips
 * everything that is not a hex digit and then inserts colons, so run over `OEQ0000001` it would
 * produce `e0:00:00:01` — a plausible MAC-looking string that matches nothing and would key a second
 * row for a device that already had one.
 */
export const normId = (v: string) => (MAC_SHAPED.test(v.trim()) ? normMac(v) : v.trim())

/* ---- the codec: pure, so it can be tested without a browser ---------------------------------- */

/**
 * Read a registry out of whatever the store holds.
 *
 * A CORRUPT OR ABSENT VALUE YIELDS AN EMPTY REGISTRY, never a throw: this runs on the first paint of
 * the app's first screen, and a parse error there would be a blank page rather than an empty list.
 */
export function parse(raw: string | null): Registry {
  if (!raw) return EMPTY
  try {
    const v = JSON.parse(raw) as Partial<Registry>
    if (!Array.isArray(v.devices)) return EMPTY
    const devices = v.devices
      // A ROW NEEDS AN IDENTIFIER AND DOES NOT MIND WHICH. Files written before the serial existed
      // carry a MAC and no `id`, and a row keyed by MAC is still a perfectly good row — so the MAC
      // becomes its id and stays its id, which is the same stickiness `upsert` relies on.
      .filter((d): d is Thermostat => !!d && (typeof d.id === 'string' || typeof d.mac === 'string'))
      .map((d) => ({
        ...d,
        id: normId(d.id ?? d.mac!),
        ...(d.mac ? { mac: normMac(d.mac) } : {}),
        name: d.name || 'Thermostat',
      }))
    // Presets arrived after the first files were written, so a file without them is not corrupt.
    const presets = (Array.isArray(v.presets) ? v.presets : []).filter(
      (p): p is Preset => !!p && typeof p.name === 'string' && Array.isArray(p.week),
    )
    return { version: 1, devices, presets }
  } catch {
    return EMPTY
  }
}

/** The file a person downloads. `deviceId` is stripped — the header says why. */
export function toExport(r: Registry): string {
  const devices = r.devices.map(({ deviceId: _drop, ...rest }) => rest)
  return JSON.stringify({ version: 1, devices, presets: r.presets }, null, 2)
}

/**
 * Merge an exported file into what is already here, keyed on `id`.
 *
 * AN IMPORT NEVER DROPS A LOCAL `deviceId`, because the file has none and losing one would turn a
 * connectable row into a row that needs the chooser again. Everything else in the file wins: an
 * import is a restore, and a restore that keeps stale local values is not one.
 *
 * **Matching is by `id` alone, unlike `upsert`.** Both sides here are rows rather than a report from
 * a device, and a row's `id` is the identifier it was given when it was first met — so two files
 * describing one thermostat agree on it, and the serial/MAC cross-match `upsert` needs in order to
 * recognise an upgraded device has nothing to do here.
 */
export function merge(current: Registry, incoming: string): Registry {
  const add = parse(incoming)
  if (add.devices.length === 0) throw new Error('no thermostats in that file')
  const by = new Map(current.devices.map((d) => [d.id, d]))
  for (const d of add.devices) {
    const had = by.get(d.id)
    by.set(d.id, { ...had, ...d, deviceId: had?.deviceId })
  }
  // Presets merge by NAME, the only identity they have; the file wins, as it does for a device.
  const presets = new Map(current.presets.map((p) => [p.name, p]))
  for (const p of add.presets) presets.set(p.name, p)
  return { version: 1, devices: [...by.values()], presets: [...presets.values()] }
}

/* ---- the live store: ONE atom -------------------------------------------------------------- */

/**
 * A store that works when `localStorage` does not.
 *
 * Safari's private mode and a blocked third-party context both throw on ACCESS, not just on write,
 * so this is a try/catch rather than a feature test. Falling back to memory means the app runs and
 * simply forgets, which is a far better failure than a blank screen. It is also what makes this
 * file loadable under `bun test`, which has no `localStorage` at all.
 */
function browserStore(): Storage2 {
  try {
    const ls = globalThis.localStorage
    ls.getItem(STORE_KEY)
    return ls
  } catch {
    const mem = new Map<string, string>()
    return {
      getItem: (k) => mem.get(k) ?? null,
      setItem: (k, v) => void mem.set(k, v),
    }
  }
}

const backing = browserStore()

/**
 * THE REGISTRY IS AN ATOM, and there is nothing else `[owner]`. `atomWithStorage` is persistence
 * and reactivity in one value — read by components with `useAtomValue`, by everything else through
 * `registry` below, and stored in neither place twice.
 *
 * **Reads go through `parse`** for the reason stated there. `getOnInit` because the first paint
 * must show what is stored, not the default.
 */
export const registryAtom = atomWithStorage<Registry>(
  STORE_KEY,
  EMPTY,
  {
    getItem: (k) => parse(backing.getItem(k)),
    setItem: (k, v) => backing.setItem(k, JSON.stringify(v)),
    // Nothing removes the registry — forgetting the last thermostat leaves an empty one — but the
    // interface asks for it, and writing the empty value is what "removed" means here.
    removeItem: (k) => backing.setItem(k, JSON.stringify(EMPTY)),
  },
  { getOnInit: true },
)

/**
 * The registry for everything that is not a React component — the advert decoder, the link, the
 * forms — reading and writing the same atom through Jotai's default store. No second copy and no
 * subscription: a component reading `registryAtom` re-renders when one of these writes.
 */
const jotai = getDefaultStore()
const state = () => jotai.get(registryAtom)
const commit = (next: Registry) => jotai.set(registryAtom, next)

export const registry = {
  all: state,
  list: () => state().devices,
  get: (id: string) => state().devices.find((d) => d.id === normId(id)) ?? null,
  /** The lookup the advert layer does on every broadcast, so it stays cheap and total. */
  byDeviceId: (id: string) => state().devices.find((d) => d.deviceId === id) ?? null,

  /**
   * The row for a thermostat that has just said who it is — matched on EITHER identifier.
   *
   * It is `upsert`'s own matching, exposed, because a caller that is about to upsert usually needs
   * to read the row first: whether a key is already stored decides whether an offered one is used,
   * and whether the name is the owner's or the advertised default. Doing that with `get` would mean
   * guessing which identifier the row was keyed by, which is the guess this pair exists to remove.
   */
  match: ({ mac, serial }: { mac?: string | null; serial?: string | null }) => {
    const m = mac ? normMac(mac) : null
    const s = serial?.trim() || null
    return state().devices.find((d) => (!!s && d.serial === s) || (!!m && d.mac === m)) ?? null
  },

  /**
   * Merge a patch into a row, or file a new one. Matched on EITHER identifier, and the `id` never
   * moves — see the header for why an upgraded thermostat must not get a second row.
   *
   * **PASS ONLY WHAT YOU ARE CHANGING.** Every field is optional except an identifier, so a caller
   * that spreads a whole row it is holding — `{ ...device, key }` — republishes every OTHER field
   * from whatever it captured, and reverts anything written in between. The name is the field that
   * bites, because it has exactly one writer (`noteAdvName`) and a key change made from a stale
   * closure would silently undo it.
   */
  upsert(patch: Partial<Omit<Thermostat, 'id'>> & { id?: string }) {
    const s = state()
    const mac = patch.mac ? normMac(patch.mac) : undefined
    const serial = patch.serial?.trim() || undefined
    const had = s.devices.find(
      (d) =>
        (patch.id && d.id === normId(patch.id)) ||
        (!!serial && d.serial === serial) ||
        (!!mac && d.mac === mac),
    )
    // NEW ROWS PREFER THE SERIAL, because it is the identifier BOTH firmwares report — so a row
    // filed today survives the thermostat being upgraded or reverted. An existing row keeps whatever
    // it was first given, whether or not that is what a new row would pick.
    const id = had?.id ?? normId(patch.id ?? serial ?? mac ?? '')
    if (!id) throw new Error('a thermostat row needs a serial, a MAC or an explicit id')
    const row: Thermostat = {
      addedAt: had?.addedAt ?? Date.now(),
      ...had,
      ...patch,
      id,
      ...(mac ? { mac } : {}),
      ...(serial ? { serial } : {}),
      name: patch.name || had?.name || 'Thermostat',
    }
    commit({
      ...s,
      devices: had ? s.devices.map((d) => (d.id === id ? row : d)) : [...s.devices, row],
    })
    return row
  },

  forget(id: string) {
    const s = state()
    const k = normId(id)
    commit({ ...s, devices: s.devices.filter((d) => d.id !== k) })
  },

  /* ---- presets: a programme, kept so it can go on several thermostats ---- */

  presets: () => state().presets,

  savePreset(name: string, week: Preset['week']) {
    const s = state()
    const had = s.presets.some((p) => p.name === name)
    commit({
      ...s,
      presets: had
        ? s.presets.map((p) => (p.name === name ? { name, week } : p))
        : [...s.presets, { name, week }],
    })
  },

  deletePreset(name: string) {
    const s = state()
    commit({ ...s, presets: s.presets.filter((p) => p.name !== name) })
  },

  exportJson: () => toExport(state()),

  /** Returns how many rows the file held, or throws with something a person can read. */
  importJson(text: string) {
    const next = merge(state(), text)
    commit(next)
    return next.devices.length
  },
}
