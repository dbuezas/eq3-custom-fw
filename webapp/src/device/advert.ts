/**
 * The devices' BThome broadcasts, read with NO CONNECTION AT ALL.
 *
 * This is the half of the app that works when the link does not: a thermostat airs its state roughly
 * once a second whether or not anybody is connected, so live values need no GATT, no pairing and
 * none of `link.ts`'s queue. It is what the front-door list is made of — every saved thermostat's
 * current readings, none of them connected.
 *
 * **IT IS PER DEVICE, and that is not an optimisation.** The app's first screen shows every saved
 * thermostat at once, so one watched device, one accumulated pair of object sets and one counter at
 * module scope would let the second row overwrite the first's readings and neither would be wrong
 * enough to look broken. Everything below is therefore keyed on `BluetoothDevice.id`.
 *
 * ================================================================================================
 * FOUR TRAPS, EVERY ONE A SILENT FAILURE
 * ================================================================================================
 * 1. `0xFCD2` must be in `requestDevice`'s `optionalServices` or the service data arrives as an
 *    EMPTY MAP with no error at all — the browser filters service data by per-device permission.
 * 2. Delivery is torn down when the tab is hidden, occluded or MERELY UNFOCUSED, while
 *    `watchingAdvertisements` still reports true and re-calling is a no-op. It needs an
 *    `AbortController` and a re-arm that aborts BEFORE re-subscribing — **for every watched device,
 *    since one blur stops all of them at once**.
 * 3. Service data cannot be filtered on, and a BThome advert carries no Service UUIDs AD type, so
 *    the device must be matched by NAME — never `filters: [{ services: [0xfcd2] }]`.
 * 4. macOS delivers nothing unless Chrome has Bluetooth in Privacy & Security.
 *
 * AND IT IS FLAG-ONLY EVERYWHERE. `watchAdvertisements()` is experimental in Blink and Chrome marked
 * it "No longer pursuing" in 2023 `[external]`. So this is an enthusiast path: feature-detect and SAY
 * WHAT TO ENABLE rather than failing silently — `ENABLE_HINT` is that sentence.
 *
 * **How many devices one browser can watch before delivery degrades is NOT established.** It is
 * per-device by construction and nothing here serialises, but it has not been measured past one.
 */
import {
  decodeObjects,
  decryptAdvert,
  isEncrypted,
  macBytes,
  unhex,
  type BthomeValue,
} from './bthome.js'
import { atom, getDefaultStore } from 'jotai'

import type { Hint } from '@/components/HintCard'
import { registry } from '@/state/registry'
import { BTHOME_SVC } from './protocol'

export type AdvertReport = {
  /** Merged values across BOTH object sets — see `sets` for why merging is required. */
  values: Record<string, BthomeValue>
  /**
   * WHEN EACH OF THOSE VALUES LAST ARRIVED, which is not `lastAt` and must not be confused with it.
   * The two sets alternate, so half of `values` is always up to a couple of seconds old while a
   * broadcast has only just landed. A reader that dates every value by `lastAt` therefore believes
   * the stale half is newer than a status reply that just corrected it — and shows the value the
   * device has already moved off. Measured as a flicker on a target set from this app: the number
   * goes back to the old one for about a second, until the set carrying it comes round.
   */
  valuesAt: Record<string, number>
  /** How many of the two alternating object sets have been seen since the last reset. */
  setsSeen: number
  /** Broadcasts received since the watch started. */
  count: number
  /**
   * How many times the silence watchdog has restarted this device's subscription — see
   * `installReArm`. A number that keeps climbing is the platform dropping the scan over and over,
   * which is a fact about the browser and worth being able to read off the screen.
   */
  rearms: number
  /**
   * HOW MANY OF EACH OBJECT SET HAVE LANDED, keyed by the set's first value name.
   *
   * `setsSeen` says whether both halves have EVER arrived; this says how the traffic divides. They
   * answer different questions and the second one only matters on a platform that is losing
   * broadcasts: a total that looks healthy can still be one half arriving and the other never, in
   * which case half the readings on screen are as old as the page.
   *
   * Keyed by the first value name — `temperature`, `window`, `packet_id` — rather than by the
   * object-id signature that keys `sets`, because this one is read by a person. It is the decoder's
   * own wire name, not a label invented here, so it cannot say something the payload does not.
   */
  setCounts: Record<string, number>
  rssi: number | null
  /** The rolling counter from an encrypted advert; null when the advert is plain. */
  counter: number | null
  /** Present when the payload arrived but could not be read. NEVER means "not advertising". */
  problem: string | null
  /**
   * The last payload was SEALED. It is a fact about the thermostat, not about us, and it is what
   * separates the two things a missing key can mean: with a plain broadcast, having no key is
   * simply how most thermostats are; with a sealed one, it is why nothing can be read.
   */
  encrypted: boolean
  /** The advert is sealed and this origin cannot open it — no key stored, or the wrong one. */
  needsKey: boolean
  /**
   * When the last broadcast arrived, or null if none has. A ROW IS NOT "OFFLINE", IT IS STALE —
   * out of range and switched off look identical from here, so the list shows an age and lets a
   * person draw their own conclusion.
   */
  lastAt: number | null
  /**
   * THE LAST BROADCAST CARRIED SENSOR DATA. False means the thermostat was heard and said nothing —
   * which is a real state, not a gap: switching the broadcast off in settings page 6 leaves the
   * device advertising a plain connectable advert with no `0xFCD2` in it at all.
   *
   * **It is why the readings are cleared rather than left up.** Values kept from before the switch
   * would go on being drawn as current for as long as it stays off, and a temperature that is
   * merely old is indistinguishable from one that is right — the same failure the firmware side of
   * this had (`ble_chip/mod/bthome.S`, `.Le_quiet`).
   *
   * It cannot separate "switched off" from trap 1, a device this origin never got `0xFCD2`
   * permission for, and it does not try: with `count` broadcasts heard and this false, the honest
   * statement is that no sensor data is arriving.
   */
  sensorData: boolean
}

export const EMPTY_REPORT: AdvertReport = {
  values: {},
  valuesAt: {},
  setsSeen: 0,
  count: 0,
  rearms: 0,
  setCounts: {},
  rssi: null,
  counter: null,
  problem: null,
  encrypted: false,
  needsKey: false,
  lastAt: null,
  sensorData: false,
}

/** Every watched device's latest report, keyed by `BluetoothDevice.id`. */
export type AdvertReports = Record<string, AdvertReport>

/**
 * THE REPORTS ARE AN ATOM, WRITTEN FROM HERE — this module owns the value and publishes it, with no
 * subscribe and no copy in between. Views should not read it directly: it is keyed by browser handle,
 * and `state/atoms.ts`'s `advertFor(rowId)` joins it to a saved thermostat, which is the identity
 * every view actually has.
 */
export const advertsAtom = atom<AdvertReports>({})

/**
 * THE TWO OBJECT SETS ALTERNATE ON EVERY ADVERTISING EVENT, so they are accumulated by their id
 * signature rather than replaced. A view that renders the first one it sees shows half its fields
 * empty and looks broken; the device is fine and the other half arrives a second later.
 */
type Watch = {
  device: BluetoothDevice
  abort: AbortController | null
  sets: Record<string, Record<string, BthomeValue>>
  /** How many of each half have landed. See `AdvertReport.setCounts`. */
  setCounts: Record<string, number>
  /** Per-value arrival times, stamped as each set lands. See `AdvertReport.valuesAt`. */
  valuesAt: Record<string, number>
  report: AdvertReport
  /** Why the last subscribe attempt failed, or null when it took. See `isWatched`. */
  refused: string | null
  /**
   * The subscribe that is being ESTABLISHED right now, if one is. `watch` joins it instead of
   * starting a second — see there for what starting a second one does.
   */
  pending: Promise<string | null> | null
}

const watches = new Map<string, Watch>()
function publish() {
  getDefaultStore().set(
    advertsAtom,
    Object.fromEntries([...watches].map(([id, w]) => [id, w.report])),
  )
}

function emit(w: Watch, patch: Partial<AdvertReport>) {
  w.report = {
    ...w.report,
    ...patch,
    values: Object.assign({}, ...Object.values(w.sets)) as Record<string, BthomeValue>,
    valuesAt: { ...w.valuesAt },
    setsSeen: Object.keys(w.sets).length,
  }
  publish()
}

/** The current report for one device, so a caller never has to cope with a missing key. */
export function reportFor(id: string | null | undefined): AdvertReport {
  return (id && getDefaultStore().get(advertsAtom)[id]) || EMPTY_REPORT
}

/**
 * Forget what a device has said, so the next broadcast rebuilds it.
 *
 * Called when its key changes: the accumulated sets were decoded with the OLD key (or not at all),
 * and keeping them would show stale values beside fresh ones with nothing marking which is which.
 */
export function resetDevice(id: string) {
  const w = watches.get(id)
  if (!w) return
  w.sets = {}
  w.setCounts = {}
  w.valuesAt = {}
  // `count` and `rearms` SURVIVE, because neither is a reading. They are the running record of what
  // this browser has managed to receive, and the whole point of resetting is to clear what the
  // DEVICE said without losing the evidence of how well it is being heard.
  emit(w, { ...EMPTY_REPORT, count: w.report.count, rearms: w.report.rearms })
}

/* ---- the watch ------------------------------------------------------------------------------ */

async function onAdvertisement(e: Event) {
  const ev = e as BluetoothAdvertisingEvent
  const w = watches.get(ev.device.id)
  if (!w) return
  const p = ev.serviceData?.get(BluetoothUUID.getService(BTHOME_SVC))
  if (!p) {
    // AN ADVERT WITH NO BTHOME DATA IS NEWS, NOT A NON-EVENT: the thermostat IS being heard, so
    // count it, date it, and DROP the readings rather than returning — `sensorData` says why keeping
    // them is worse than showing a placeholder, and why trap 1 arrives here too.
    w.sets = {}
    w.valuesAt = {}
    emit(w, {
      count: w.report.count + 1,
      lastAt: Date.now(),
      rssi: ev.rssi ?? null,
      sensorData: false,
      counter: null,
      problem: null,
      needsKey: false,
    })
    return
  }
  const payload = new Uint8Array(p.buffer)
  w.report = { ...w.report, count: w.report.count + 1, lastAt: Date.now() }
  // OUTSIDE THE `try`, because the catch below needs it: whether the payload was sealed is what
  // tells a wrong key from a corrupted advert, and it is known from the first byte alone.
  const sealed = isEncrypted(payload)

  try {
    let plain: Uint8Array
    let counter: number | null = null
    if (sealed) {
      // THE KEY COMES FROM THE REGISTRY, keyed on this origin's handle for the device. A row that
      // has never been connected has no handle yet, so this is legitimately null — that is a
      // thermostat waiting for its first grant, not a fault.
      const row = registry.byDeviceId(ev.device.id)
      // **THE MAC IS PART OF THE NONCE, so a row without one cannot open this** — and a row without
      // one is a thermostat that never reported it, which takes our radio firmware. So this is the
      // same "waiting" state as a missing key rather than a new kind of failure: the broadcast is
      // sealed, this browser cannot read it, and saying so is all there is to do.
      if (!row?.key || !row.mac) {
        emit(w, { encrypted: true, needsKey: true, rssi: ev.rssi ?? null, sensorData: true })
        return
      }
      const r = await decryptAdvert(unhex(row.key), macBytes(row.mac), payload)
      plain = r.objects
      counter = r.counter
    } else {
      plain = payload.slice(1)
    }
    const dec = decodeObjects(plain)
    w.sets[dec.list.map((o) => o.id).join(',')] = dec.values
    // Only the keys THIS set carried are fresh; the other set's are as old as they were.
    const now = Date.now()
    for (const k of Object.keys(dec.values)) w.valuesAt[k] = now
    // Tally this half. `list` rather than `values`, because it is in WIRE order and the first
    // entry is therefore the set's own identity — `values` is an object and its key order is not
    // something to lean on.
    const half = dec.list[0]?.name
    if (half) w.setCounts[half] = (w.setCounts[half] ?? 0) + 1
    emit(w, {
      rssi: ev.rssi ?? null,
      counter,
      problem: null,
      encrypted: sealed,
      needsKey: false,
      sensorData: true,
      setCounts: { ...w.setCounts },
    })
  } catch (err) {
    // A TAG MISMATCH IS NOT "NOT ADVERTISING". Wrong key, wrong MAC and a corrupted advert are
    // indistinguishable here, and reporting it as silence is the most expensive wrong conclusion
    // this project has drawn. The payload demonstrably ARRIVED, or there would be nothing to check.
    emit(w, {
      problem: err instanceof Error ? err.message : String(err),
      encrypted: sealed,
      needsKey: true,
      rssi: ev.rssi ?? null,
      sensorData: true,
    })
  }
}

/**
 * `BluetoothDevice` is a TYPE here, not a value — `@types/web-bluetooth` declares the interface and
 * no global constructor, so it cannot be named at runtime. Reach it off `globalThis` instead, which
 * also copes with the browsers that have no such global at all (which is the case being detected).
 */
const BD = (globalThis as { BluetoothDevice?: { prototype?: object } }).BluetoothDevice
export const SUPPORTED = !!BD?.prototype && 'watchAdvertisements' in BD.prototype

/**
 * Two parts, because the card that shows this shows only the first by default —
 * `components/HintCard.tsx` says why.
 */
export const ENABLE_HINT: Hint = {
  short:
    'Readings need one Chrome flag: turn on ' +
    'chrome://flags/#enable-experimental-web-platform-features and relaunch.',
  more:
    'It adds watchAdvertisements(), which is what lets a row show what a thermostat is ' +
    'broadcasting with nothing connected to it. There is no origin trial, so the flag is the ' +
    'only way, and Linux and ChromeOS have no implementation at all.',
}

/**
 * Start (or re-arm) the advert watch for one device. Safe to call repeatedly — that is trap 2.
 *
 * ================================================================================================
 * A CALL THAT ARRIVES WHILE ONE IS STILL ESTABLISHING **JOINS IT** — it does not abort it
 * ================================================================================================
 * Re-arming means aborting and subscribing again, which is right for a subscription that is UP and
 * has gone quiet, and destructive for one that has not started yet: the abort rejects the pending
 * `watchAdvertisements`, whose own catch then writes `refused` over the newer attempt's success, so
 * the app believes it is not watching a device it is watching — or, worse, the second subscribe is
 * refused because the first is still live and the abort has already killed it, leaving the device
 * **watching nothing at all**.
 *
 * That is not hypothetical and it is reachable from a page load `[owner]` `[manually verified]`.
 * Boot subscribes to every granted device; the re-arm on `focus`/`visibilitychange` fires shortly
 * after, while those are still in flight. The symptom: a thermostat that could not be connected to,
 * a Connect button that did nothing, and a list that stopped showing new broadcasts — all from one
 * page load, cured only by reloading, because a reload is what builds the map again.
 *
 * The rule is one runner per device. Joining is also the RIGHT answer rather than merely a safe one:
 * what the caller wants is a live subscription, and one is already on its way.
 */
export async function watch(d: BluetoothDevice): Promise<string | null> {
  if (!d.watchAdvertisements) return ENABLE_HINT.short
  const w = watches.get(d.id) ?? {
    device: d,
    abort: null,
    sets: {},
    setCounts: {},
    valuesAt: {},
    report: { ...EMPTY_REPORT },
    refused: null,
    pending: null,
  }
  watches.set(d.id, w)
  publish()
  if (w.pending) return w.pending

  const run = (async () => {
    try {
      w.abort?.abort() // trap 2: ALWAYS abort before re-subscribing, or the re-arm is a no-op
      w.abort = new AbortController()
      d.removeEventListener('advertisementreceived', onAdvertisement)
      d.addEventListener('advertisementreceived', onAdvertisement)
      await d.watchAdvertisements({ signal: w.abort.signal })
      w.refused = null
      return null
    } catch (e) {
      // THE ENTRY STAYS — it carries the row's counters and its last readings, and dropping it would
      // blank a row that has been receiving perfectly until now. `refused` is what stops the entry
      // being mistaken for a live subscription, so a failed attempt is tried again.
      w.refused =
        (e instanceof Error ? e.message : String(e)) +
        ' — on macOS also check Chrome has Bluetooth in Privacy & Security'
      return w.refused
    }
  })()
  w.pending = run
  // Cleared however it ends, so a device whose subscribe FAILED can be retried rather than looking
  // busy for the rest of the session.
  void run.finally(() => {
    if (w.pending === run) w.pending = null
  })
  return run
}

/**
 * Whether a device has a watch that actually took. `link.ts`'s `refreshGranted()` asks so that it
 * only ever starts watches for devices that have none — see `watch` for what two callers re-arming
 * one device at the same moment can do to it. Re-arming what already exists belongs to
 * `installReArm` and to nothing else.
 *
 * IT IS NOT "HAS AN ENTRY". The entry is created before the subscribe is attempted, so a refused
 * one would otherwise look watched for the rest of the session and never be retried.
 */
export const isWatched = (id: string) => watches.get(id)?.refused === null

/**
 * Has an advertisement from this device been HEARD in this page's lifetime?
 *
 * **THIS IS WHAT MAKES A SAVED DEVICE CONNECTABLE, and it is not obvious** `[manually verified]`. A
 * `BluetoothDevice` from `getDevices()` is a permission, not a radio address: until the platform has
 * actually heard the thing, `gatt.connect()` fails with **"Bluetooth Device is no longer in range"**
 * — a message that reads as the thermostat being absent when it is sitting on the radiator airing
 * once a second. Watching for advertisements and waiting for one is the documented way to reconnect
 * to a device you already have permission for.
 *
 * It explains a whole class of symptom: tapping a thermostat immediately after a page load failed and
 * kept failing, while waiting a moment on the list first worked, and reloading the failing page
 * worked. All three are the same fact — whether an advert had landed yet — and none of them is about
 * the permission, the retry count or the thermostat.
 *
 * Any advert counts, including one carrying no BThome data: being heard is the whole question, and a
 * stock thermostat airs nothing else.
 */
export const heard = (id: string) => watches.get(id)?.report.lastAt != null

/** Stop watching one device, or every device when called with nothing. */
export function stopWatch(id?: string) {
  for (const [key, w] of watches) {
    if (id && key !== id) continue
    w.abort?.abort()
    watches.delete(key)
  }
  publish()
}

/**
 * Trap 2's other half: re-arm EVERY watched device on the way back, because one blur stops all of
 * them and the page just goes quiet.
 *
 * **IT IS THE ONLY LISTENER ON THOSE TWO EVENTS, deliberately.** `before` is where anything else
 * that wants to run on the way back goes — the app also re-asks which devices it has been granted
 * there. A second `focus` listener calling `watch()` would race this loop over the same
 * `AbortController` and could leave a device subscribed to nothing at all.
 */
export function installReArm(before?: () => void) {
  const rearm = () => {
    if (document.hidden) return
    before?.()
    for (const w of watches.values()) void watch(w.device)
  }
  addEventListener('visibilitychange', rearm)
  addEventListener('focus', rearm)
  const stopWatchdog = installSilenceWatchdog()
  return () => {
    removeEventListener('visibilitychange', rearm)
    removeEventListener('focus', rearm)
    stopWatchdog()
  }
}

/**
 * A device that has gone quiet is RE-SUBSCRIBED — because on macOS the platform keeps ending the
 * scan by itself.
 *
 * **WHAT THIS IS FOR** `[manually verified]`. On a MacBook, Chrome's own `chrome://bluetooth-internals`
 * shows discovery switching itself off over and over. Each fresh subscription therefore delivers a
 * broadcast or two and then nothing, which is exactly what the page saw: one on load, one on
 * connect, one or two per manual re-arm. It is not the thermostat, which airs once a second
 * throughout, and it is not Apple coalescing duplicates — Chromium asks for every packet
 * (`CBCentralManagerScanOptionAllowDuplicatesKey: YES`). The scan simply stops. Android never does
 * this, which is why it alone was unaffected.
 *
 * **Silence is the only signal available.** There is no event for "the platform dropped your scan":
 * `watchAdvertisements` resolves once and says nothing afterwards, so the absence of broadcasts is
 * the sole evidence that anything is wrong. Hence a timer rather than a listener.
 *
 * **It re-arms only a device that HAS been heard.** One that has never said anything may simply be
 * out of range or switched off, and hammering the platform on its behalf would buy nothing and cost
 * power. The first broadcast is what proves there is a stream to lose.
 *
 * `QUIET_MS` is well clear of a few dropped adverts at one per second, so an ordinary gap does not
 * trigger it; `MIN_GAP_MS` then stops a device that cannot be revived from being re-armed in a loop.
 * Both are deliberately un-clever: a backoff that grows would take longer and longer to recover a
 * link that is dropping every few seconds, which is the case this exists for.
 *
 * It shares `watch()` with the re-arm above rather than touching `AbortController`s itself, so
 * there is still exactly one thing that re-subscribes — see this function's own header for why a
 * second one is dangerous.
 */
export const QUIET_MS = 4000
export const MIN_GAP_MS = 3000

/**
 * The whole decision, as a function of four numbers — so it can be tested without a timer, a DOM or
 * a radio. The loop below is then only plumbing.
 *
 * `heardAt` null means never heard; `lastTry` 0 means never re-armed.
 */
export function shouldRearm(heardAt: number | null, lastTry: number, now: number): boolean {
  if (heardAt == null) return false // never heard: out of range or off, not a stream we lost
  if (now - heardAt < QUIET_MS) return false // an ordinary dropped advert, not a dead scan
  return now - lastTry >= MIN_GAP_MS // and do not loop on one that will not come back
}

function installSilenceWatchdog() {
  const lastTry = new Map<string, number>()
  const tick = () => {
    if (document.hidden) return // delivery is torn down anyway; re-arming into a hidden tab is waste
    const now = Date.now()
    for (const [id, w] of watches) {
      if (!shouldRearm(w.report.lastAt, lastTry.get(id) ?? 0, now)) continue
      lastTry.set(id, now)
      emit(w, { rearms: w.report.rearms + 1 })
      void watch(w.device)
    }
  }
  const t = setInterval(tick, 1000)
  return () => clearInterval(t)
}
