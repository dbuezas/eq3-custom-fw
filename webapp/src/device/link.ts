/**
 * THE ONLY PLACE THIS APP TOUCHES THE DEVICE. Everything else asks `request()`.
 *
 * ================================================================================================
 * W6 — EXACTLY ONE WRITE IN FLIGHT, EVER
 * ================================================================================================
 * PIPELINING GATT WRITES CRASHES THE BLE CHIP IN ABOUT THIRTY SECONDS `[manually verified]`. Firing
 * commands without waiting for the previous reply faults it after 6–12; the identical commands
 * awaited one at a time ran 62 000 round trips with none. The defect is in stock Broadcom code on
 * the ACL transmit release path and cannot be patched, so this is a permanent constraint on the
 * CLIENT, not a bug someone will fix underneath us. See `ble_chip/PLAN.md`.
 *
 * AWAITING EACH CALL IS NOT ENOUGH, WHICH IS WHY THIS IS A QUEUE AND NOT A CONVENTION. The page this
 * replaces awaited every request it made and still overlapped two: a poll timer firing every 1200 ms
 * while a retrying request ran up to 4 × 1500 ms, with a button click landing inside either. Three
 * independent producers, one characteristic. A depth-one queue at the single point of contact is the
 * whole fix, and — unlike a rule — it cannot be got wrong by a caller who has not read this comment.
 *
 * AND REACT MAKES THAT EASIER TO GET WRONG, NOT HARDER. Two components mounting at once, an effect
 * that refetches on a dependency change, a Jotai async atom read from three places: each is a
 * producer, none of them knows about the others, and none of them is doing anything unusual. The
 * module keeps the characteristic PRIVATE — it is never exported, in any shape — so a component
 * cannot reach `writeValue` even by accident. That is the enforcement; the comment is only the
 * reason.
 */
import { atom, getDefaultStore } from 'jotai'
// `jotai-family`, not `jotai/utils`: the built-in atomFamily is deprecated and goes in Jotai 3, and
// it says so on every test run.
import { atomFamily } from 'jotai-family'

import type { Hint } from '@/components/HintCard'
import { log } from '@/state/log'
import { registry, registryAtom as storedRegistryAtom, type Thermostat } from '@/state/registry'
import { openIdAtom, unsavedAtom } from '@/state/route'
import { decodeKeyStatus, type KeyStatus } from './access'
import {
  decodeAdvInterval,
  decodeSettings,
  isAdvInterval,
  isSettings,
  readAdvInterval,
  readSettings,
  type Settings as DeviceSettings,
} from './config'
import { SUPPORTED as ADVERTS_SUPPORTED, heard, isWatched, resetDevice, watch } from './advert'
import {
  ADV_NAME_PREFIX,
  ADV_NAME_STOCK,
  aired,
  decodeAdvName,
  readAdvName,
  type AdvName,
} from './advname'
import { unhex } from './bthome'
import {
  ENV_MAXIN,
  MAGIC_ENC,
  MAGIC_ENC_FRAG,
  NONCE_LEN,
  NONCE_REQUEST,
  PLAINTEXT_IDS,
  openReply,
  reassembler,
  sealCommand,
  stageCommand,
} from './sealed'
import { isPanel, panelBytes } from './panel'
import { decodeStatus, isStatus, setDateTime, type Status } from './status'
import { TEST_DEVICE, TEST_MODE, testReply } from './testMode'
import {
  ENTER_OTA,
  OTA_CHUNK,
  OTA_START,
  WS_STATUS,
  chunkPackets,
  chunkVerdict,
  crc32Wiced,
  isOtaMode,
  otaPrepare,
  otaVerify,
  parseChunks,
} from './flash'
import {
  APP_INFO_CH,
  BTHOME_SVC,
  CMD_CH,
  ENC_N,
  ENC_W,
  GET_INFO,
  OTA_CONTROL_CH,
  OTA_DATA_CH,
  KEY_STATUS,
  NOTIFY_CH,
  OTA_SVC,
  SVC,
  isInfo,
  serialOf,
  isAdvName,
  isKeyStatus,
  chipText,
  fwText,
  parseAppInfo,
  type ChipVersion,
  type Match,
  type Reply,
} from './protocol'

/** How long one attempt waits for its reply before trying again. */
const REPLY_TIMEOUT_MS = 1500
/** Attempts per request. The device drops the occasional frame; the link itself is solid. */
const DEFAULT_TRIES = 4
/**
 * How long a retry waits before asking again — and it waits with the queue RELEASED, so this is
 * also the window in which anything else gets its turn. See `retrying`.
 */
const RETRY_GAP_MS = 300
/**
 * Consecutive sealed refusals before the app says the stored key is wrong. Three, because a key that
 * really is wrong is refused on every attempt — so `request`'s four passes reach this inside one
 * command — while a single refusal is not evidence of anything.
 */
const KEY_REFUSALS_BEFORE_BLAMING = 3

type Waiter = { match: Match; resolve: (b: Reply | null) => void }

/* ================================================================================================
 * W30 — ONE `Link` PER THERMOSTAT, AND NOTHING ABOUT A CONNECTION LIVES OUTSIDE ONE
 * ================================================================================================
 * `links` holds one per device handle — which is what lets a person connect to two radiators and
 * leave both up while walking between them.
 *
 * **THE OBJECT IS THE GENERATION.** A fresh connection is a fresh `Link`, so holding the object IS
 * holding the link it belongs to: a retry loop still pausing when the device drops finds `dead` set
 * and stops, instead of waking up against a new connection and asking it the previous one's
 * question. `dead` is set once, by `tearDown`, which is the one place a link ends.
 *
 * **NOTHING HERE IS EXPORTED, IN ANY SHAPE, AND THAT IS THE `W6` ENFORCEMENT** (see the header). A
 * component cannot reach a characteristic even by accident, because there is no way out of this
 * module that carries one.
 */
type Link = {
  /** The browser's handle. It is also this link's key in `links` and in every atom family below. */
  readonly id: string
  readonly device: BluetoothDevice
  /** Set once, by `tearDown`. Everything that outlives one round trip re-checks it. */
  dead: boolean
  cmdCh: BluetoothRemoteGATTCharacteristic | null
  waiters: Waiter[]
  /** The write queue — one per link, because it orders operations on ONE connection. */
  queue: Promise<unknown>
  /* ---- W22: the sealed door, and the per-connection state that rides on it ---------------------
   * All of it dies with the link, and it must: the device restarts its reply counter at every
   * connection, so a value carried across would read as an enormous gap and drop a good reply.
   */
  /** The sealed write characteristic, when this radio image has one. Null means: plaintext only. */
  encCh: BluetoothRemoteGATTCharacteristic | null
  /**
   * The sealed NOTIFY characteristic, kept only so this link's listener can be taken off it.
   *
   * **ONE DEVICE OBJECT OUTLIVES MANY CONNECTIONS, and so does its characteristic object.** Each
   * link binds its own `onNotify` closure, so without this a reconnect to the same thermostat left
   * the previous link's listener attached — and every frame was then delivered to a dead link as
   * well as to the live one.
   */
  encNotify: BluetoothRemoteGATTCharacteristic | null
  /** The radio's OTA pair, for installing firmware. Null on a radio whose service this app cannot find. */
  otaCtl: BluetoothRemoteGATTCharacteristic | null
  otaData: BluetoothRemoteGATTCharacteristic | null
  /** The legacy notify, kept so its subscription can be retried once somebody has paired. */
  notifyCh: BluetoothRemoteGATTCharacteristic | null
  /** This thermostat's AES key, from the row found by the browser's handle — see `armSealing`. */
  sealKey: Uint8Array | null
  /**
   * The key a reply is expected to be sealed under, when that is NOT the key it was sent under.
   *
   * **AN APPLY CHANGES THE KEY ITS OWN REPLY IS SEALED UNDER**, which is the one asymmetry on this
   * door `[binary]`: the radio builds the key report AFTER the new key is live, so the command goes
   * out under the old key and the answer comes back under the new one. Without this the report
   * simply fails to open and a perfectly good key change reads as "no reply" — losing the only thing
   * that says whether the key actually landed in the store.
   *
   * Null the rest of the time, which is nearly always. `set_bindkey.py`'s `Encrypted` door holds the
   * same field for the same reason and is where this came from.
   */
  replyKey: Uint8Array | null
  /** The session nonce the device answered `0x56` with. Null until primed, and priming may fail. */
  session: Uint8Array | null
  /** Our own downlink counter. Starts at 0 with each new session nonce. */
  seq: number
  /** Puts a fragmented reply back together and refuses one whose start went missing (`sealed.ts`). */
  frags: ReturnType<typeof reassembler>
  /** Set only while the nonce request is outstanding — see `deliver`, which swallows the answer. */
  awaitingNonce: boolean
  nonceInbox: Uint8Array | null
  /**
   * Consecutive sealed writes the radio refused, so the "wrong key" message is said ONCE.
   *
   * `request()` retries four times and every caller is a producer, so without this a wrong key would
   * print the same paragraph a dozen times a second and bury everything else in the log.
   */
  keyRefusals: number
  /**
   * The RECEIVE chain, and it is not the write queue.
   *
   * Opening a sealed frame is async (WebCrypto is), so a notification can no longer be handled
   * inside the event listener. Notifications must still be processed IN ORDER — the fragment
   * reassembly is a state machine over consecutive counters, and handling two at once would
   * interleave them — so they are chained. **This is not a second write producer and does not touch
   * `W6`**: nothing on this chain writes to a characteristic.
   */
  notifyChain: Promise<unknown>
  /** The probe's answer: this thermostat holds a key and this browser has none for it. */
  unkeyedButSealed: boolean
  /** Why the last attempt at the radio's version failed, or null. See `learnChipVersion`. */
  chipWhy: string | null
  /** What has already been said once for this connection — see `complainOnce`. */
  complained: Set<string>
  /** `W14`: a flash owns the link for its whole transfer and reads frames rather than matching them. */
  flashing: boolean
  framesPending: Uint8Array[]
  frameWaiter: ((b: Uint8Array | null) => void) | null
  /** Bound per link, so the right link's listeners can be removed from a shared device object. */
  readonly onNotify: (e: Event) => void
  readonly onOtaStatus: (e: Event) => void
  readonly onDrop: () => void
}

/** Every live link, by the browser's handle for its thermostat. A dead link is removed. */
const links = new Map<string, Link>()

function newLink(d: BluetoothDevice): Link {
  const l: Link = {
    id: d.id,
    device: d,
    dead: false,
    cmdCh: null,
    waiters: [],
    queue: Promise.resolve(),
    encCh: null,
    encNotify: null,
    otaCtl: null,
    otaData: null,
    notifyCh: null,
    sealKey: null,
    replyKey: null,
    session: null,
    seq: 0,
    frags: reassembler(),
    awaitingNonce: false,
    nonceInbox: null,
    keyRefusals: 0,
    notifyChain: Promise.resolve(),
    unkeyedButSealed: false,
    chipWhy: null,
    complained: new Set(),
    flashing: false,
    framesPending: [],
    frameWaiter: null,
    onNotify: (e) => onNotify(l, e),
    onOtaStatus: (e) => onOtaStatus(l, e),
    onDrop: () => tearDown(l),
  }
  return l
}

/* ================================================================================================
 * WHAT THIS MODULE PUBLISHES — atoms, written from here, read anywhere
 * ================================================================================================
 * This file sets them through Jotai's default store and components read them with `useAtomValue`:
 * no listener, no copy, nothing in between for the two to disagree about. `state/atoms.ts`
 * re-exports them.
 *
 * Reading one outside React is `getDefaultStore().get(theAtom)`, which is what the accessors below
 * do for the two callers that need a value rather than a subscription.
 */

const jotai = getDefaultStore()

/**
 * ================================================================================================
 * EVERY DEVICE FACT IS A FAMILY, AND THE SINGULAR NAME IS A DERIVED READ OF THE OPEN ONE
 * ================================================================================================
 * Each of these is keyed by the browser's handle — the same key `links` uses and the same key
 * `advert.ts` reports broadcasts under — so two connections cannot write into each other's screen.
 *
 * **THE SINGULAR ATOMS ARE KEPT, DERIVED FROM `activeIdAtom`.** Every view that shows "the"
 * thermostat is showing the one the address bar is on, so `statusAtom` and the rest read the open
 * device's entry and every existing reader works untouched. It also buys render granularity a single
 * atom cannot: the row that is connecting repaints, and the other rows do not.
 *
 * **NOTHING HERE MAY BE WRITTEN FROM A COMPONENT.** They are written by this module alone; the
 * derived singular ones are read-only by construction.
 */

/** Handles that currently have a `Link` — how a view asks which thermostats are up. */
export const linkIdsAtom = atom<string[]>([])

/**
 * A LIVE LINK WITH NO SAVED ROW BEHIND IT — the thermostat `/connected` is for.
 *
 * A row is filed from what a device says about itself on connect: its serial, which stock answers
 * too, or its MAC. **An STM8 sitting in its updater after an interrupted install says neither**, so
 * there is nothing to file it under — and it is exactly the device somebody needs to reach, because
 * the installer can still rescue it. This is how the list offers a way in to one, and how the
 * address `/connected` finds its device.
 */
export const unsavedLinkAtom = atom((get) => {
  const rows = get(storedRegistryAtom).devices
  return get(linkIdsAtom).find((id) => !rows.some((r) => r.deviceId === id)) ?? null
})

/**
 * THE THERMOSTAT THE SCREEN IS ON, as the browser's handle — what every singular atom below and
 * every `request()` with no explicit link acts on.
 *
 * It is DERIVED from the address bar and the registry rather than tracked, which is the whole point:
 * "which thermostat is open" has one home (`state/route.ts`) and this is a join onto it, exactly as
 * `advertFor` joins a row to its broadcast.
 *
 * `/connected` is the one address with no row — an STM8 sitting in its updater cannot say which
 * thermostat it is — so there it is the live link that matches no row.
 *
 * In test mode a row has no browser handle at all, so the ROW's own id stands in: `useRouteLink`
 * opens `row.deviceId ?? rowId`, and this has to agree with it or the tabs would read an empty entry.
 */
export const activeIdAtom = atom((get) => {
  const rowId = get(openIdAtom)
  if (rowId) {
    const row = get(storedRegistryAtom).devices.find((d) => d.id === rowId)
    return row?.deviceId ?? (TEST_MODE ? rowId : null)
  }
  return get(unsavedAtom) ? get(unsavedLinkAtom) : null
})

export type LinkState = 'disconnected' | 'waiting' | 'connecting' | 'connected'

/**
 * WHAT ONE THERMOSTAT'S LINK IS DOING. Four states, and `waiting` is the one worth reading twice.
 *
 * **`waiting` MEANS HEARD-NOTHING-YET-SO-NOT-ATTEMPTING**, and it is honest only because `openLink`
 * owns that span — see its `W29` header for why the app refuses to try before an advert lands, and
 * for what the bar showed without a state for it.
 */
export const linkStateFor = atomFamily((_id: string) => atom<LinkState>('disconnected'))

export const linkStateAtom = atom((get) => {
  const id = get(activeIdAtom)
  return id ? get(linkStateFor(id)) : ('disconnected' as LinkState)
})

/**
 * Is the link UP — the one question almost every view has, and the only place that decides it.
 * `linkStateAtom` is for the callers that need `waiting` and `connecting` too.
 */
export const connectedAtom = atom((get) => get(linkStateAtom) === 'connected')

/** The device's advertised name, once connected. */
export const deviceNameFor = atomFamily((_id: string) => atom<string | null>(null))
export const deviceNameAtom = atom((get) => {
  const id = get(activeIdAtom)
  return id ? get(deviceNameFor(id)) : null
})

/**
 * The thermostat's own firmware version, read on connect — 200 is ours, 148 is stock.
 *
 * It decides what the app may OFFER: the mod-only sections are unusable on a stock thermostat, and
 * a version we have not read is not evidence of anything. Null is "unknown", never "stock".
 */
export const fwVersionFor = atomFamily((_id: string) => atom<number | null>(null))
export const fwVersionAtom = atom((get) => {
  const id = get(activeIdAtom)
  return id ? get(fwVersionFor(id)) : null
})

/** The RADIO chip's version — a different chip and a different question. `caps.ts` says why. */
export const chipVersionFor = atomFamily((_id: string) => atom<ChipVersion | null>(null))
export const chipVersionAtom = atom((get) => {
  const id = get(activeIdAtom)
  return id ? get(chipVersionFor(id)) : null
})

/**
 * Whether the thermostat's answers reach this browser at all.
 *
 * False is a real and specific state, not a failed connection: on a Mac against a STOCK radio chip
 * `startNotifications()` fails and the page can send commands forever without seeing one answer.
 * The connection is otherwise fine and half the app still works, so it is reported rather than
 * thrown — `caps.ts`, MAC_NOTIFY_HINT, is what a person can do about it.
 */
export const repliesFor = atomFamily((_id: string) => atom(true))
export const repliesAtom = atom((get) => {
  const id = get(activeIdAtom)
  return id ? get(repliesFor(id)) : true
})

/**
 * The thermostat's status — its setpoint, mode, boost, lock, window and valve.
 *
 * Null when nothing has said one, which is not the same as "everything off": a device that has not
 * answered has no state to show, and drawing zeroes would be inventing it. It arrives BOTH from the
 * device's own ~1 Hz push and from every setting command's reply — see `status.ts`.
 */
export const statusFor = atomFamily((_id: string) => atom<Status | null>(null))
export const statusAtom = atom((get) => {
  const id = get(activeIdAtom)
  return id ? get(statusFor(id)) : null
})

/**
 * THE THIRTEEN BYTES OF THE GLASS, as the thermostat last reported them.
 *
 * **IT IS PUSHED, NOT POLLED.** A client holding a lease (`cmd 0x23` mode 1, renewed by the Display
 * tab) is SENT the panel whenever it changes, so these frames arrive unasked — which is why they are
 * decoded in `deliver` beside the status push rather than awaited by whoever asked. The tab READS
 * this and never holds a copy, the same rule every other device value follows.
 *
 * Null is "we have not been told yet", which is every device before its first frame.
 */
export const panelFor = atomFamily((_id: string) => atom<Uint8Array | null>(null))
export const panelAtom = atom((get) => {
  const id = get(activeIdAtom)
  return id ? get(panelFor(id)) : null
})

/**
 * The thermostat's ACCESS SETTINGS — the PIN gate, the broadcast switch, the key and the MAC.
 *
 * **IT IS HERE BECAUSE THE CONNECT PATH ALREADY ASKS FOR IT**: `identify` sends `cmd 0x51 02` on
 * every connection for the MAC, and the same reply carries the rest. One question, one answer.
 *
 * Null is "we do not know", never "off" — both bits of the config byte are legitimately clear on a
 * device with its broadcast and its gate off (`decodeKeyStatus`).
 */
export const keyStatusFor = atomFamily((_id: string) => atom<KeyStatus | null>(null))
export const keyStatusAtom = atom((get) => {
  const id = get(activeIdAtom)
  return id ? get(keyStatusFor(id)) : null
})

/**
 * The ADVERTISED NAME as the device last reported it, with the byte limit it reported beside it.
 *
 * **THREE STATES, AND COLLAPSING TWO OF THEM IS WHAT MISLEADS.** `undefined` is "not asked yet",
 * `null` is "asked and it did not answer" — which is what a radio from before `cmd 0x5B` does, and
 * the only one of the two that may say "update the firmware".
 *
 * `deviceNameAtom` is the DISPLAY name derived from this plus the browser's seed; this is the
 * device's own report. `noteAdvName` is the only writer of both.
 */
export const advNameFor = atomFamily((_id: string) => atom<AdvName | null | undefined>(undefined))
export const advNameAtom = atom((get) => {
  const id = get(activeIdAtom)
  return id ? get(advNameFor(id)) : undefined
})

/**
 * THE WHOLE SETTINGS TAB, in one reply — `cmd 0x16` reports every setting at once, in the units of
 * the command that changes each one.
 *
 * Null is "we have not been told", which the rows state rather than drawing a default the device
 * may not hold. The tab re-reads whenever it opens, because the thermostat's own wheel is a writer
 * nothing here can see.
 */
export const settingsFor = atomFamily((_id: string) => atom<DeviceSettings | null>(null))
export const settingsAtom = atom((get) => {
  const id = get(activeIdAtom)
  return id ? get(settingsFor(id)) : null
})

/**
 * How often the thermostat announces itself — `cmd 0x22`, read separately from `settingsAtom`
 * because `cmd 0x16` does not carry it (`device/config.ts`'s header says why).
 *
 * Null is "we have not asked yet", same convention as `settingsFor`.
 */
export const advIntervalFor = atomFamily((_id: string) => atom<number | null>(null))
export const advIntervalAtom = atom((get) => {
  const id = get(activeIdAtom)
  return id ? get(advIntervalFor(id)) : null
})

/**
 * Move one thermostat's link state, and clear what no longer describes it.
 *
 * **THE NAME IS PART OF THE STATE, and so is the fact that it is only a seed.** The browser's name
 * for a handle is a stale cache (`fileRow` says why), so it only fills the gap between connecting
 * and the device answering `chaseAdvName`, and that answer replaces it. Clearing on the way out
 * matters as much: a name left standing belongs to a device that has gone.
 */
function setState(l: { id: string; device: BluetoothDevice | null }, s: LinkState) {
  jotai.set(linkStateFor(l.id), s)
  // WHAT THE LAST DEVICE SAID IS NOT ABOUT THIS ONE.
  if (s !== 'connected') {
    jotai.set(keyStatusFor(l.id), null)
    jotai.set(advNameFor(l.id), undefined)
    jotai.set(settingsFor(l.id), null)
    jotai.set(advIntervalFor(l.id), null)
  }
  jotai.set(deviceNameFor(l.id), s === 'disconnected' ? null : (l.device?.name ?? null))
  // **`waiting` SAYS NOTHING IN THE LOG, deliberately.** It is the ordinary second before an advert
  // lands, and a line for it on every connect — and on every retry inside one — would bury the
  // lines that report a problem. The BUTTON is where it belongs, because that is where it stops a
  // misleading press.
  if (s === 'waiting') return
  log(
    s === 'connected'
      ? `connected to ${l.device?.name ?? 'the device'}`
      : s === 'connecting'
        ? 'connecting…'
        : 'disconnected',
  )
}

function setFw(l: Link, v: number | null) {
  jotai.set(fwVersionFor(l.id), v)
  if (v !== null) log(`thermostat firmware ${fwText(v)}`)
}

function setChip(l: Link, v: ChipVersion | null) {
  jotai.set(chipVersionFor(l.id), v)
  if (v !== null) log(`radio firmware ${chipText(v)}`)
}

function setStatus(l: Link, s: Status | null) {
  jotai.set(statusFor(l.id), s)
}

export const linkState = () => jotai.get(linkStateAtom)

/**
 * The link the SCREEN is on, or null — what `request()` and every exported ask act on by default.
 *
 * Read through `activeIdAtom` rather than tracked, so "which thermostat" has exactly one home. A
 * caller inside this module that already holds a link passes it instead — see `request`.
 */
function active(): Link | null {
  const id = jotai.get(activeIdAtom)
  return id ? (links.get(id) ?? null) : null
}

/**
 * Send this browser's clock — `cmd 0x03`, whose reply IS the status, so it refreshes the page too.
 *
 * NO RETRY `[owner]`. It is one command with a reply; if it does not land there is a button, and
 * nothing depends on it having worked.
 *
 * **IT IS ALSO THE APP'S ONLY WAY TO ASK WHAT THE THERMOSTAT IS SET TO**, which is why the target
 * buttons call it on a first press with no reading (`StatusControls`). No stock or mod command
 * answers with a status without changing something, so learning the setpoint costs a clock write —
 * acceptable once, when somebody has asked for a change, and not worth spending on every connect.
 */
export async function sendClock(): Promise<Status | null> {
  const r = await request(setDateTime(new Date()), isStatus, 1)
  return r ? decodeStatus(r) : null
}


/**
 * Run `fn` after everything already queued, whatever happened to it.
 *
 * `.then(fn, fn)` rather than `.then(fn)`: a REJECTED predecessor must still let the next one run,
 * or one thrown write wedges the app for the rest of the session.
 */
function serialise<T>(l: Link, fn: () => Promise<T>): Promise<T> {
  const run = l.queue.then(fn, fn)
  l.queue = run.catch(() => {}) // the chain itself never carries a rejection forward
  return run
}

/**
 * THE ONLY PLACE A RAW GATT METHOD MAY BE NAMED, and the token that proves you hold the queue.
 *
 * **PRIVACY GUARDS THE WRONG BOUNDARY** `[owner]`. Keeping the characteristics private stops a
 * COMPONENT reaching `writeValue` — true, and irrelevant: all three of the concurrency bugs found in
 * one evening were inside this file, where privacy does not apply. A read fired beside a write
 * returns `GATT operation failed for unknown reason`; each was one line that simply forgot the
 * queue, and nothing could have noticed.
 *
 * So the rule is a TYPE. A function that touches the wire takes an `Io`, an `Io` comes only from
 * `withLink`, and `withLink` is the queue — so "call it outside the queue" is not a mistake a reader
 * has to know about, it is code that does not compile. `check_gatt.py` closes the other half by
 * failing the build if these method names appear anywhere but here.
 *
 * **A TOKEN RATHER THAN A WRAPPER PER CALL, because of re-entrancy.** If every wrapped call took the
 * queue, a call made inside something already holding it would deadlock — and that is not
 * hypothetical: a flash holds the queue for its WHOLE run and writes ~2500 packets inside it. One
 * lock, taken at the top, and `io` used freely under it.
 */
export type Io = {
  service: (server: BluetoothRemoteGATTServer, uuid: string) => Promise<BluetoothRemoteGATTService>
  characteristic: (
    svc: BluetoothRemoteGATTService,
    uuid: string,
  ) => Promise<BluetoothRemoteGATTCharacteristic>
  read: (ch: BluetoothRemoteGATTCharacteristic) => Promise<DataView>
  write: (ch: BluetoothRemoteGATTCharacteristic, bytes: ArrayLike<number>) => Promise<void>
  /** Unacknowledged, where the characteristic offers it — currently nothing does. See `flash.ts`. */
  writeFast: (ch: BluetoothRemoteGATTCharacteristic, bytes: ArrayLike<number>) => Promise<void>
  subscribe: (ch: BluetoothRemoteGATTCharacteristic) => Promise<void>
}

/**
 * WE GAVE UP WAITING — which is not the same as the device saying no, and telling them apart is the
 * difference between a fixable problem and a confident lie.
 *
 * `bounded` throws this when a GATT call has not come back in time. Every other rejection comes from
 * the browser or the device. The one place that has to know is `writeCommand`: a sealed write that
 * is REFUSED means the tag did not verify, i.e. the stored key is wrong — and that message was
 * being printed for a write that merely took too long on a thermostat that was busy. The key was
 * right; the app said it was not, and then every question after it failed for the same reason and
 * was reported as its own separate fault.
 */
class Stalled extends Error {}

/**
 * A GATT call that never settles must not be able to hold the queue for ever.
 *
 * **THIS IS THE CLOG** `[owner]` `[inferred]`. A command's REPLY is bounded by `REPLY_TIMEOUT_MS`
 * and the operation that sends it has nothing of its own to expire, so one browser-side call that
 * never comes back freezes every command in the app from inside the lock — and the only way out is
 * to drop the link and let the browser reject it.
 *
 * The timeout does NOT cancel the operation; a Web Bluetooth call cannot be cancelled. It stops US
 * waiting, which is the part that wedges everything.
 */
export function bounded<T>(what: string, ms: number, op: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      log(`the thermostat stopped answering during ${what} — abandoning it so the rest keeps working`)
      reject(new Stalled(`${what} did not finish within ${Math.round(ms / 1000)} s`))
    }, ms)
    op.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e: unknown) => {
        clearTimeout(t)
        reject(e instanceof Error ? e : new Error(String(e)))
      },
    )
  })
}

/**
 * Long enough that no healthy operation reaches it — a round trip is ~100 ms — and short enough that
 * a person notices a stall rather than a dead app.
 */
const GATT_TIMEOUT_MS = 10_000

/**
 * SUBSCRIBING GETS ITS OWN, MUCH LONGER BOUND, and the reason is a human one: this is the operation
 * that raises the browser's pairing dialog on a thermostat that wants its PIN, and the PIN is shown
 * on the THERMOSTAT'S OWN DISPLAY. Somebody walking to the radiator to read it and walking back is
 * doing exactly the right thing, and a ten-second bound would cancel their connection while they
 * did. It is still bounded, because a subscribe that hangs wedges the queue like any other.
 */
const SUBSCRIBE_TIMEOUT_MS = 300_000

/**
 * How long to wait for a device to accept a connection. Longer than an operation on an OPEN link,
 * because this one is waiting for a thermostat to be in range and answer at all.
 */
const CONNECT_TIMEOUT_MS = 30_000

const IO: Io = {
  service: (server, uuid) =>
    bounded('looking up a service', GATT_TIMEOUT_MS, server.getPrimaryService(uuid)),
  characteristic: (svc, uuid) =>
    bounded('looking up a characteristic', GATT_TIMEOUT_MS, svc.getCharacteristic(uuid)),
  read: (ch) => bounded('a read', GATT_TIMEOUT_MS, ch.readValue()),
  // Copied into a fresh array rather than passed through: `writeValueWithResponse` takes a view on a
  // plain ArrayBuffer, and a slice of a caller's buffer is not typed as one.
  write: (ch, bytes) =>
    bounded('a write', GATT_TIMEOUT_MS, ch.writeValueWithResponse(new Uint8Array(bytes))),
  writeFast: (ch, bytes) =>
    bounded(
      'a write',
      GATT_TIMEOUT_MS,
      ch.properties.writeWithoutResponse
        ? ch.writeValueWithoutResponse(new Uint8Array(bytes))
        : ch.writeValueWithResponse(new Uint8Array(bytes)),
    ),
  subscribe: (ch) =>
    bounded('subscribing', SUBSCRIBE_TIMEOUT_MS, ch.startNotifications()).then(() => {}),
}

/** Take one link's queue, and hand what is inside it the one thing allowed to touch the wire. */
function withLink<T>(l: Link, fn: (io: Io) => Promise<T>): Promise<T> {
  return serialise(l, () => fn(IO))
}

/**
 * Try `once` up to `tries` times, TAKING THE QUEUE SEPARATELY FOR EACH ATTEMPT and pausing between
 * them, and give up the moment the connection this was asked of has gone.
 *
 * **THE LOCK IS NOT HELD ACROSS THE WHOLE LOOP, and that is the entire point** `[owner]`. Inside one
 * `withLink`, a thermostat that answers nothing holds the wire for every attempt and every gap —
 * four attempts at the reply timeout is six seconds during which pressing Install does nothing. A
 * device that has stopped answering is exactly the device somebody is about to re-flash, so the
 * failing question must not be able to delay the cure. One attempt at a time means the longest
 * anything else can be made to wait is a single reply timeout.
 *
 * **THE GAP IS NOT POLITENESS EITHER.** Without it a silent device is asked again the instant the
 * write resolves, which on a link whose replies are merely late is a stream of commands at wire
 * speed to a part that is already struggling. It also stops a caller that retries forever from
 * becoming a busy loop.
 *
 * **AND NOTHING SURVIVES THE LINK** — the `dead` re-check is the `W30` generation rule (see header).
 */
async function retrying<T>(l: Link, tries: number, once: () => Promise<T | null>): Promise<T | null> {
  for (let i = 0; i < tries; i++) {
    if (i) await new Promise((r) => setTimeout(r, RETRY_GAP_MS))
    if (l.dead) return null
    const r = await once()
    if (r !== null) return r
  }
  return null
}

function onNotify(l: Link, e: Event) {
  const ch = e.target as BluetoothRemoteGATTCharacteristic
  if (!ch.value) return
  // COPIED, NOT VIEWED. Opening a sealed frame is async, so the bytes outlive this call and Chrome
  // reuses its own buffer underneath them.
  const b = new Uint8Array(ch.value.buffer.slice(0))
  l.notifyChain = l.notifyChain.then(
    () => deliver(l, b),
    () => deliver(l, b), // one thrown frame must not wedge every frame after it
  )
}

/**
 * One notification, opened if it was sealed, reassembled if it was a fragment, then delivered.
 *
 * **THE NOTIFY CHANNEL IS MIXED and that is by design**: only the thermostat's relayed replies are
 * sealed, so the radio's own status codes and its serial still arrive in the clear. The marker byte
 * is what separates them and LENGTH CANNOT — a sealed 1-byte reply is exactly the eight bytes of the
 * nonce answer.
 */
async function deliver(l: Link, raw: Uint8Array) {
  // The nonce answer is this layer's own traffic and must never surface. It is eight random-looking
  // bytes, so a caller matching "anything that is not a status push" takes it as the reply to
  // whatever it just sent. Swallow it while a request for one is outstanding.
  if (l.awaitingNonce && raw.length === NONCE_LEN && raw[0] !== MAGIC_ENC) {
    l.nonceInbox = raw
    return
  }
  let data = raw
  if (l.sealKey && l.session && (raw[0] === MAGIC_ENC || raw[0] === MAGIC_ENC_FRAG)) {
    try {
      // A REPLY WIDER THAN ONE AIR-SAFE NOTIFICATION ARRIVES IN FRAGMENTS. Reassembly and the
      // lost-notification check are `sealed.ts`'s `reassembler`, which says why the counter and not
      // the marker is what makes a missing FIRST fragment detectable at all.
      const whole = l.frags.push(await openReply(l.replyKey ?? l.sealKey, l.session, raw))
      if (!whole) return // buffered, or dropped as the tail of a reply we never saw the start of
      data = whole
    } catch (e) {
      // A bad tag, or a frame from before the nonce was learned. Keep it as it arrived: it may be
      // the radio's own plaintext, and dropping it turns a decode problem into a timeout. A
      // part-assembled reply is abandoned here on purpose — continuing it across a frame that did
      // not open would splice unrelated bytes into it.
      //
      // **AND SAY SO, BECAUSE THIS IS WHERE A REPLY DISAPPEARS WITHOUT A TRACE** `[owner]`. The
      // frame is passed on as ciphertext, no matcher accepts it, and the command that sent it
      // reports "no reply" — so a decryption problem and a thermostat that never answered look
      // identical from every screen in the app. It bites the LONGEST replies first, since those are
      // the ones that arrive in fragments. Once per connection, with the marker and the length,
      // which is what separates a bad tag from a truncated frame.
      complainOnce(
        l,
        'open',
        `a sealed reply could not be opened (marker ${raw[0]?.toString(16)}, ${raw.length} B) — ` +
          `the command that asked for it will report no answer (${why(e)})`,
      )
      l.frags.reset()
      data = raw
    }
  }
  // W14: a flash reads the NEXT frame rather than matching one, and judges it itself. While one is
  // running every frame goes to its inbox as well — the status decode below is harmless in
  // bootloader mode (nothing there looks like a status) and the waiters are empty, since a flash
  // holds the queue for its whole run.
  if (l.flashing) pushFrame(l, data)
  // DECODED BEFORE THE WAITERS SEE IT, and independently of them: the device pushes a status about
  // once a second whether or not anybody asked, and every setting command answers with the same
  // frame. Taking it here means the page is current from BOTH, and no caller has to remember to
  // feed one back. A waiter still gets its own copy — this consumes nothing.
  const s = decodeStatus(data)
  if (s) setStatus(l, s)
  // THE PANEL, FOR THE SAME REASON AND ON THE SAME LINE OF ARGUMENT. With a lease armed the
  // thermostat sends the glass whenever it changes, so these frames belong to nobody in particular
  // — taking them here means the Display tab is current from a PUSH and from the renewal's own
  // reply alike, and no caller has to feed one back. A waiter still gets its copy below.
  if (isPanel(data)) {
    const bits = panelBytes(data)
    if (bits) jotai.set(panelFor(l.id), bits)
  }
  l.waiters = l.waiters.filter((w) => !(w.match(data) && (w.resolve(data), true)))
}

/**
 * WRITE ONE COMMAND, through whichever door this connection has — the single point where a command
 * is encrypted.
 *
 * **SEALING IS CHOSEN, NOT DETECTED, and that is load-bearing.** With a key AND a sealed door AND a
 * session nonce, commands go out sealed; with any of the three missing they go out plain. Nothing is
 * inferred from how the device answers, because it cannot be: the plaintext characteristic never
 * closes and never refuses a write, so a client waiting for a refusal to tell it to encrypt would
 * send plaintext for ever while reporting that it was encrypting.
 *
 * **A STAGED COMMAND IS SEVERAL WRITES INSIDE ONE QUEUE SLOT**, which is what `W6` requires: they
 * are one command and nothing may interleave with them. The caller already holds the queue.
 */
async function writeCommand(l: Link, io: Io, bytes: number[]): Promise<void> {
  if (l.sealKey && l.session && l.encCh && !PLAINTEXT_IDS.has(bytes[0]!)) {
    l.seq = (l.seq + 1) & 0xffff
    const inner = new Uint8Array(bytes)
    const writes =
      inner.length <= ENV_MAXIN
        ? [await sealCommand(l.sealKey, l.session, l.seq, inner)]
        : await stageCommand(l.sealKey, l.session, l.seq, inner)
    try {
      for (const w of writes) await io.write(l.encCh, w)
    } catch (e) {
      // A REFUSAL HERE IS THE KEY, and saying so is the difference between a fixable problem and a
      // thermostat that looks broken. The radio rejects a frame whose tag does not verify, and the
      // rejection surfaces as an ATT error the browser reports as `Invalid Handle` — which reads as
      // a missing characteristic and is neither that nor a permission problem. Measured on the
      // device, same handle and same connection: the right key is accepted, any other is refused
      // (`../../../PROTOCOL.md`, "Sending a command encrypted"). The `0x56` request that got us a session
      // nonce already proved the characteristic is there and writable.
      //
      // **A STALL IS NOT A REFUSAL** `[owner]` — see `Stalled`, and `bounded` has already said what
      // really happened.
      if (e instanceof Stalled) throw e
      l.keyRefusals++
      // NOT WHILE A KEY IS BEING INSTALLED. During an apply the key genuinely IS changing under the
      // connection, so a refusal there is the ordinary consequence of that and not a stored key that
      // is wrong — telling the owner their key is wrong in the middle of them setting one correctly
      // is the worst moment to be misleading. Nor on the first refusal: see
      // `KEY_REFUSALS_BEFORE_BLAMING`.
      if (l.keyRefusals === KEY_REFUSALS_BEFORE_BLAMING && !l.replyKey) {
        // **WITH THE BROWSER'S OWN WORDS ON THE END.** Which ATT error it was is the only thing
        // that separates a key the radio rejects from a handle that is not there from a link that
        // has gone.
        log(
          'the thermostat refused an encrypted command — the key saved here is not the one it ' +
            `holds. Set it again on the Install tab, or clear it to go back to plain commands. (${why(e)})`,
        )
      }
      throw e
    }
    l.keyRefusals = 0
    return
  }
  if (!l.cmdCh) return
  await io.write(l.cmdCh, bytes)
}

/**
 * LISTEN FIRST, SEND, THEN START THE CLOCK — and the three are in that order for three reasons.
 *
 * **The waiter is registered BEFORE the write** because a reply can arrive while the write is still
 * settling; registering afterwards would drop it.
 *
 * **The clock starts AFTER the write resolves**, because otherwise the reply window is
 * `REPLY_TIMEOUT_MS` MINUS however long sending took, and the commands it shortens are the longest
 * ones: a sealed command over `ENV_MAXIN` inner bytes is three writes rather than one
 * (`sealed.ts`'s `stageCommand`), which is what every schedule write is. On a healthy link a write
 * is tens of milliseconds against a 1.5 s window, so this has not been seen to cost a reply — what
 * was wrong is that the bound did not mean what its name says.
 *
 * **A failed write settles the waiter instead of leaving it armed.** It is already in `l.waiters`
 * by then, and a waiter that is never resolved is a promise no caller's `await` ever returns from —
 * a worse failure than the one above, and the reason this is not simply two statements swapped.
 *
 * **EXPORTED FOR `attempt.test.ts`, and it costs the file nothing.** The guard here has never been
 * privacy — it is the `Io` parameter, which only `withLink` can produce, so a component holding
 * this name still cannot reach the wire. `request()` is the way in for everything else.
 */
export async function attempt(l: Link, io: Io, bytes: number[], match: Match): Promise<Reply | null> {
  if (!l.cmdCh) return null // the link went away between the caller's check and here
  let settle!: (b: Reply | null) => void
  const got = new Promise<Reply | null>((resolve) => {
    settle = resolve
  })
  const w: Waiter = { match, resolve: (b) => settle(b) }
  const forget = () => {
    l.waiters = l.waiters.filter((x) => x !== w)
  }
  l.waiters.push(w)
  try {
    await writeCommand(l, io, bytes)
  } catch {
    // The link is gone; the disconnect handler owns the state. Drop the waiter we just armed.
    forget()
    settle(null)
    return got
  }
  setTimeout(() => {
    forget()
    settle(null)
  }, REPLY_TIMEOUT_MS)
  return got
}

/**
 * Send a command and wait for the reply that `match` accepts. `null` means it never came.
 *
 * THIS IS THE ONLY WAY TO TALK TO THE DEVICE. It queues, so callers may fire whenever they like and
 * do not have to know about each other — which is the point, because in a React app they cannot.
 *
 * **WHICH THERMOSTAT: the one the SCREEN is on** (`activeIdAtom`), unless a caller inside this
 * module hands one over. Every tab acts on the thermostat whose address is open, so no component
 * has to carry a device around — and a connect path, which is talking to a device the address bar
 * has not arrived at yet, passes its own link rather than borrowing whatever happens to be open.
 * With no link there, the ordinary "no reply" answer comes back: a view whose device has hung up
 * takes the same path it takes for a lost frame, instead of throwing.
 */
export function request(
  bytes: number[],
  match: Match,
  tries = DEFAULT_TRIES,
  on: Link | null = active(),
): Promise<Reply | null> {
  if (TEST_MODE) {
    const r = testReply(bytes)
    const b = r && new Uint8Array(r)
    // HELD TO THE SAME MATCHER as a real reply, so a forged frame the app would have rejected is
    // rejected here too rather than quietly working only in test mode.
    return Promise.resolve(b && match(b) ? b : null)
  }
  if (!on) return Promise.resolve(null)
  // ONE LOCK PER ATTEMPT, NOT ONE FOR THE LOT — `retrying` says why, and it matters most exactly
  // here, because this is the path every command in the app goes down.
  return retrying(on, tries, () => withLink(on, (io) => attempt(on, io, bytes, match)))
}

/**
 * Send a command that ANSWERS NOTHING, and do not wait for one.
 *
 * A handful of ids genuinely have no reply — `cmd 0x30` (window open) ends without ever calling the
 * status builder `[binary]`, `[manually verified]`. Putting one through `request()` would wait out
 * every attempt's timeout and then report a working command as a failure, so those get this
 * instead. It still goes through the SAME queue, which is what `W6` protects: one write in flight,
 * whether or not anybody is listening for an answer.
 *
 * The device's own ~1 Hz status push is what shows the effect, usually within a second.
 */
export function send(bytes: number[], on: Link | null = active()): Promise<void> {
  if (TEST_MODE || !on) return Promise.resolve()
  return withLink(on, async (io) => {
    if (!on.cmdCh) return
    try {
      await writeCommand(on, io, bytes)
    } catch {
      /* the link is gone; the disconnect handler owns the state */
    }
  })
}

/**
 * Ask the browser for a device and connect.
 *
 * IT MUST BE CALLED FROM A REAL USER GESTURE, and no amount of arranging around it will help:
 * `requestDevice()` opens Chrome's own chooser and the browser refuses it otherwise. The
 * no-chooser path (`getDevices()`) returns only devices this origin has ALREADY been granted — see
 * `connectTo()`. So the first connection to a given thermostat is a human click, once per origin;
 * after that a saved row connects by itself.
 *
 * **THE FILTER BELOW REACHES A RENAMED THERMOSTAT TOO, so there is no unfiltered escape hatch and
 * none is needed** `[manually verified]`. A custom name is aired under the `eQ3-` prefix the RADIO
 * adds, not the text somebody typed, so `namePrefix` still matches it — measured on the air as
 * `eQ3-Dev4`. **What comes back is checked either way**: the device reports its own serial and
 * address on connect and the row is filed from those, never from the name that was picked.
 */
export async function connect(): Promise<string | null> {
  // NO CHOOSER IN TEST MODE. The browser's device list is a real permission prompt about real
  // hardware, and there is none here; the reconnect button reopens the made-up thermostat instead.
  if (TEST_MODE) {
    const id = jotai.get(activeIdAtom)
    if (id) openTestDevice(id)
    return id
  }
  if (!navigator.bluetooth) {
    throw new Error(
      'no navigator.bluetooth — this page is not in a secure context. ' +
        'Serve it over HTTPS or from localhost; plain http:// on a LAN address has no ' +
        'Web Bluetooth at all, with no error of its own.',
    )
  }
  // **NO STATE IS MOVED BEFORE THE PICK**, because there is no thermostat to move it for: the
  // chooser is the one path where the app does not yet know which device it is opening, and every
  // link state is keyed by one. The chooser is its own visible thing on screen, so the moment it
  // stops covering the page is the moment `open()` below starts saying `connecting…`.
  try {
    const d = await navigator.bluetooth.requestDevice({
      // FILTER BY NAME, NEVER BY SERVICE. The chooser matches against what is IN THE ADVERT, and
      // this firmware deliberately DROPS the 128-bit service UUID from it to buy room for the
      // BThome objects — Home Assistant discovers the device by its local name instead. So
      // `filters: [{ services: [SVC] }]` matches nothing at all and the chooser comes up empty,
      // which reads exactly like a device that is out of range or switched off.
      //
      // THE ENTRIES ARE OR'd, and there are exactly three because there are exactly three ways a
      // thermostat can be named: the two names eQ-3 ships (this hardware and the `-M-` variant),
      // matched EXACTLY, and our own prefix for a thermostat somebody has renamed. A custom name is
      // aired under `eQ3-`, added by the radio and not by whoever typed it, precisely so a renamed
      // unit stays inside what this filter looks for — `device/advname.ts`.
      //
      // EXACT NAMES RATHER THAN A `CC-RT` PREFIX `[owner]`: the same match with nothing else swept
      // in. The default is NOT prefixed, so no entry here covers another.
      filters: [...ADV_NAME_STOCK.map((name) => ({ name })), { namePrefix: ADV_NAME_PREFIX }],
      // 0xFCD2 IS NOT OPTIONAL DECORATION, and it is here for the BROADCAST watcher rather than for
      // the connection: without it the BThome service data arrives as an EMPTY MAP with no error of
      // any kind, because the browser filters service data by per-device permission —
      // `advert.ts`, trap 1. SVC is here because a filtered-in service still has to be granted.
      // OTA_SVC is here for the radio chip's own version record, which is what tells our image from
      // stock — a service not granted here cannot be reached at all, with no error worth the name.
      optionalServices: [SVC, BTHOME_SVC, OTA_SVC],
    })
    // **ALREADY OPEN IS ALREADY SUCCESS, HERE TOO** — the same guard `connectTo` has `[owner]`.
    // Re-opening a thermostat this app is already connected to would build a second link on ONE
    // GATT connection, and the sealed door cannot survive that: `primeNonce` READS the session
    // nonce rather than drawing a fresh one, so the new link restarts its command counter at zero
    // against a radio whose replay counter is already past it, and every encrypted command after
    // that is refused — which the app then reports as a wrong key.
    if (jotai.get(linkStateFor(d.id)) === 'connected') return d.id
    setState({ id: d.id, device: d }, 'connecting')
    try {
      await open(d)
    } catch (e) {
      setState({ id: d.id, device: d }, 'disconnected')
      throw e
    }
    return d.id
  } finally {
    // IN A `finally`, SO A CANCELLED CHOOSER COUNTS TOO. Opening the chooser and closing it grants
    // nothing new, yet it is exactly when `getDevices()` started answering `[manually verified]` —
    // so the answer is re-asked after every visit to it, not only after a successful pick.
    void refreshGranted()
  }
}

/**
 * The devices this origin has ALREADY been granted, which is what makes a saved row connectable
 * without the chooser — and what the front-door list watches for broadcasts.
 *
 * `getDevices()` is behind a Chrome flag (`chrome://flags/#enable-web-bluetooth-new-permissions-backend`)
 * and returns an EMPTY LIST rather than throwing when it is off. So an empty result means "not
 * granted, or the flag is off", never "the device is away" — a saved row is never reported as
 * missing on the strength of it.
 */
export async function grantedDevices(): Promise<BluetoothDevice[]> {
  if (!navigator.bluetooth?.getDevices) return []
  try {
    return await navigator.bluetooth.getDevices()
  } catch {
    return []
  }
}

/**
 * **THE METHOD EXISTING IS NOT THE FLAG BEING ON, and testing for it was the bug.**
 *
 * Chrome exposes `getDevices()` either way and simply **returns an empty list** when the persistent
 * permissions backend is off. So a check for the method reports "available" on a browser that can
 * never hand this page a device — which is precisely the state that needed reporting. Measured on a
 * phone: `getDevices: available`, `granted: none`, every saved row unwatched.
 *
 * Use `grantedCount()` for the real answer. This stays only to tell an OLD browser, which has no
 * such method at all, from a modern one with the flag off — they need different sentences.
 */
export const HAS_GET_DEVICES = !!navigator.bluetooth?.getDevices

/**
 * Whether this page has Web Bluetooth AT ALL — the first thing to check when a button does nothing.
 *
 * It is absent, with no error of any kind, on any page that is not a secure context: plain http on
 * a LAN address, or a browser that does not implement it. Everything else in this file is a
 * question you can only ask once this is true.
 */
export const HAS_BLUETOOTH = !!navigator.bluetooth

/**
 * How many devices this origin can actually reopen — null until asked.
 *
 * ZERO IS THE ANSWER THAT MATTERS, and it is not an error: it means every saved row will be a name
 * with no readings until a connection hands the page a device, because `watchAdvertisements()` is a
 * method ON a device object and there is no other way to obtain one.
 *
 * **IT IS PUBLISHED, NOT POLLED, BECAUSE THE ANSWER CHANGES UNDER THE PAGE.** Measured: at load
 * `getDevices()` handed back nothing, and after the chooser had been opened ONCE — and CANCELLED,
 * granting no new device — the same call returned the thermostat this origin had been granted in an
 * earlier session `[manually verified]`. We do not know what the chooser initialises to make that
 * happen. What we know is that a single answer taken at boot is not the truth for the rest of the
 * session, so every caller subscribes and `refreshGranted()` is re-run wherever the answer could
 * have moved.
 */
export const grantedIdsAtom = atom<string[] | null>(null)

/**
 * How many of them there are. **DERIVED, because the ids and the count are one fact.**
 */
export const grantedAtom = atom((get) => get(grantedIdsAtom)?.length ?? null)

/**
 * Whether the boot asking is OVER — not whether it found anything.
 *
 * **THE COUNT ALONE CANNOT BE ACTED ON, and acting on it is a mistake this app has made twice**
 * `[owner]`. Zero means "handed back nothing" and "has not answered yet" at the same time, because
 * the browser's first answers after a page load are unreliable — which is why the boot ask repeats.
 * Treating an early zero as final put the device chooser in front of people who had already picked
 * their thermostat; ignoring a settled zero left them tapping a row that could never open.
 *
 * With this, both are answerable: a zero that has SETTLED means this browser will hand nothing back,
 * and the chooser is the only route there is.
 */
export const grantedSettledAtom = atom(false)

export const grantedCount = () => jotai.get(grantedAtom)

/**
 * Why the last attempt to watch a granted device failed, or null.
 *
 * The watches are started for their side effect, so without this a browser that hands the device
 * over and then refuses to watch it is indistinguishable from one that hands over nothing — a blank
 * row either way.
 */
export const watchTroubleAtom = atom<string | null>(null)

/**
 * What to tell somebody whose browser hands the page no saved thermostat.
 *
 * **IT DECIDES WHETHER THE SAVED LIST HAS ANY READINGS AT ALL, which is the bigger half.**
 * `watchAdvertisements()` is a method ON a `BluetoothDevice`, and a page can only obtain one of
 * those two ways: from `requestDevice()`, which needs a live user gesture, or from `getDevices()`.
 * So with the flag off there is NOTHING to watch when the page loads and the readings stay blank
 * until a connection hands the page a device — after which the watch outlives the connection, which
 * is why connecting and disconnecting once "fixes" it until the next reload. It is a platform limit
 * with no way round it, so the app says it rather than showing empty rows.
 *
 * **TWO DIFFERENT STATES PRODUCE THE SAME BLANK LIST, and the difference is measurable** `[manually
 * verified]`. After a page RELOAD the grant is still there and Chrome simply does not serve it until
 * a chooser has been opened in that page, so opening it and pressing Cancel is enough — the
 * measurement is on `grantedIdsAtom`. After Chrome RESTARTS the grant is gone: the same dismissed
 * chooser leaves it at 0 and the thermostat has to be picked properly again, which is the case the
 * flag fixes.
 *
 * **IT POINTS AT `Add` RATHER THAN CARRYING A BUTTON OF ITS OWN** `[owner]` — a button of its own
 * would do the same thing `Add` does, since both open the browser's chooser and `connect()` re-asks
 * the granted list in a `finally`, so a cancelled visit counts either way.
 */
export const REOPEN_HINT: Hint = {
  short:
    'This browser is handing the page no saved thermostat, so the rows below stay blank. Press ' +
    'Add, wait for your thermostats to appear in the list your browser puts up, then close it ' +
    'without picking anything.',
  more:
    'Opening that list is what makes this browser start answering; nothing has to be granted, ' +
    'which is why closing it is enough — and why Add is the way in even though you are not adding ' +
    'anything. It goes blank again after every reload, and once Chrome itself restarts the ' +
    'thermostat has to be picked properly again — and they are all called CC-RT-BLE in that list ' +
    'unless you have given them names of their own. Turning on ' +
    'chrome://flags/#enable-web-bluetooth-new-permissions-backend and relaunching stops both.',
}

/**
 * Re-ask which devices this origin holds, publish the count, and watch every one of them.
 *
 * THIS IS WHAT MAKES THE FRONT DOOR WORK. The list shows what each saved thermostat is airing right
 * now, and none of those rows is connected — so the watches do not wait for somebody to open a
 * device.
 *
 * **IT IS SAFE TO CALL AS OFTEN AS YOU LIKE, and it is meant to be.** `watch()` re-arms rather than
 * duplicating (`advert.ts`, trap 2), and the granted answer moves during a session — so this runs at
 * boot, again shortly after, on every connect, after every visit to the chooser INCLUDING a
 * cancelled one, and whenever the tab comes back. A grant that arrives is useless until something
 * asks again, and that gap is what left a granted thermostat unwatched for a whole session.
 */
export async function refreshGranted(): Promise<number> {
  const known = await grantedDevices()
  jotai.set(grantedIdsAtom, known.map((d) => d.id))
  if (known.length === 0) log('this browser handed the page no saved thermostat — nothing to watch')
  // ONLY THE ONES WITH NO WATCH YET. Re-arming an existing watch is `installReArm`'s job and must
  // not also be done here: both run when the tab comes back, and two re-arms of one device race —
  // see `openLink`'s header for what the loser does to the winner.
  const fresh = known.filter((d) => !isWatched(d.id))
  if (!fresh.length) return known.length
  const problems = (await Promise.all(fresh.map((d) => watch(d)))).filter((p) => p !== null)
  jotai.set(watchTroubleAtom, problems[0] ?? null)
  return known.length
}

/**
 * Re-attach without a chooser, to a saved thermostat this origin was already granted.
 *
 * Returns false when the grant is not there — the caller's answer to that is the chooser, not an
 * error: a freshly imported registry is ENTIRELY rows in this state, and they are not broken.
 */
export function connectTo(deviceId: string): Promise<boolean> {
  if (TEST_MODE) return Promise.resolve(openTestDevice(deviceId))
  // **ALREADY OPEN IS ALREADY SUCCESS**, and saying otherwise produces a failure dialog over a
  // working thermostat `[manually verified]`. The chooser connects and then navigates, which starts
  // the arrival for the address it just opened — and the arrival asks the browser for the device by
  // handle, which on a browser that hands nothing back fails immediately. So the two disagreed about
  // a link they were both looking at: connected in the bar, "could not open" on top of it. Joining
  // an attempt in flight was never enough, because by then there is no attempt, only a result.
  if (jotai.get(linkStateFor(deviceId)) === 'connected') return Promise.resolve(true)
  // A SECOND ASK FOR THE SAME THERMOSTAT JOINS THE FIRST rather than racing it. Two things open a
  // thermostat and they overlap by design: tapping a row in the list connects, and arriving at that
  // row's address connects, and tapping a row does both. Without this they would each run `open()`
  // — two connects, two service discoveries, two `introduce()` runs on one device — and whichever
  // finished second would overwrite the first's characteristics while the first was still using
  // them. Joining also means the pair report the SAME outcome, so one cannot fall back to the
  // chooser while the other is succeeding.
  //
  // **KEYED BY HANDLE, so two DIFFERENT thermostats opening at once is not a collision** (`W30`).
  const already = opening.get(deviceId)
  if (already) return already.p
  const stop = { asked: false }
  const p = openLink(deviceId, stop).finally(() => {
    if (opening.get(deviceId)?.p === p) opening.delete(deviceId)
  })
  opening.set(deviceId, { p, stop })
  return p
}

/** The open attempts in flight, by handle. See `connectTo`. */
const opening = new Map<string, { p: Promise<boolean>; stop: { asked: boolean } }>()

/**
 * `?test=1`: fill in everything a connection would have learnt, and report success.
 *
 * It fills the ATOMS rather than forging the frames that fill them — `testMode.ts` says why — so
 * `introduce()` never runs and no characteristic is touched. Every screen then reads exactly what
 * it reads on a radio. The key is whatever `useRouteLink` opened with, which in test mode is the
 * ROW's own id: a made-up thermostat has no browser handle. `activeIdAtom` agrees.
 */
function openTestDevice(id: string): boolean {
  const l = { id, device: null }
  setState(l, 'connected')
  jotai.set(linkIdsAtom, [...new Set([...jotai.get(linkIdsAtom), id])])
  jotai.set(fwVersionFor(id), TEST_DEVICE.fw)
  jotai.set(chipVersionFor(id), TEST_DEVICE.chip)
  jotai.set(statusFor(id), { ...TEST_DEVICE.status, at: Date.now() })
  jotai.set(keyStatusFor(id), TEST_DEVICE.keyStatus)
  jotai.set(advNameFor(id), TEST_DEVICE.advName)
  jotai.set(deviceNameFor(id), aired(TEST_DEVICE.advName.name))
  jotai.set(settingsFor(id), TEST_DEVICE.settings)
  jotai.set(advIntervalFor(id), TEST_DEVICE.advInterval)
  jotai.set(radioFlashableFor(id), true)
  return true
}

/** How long one open attempt keeps trying, in total. See below for why it is a duration. */
const OPEN_MS = 30_000
/** The pause between passes while the platform has still not heard the thermostat. */
const OPEN_GAP_MS = 1500

/**
 * ================================================================================================
 * `W29` — OPENING A THERMOSTAT IS ONE OPERATION, AND THIS MODULE OWNS THE WHOLE OF IT
 * ================================================================================================
 * **THE SYMPTOM THIS FIXES:** walking into a thermostat, the Connect button sat saying "Connect"
 * for a second or so before it turned to "connecting…", and pressing it in that window did nothing
 * visible at all.
 *
 * **THE CAUSE WAS NOT A LAG. It was a job split down the middle with no owner.** The retry loop,
 * the gap and the deadline live here rather than in `useRouteLink`, so one place knows whether
 * anybody is still trying — a `waiting` state set by a caller around a single attempt would have
 * nothing able to clear it. Owning the span is what makes `waiting` honest.
 *
 * **IT HAS TO BE HEARD BEFORE IT CAN BE OPENED — and NOT attempting is the fix.** A device from
 * `getDevices()` is a permission, not a radio address. Connecting before the platform has heard the
 * thing fails with "Bluetooth Device is no longer in range" `[manually verified]`, which reads as an
 * absent thermostat and is nothing of the kind. **That is also the tell**: pausing a moment on the
 * list before tapping makes it work, and so does reloading a page that failed — both give the
 * platform time to hear the device, and neither changes anything about the thermostat.
 *
 * **ONLY WHERE THE ANSWER IS KNOWABLE.** Watching adverts is flag-gated in Chrome, and a browser
 * that cannot watch can never report having heard anything — requiring it there would block every
 * connection instead of fixing one. Where it is unavailable the old behaviour stands: try, and let
 * the platform say. **So any test of the `waiting` state has to name the browser it ran on.**
 *
 * **A DEADLINE, NOT A COUNT.** The passes are not the same length as each other — one that finds the
 * device unlisted returns at once, one that reaches a thermostat out of range waits out the connect
 * timeout — so "three tries" was four seconds in the common case and could have been minutes in the
 * other. A window promises the one thing worth promising: how long before you are told.
 *
 * **AND IT STARTS A WATCH ONLY IF NOTHING IS WATCHING YET** `[owner]`. `watch` aborts before it
 * re-subscribes, so calling it on a device already being watched races the subscription that is
 * running: the loser aborts the winner and the device ends up watching NOTHING. That is the trap
 * `refreshGranted` carries the same guard for, and from a loop that runs every 1.5 s it would mean
 * the app repeatedly killing the very advert it is waiting for.
 *
 * **EACH REASON IS SAID ONCE, AT THE END.** The browser's first answers after a page load are
 * unreliable, so an unlisted device and an unheard one are ordinary transients inside the window; a
 * line every 1.5 s for something expected buries the lines that are not.
 */
async function openLink(id: string, stop: { asked: boolean }): Promise<boolean> {
  const until = Date.now() + OPEN_MS
  const name = () => registry.byDeviceId(id)?.name ?? 'that thermostat'
  setState({ id, device: null }, 'waiting')
  for (;;) {
    if (stop.asked) break
    const d = (await grantedDevices()).find((x) => x.id === id)
    if (d && (!ADVERTS_SUPPORTED || heard(d.id))) {
      setState({ id, device: d }, 'connecting')
      try {
        await open(d)
        // **A DISCONNECT THAT LANDED MID-CONNECT HAS TO BE HONOURED HERE**, and this is the one
        // window where it cannot be honoured anywhere else: `disconnect` hangs up by finding the
        // link, and until `open` returns there is no link to find — so it can only set the flag. A
        // press on a row that says "Connecting…" would otherwise leave the thermostat connected,
        // with a button that had visibly done nothing.
        if (stop.asked) {
          disconnect(id)
          return false
        }
        return true
      } catch (e) {
        setState({ id, device: d }, 'disconnected')
        log(`${name()}: could not open it — ${why(e)}`)
        return false
      }
    }
    if (d && !isWatched(d.id)) void watch(d)
    // **STOP EARLY WHEN WAITING IS PROVABLY POINTLESS.** The window exists because the browser's
    // answer about which devices it hands back is unreliable for the first seconds — but once that
    // answer has SETTLED at nothing, no amount of the remaining window changes it, and the rest of
    // the window is spent showing a dead screen to somebody who could already have been told.
    // Measured on a phone whose permission is not kept: a tap in the first seconds after a reload
    // waited the whole window out `[manually verified]`. `grantedSettledAtom` is why the count may
    // be read here and not sooner.
    const dry = jotai.get(grantedSettledAtom) && (jotai.get(grantedAtom) ?? 0) === 0
    if (dry || Date.now() >= until) {
      // WHICH OF THE THREE IT WAS, because they are different problems and we can tell them apart.
      // Never having HEARD it means out of range, or flat batteries, or a radio that has stopped
      // advertising — nothing to do with permission. Saying "the browser would not hand it back"
      // about a thermostat two rooms away sent the reader to the wrong place. And a browser that
      // hands nothing back has heard nothing either — there is no device object to watch with — so
      // that case has to be tested FIRST or it reports itself as a thermostat out of range.
      log(
        dry
          ? `${name()}: this browser hands the page no saved thermostat, so it can only be opened through the chooser on the list`
          : heard(id)
            ? `${name()}: could not open it — this browser would not hand the device back`
            : `${name()}: nothing heard from it — out of range, or it has stopped broadcasting`,
      )
      break
    }
    await new Promise((r) => setTimeout(r, OPEN_GAP_MS))
  }
  setState({ id, device: null }, 'disconnected')
  return false
}

async function open(d: BluetoothDevice) {
  // ================================================================================================
  // CONNECT FIRST, TAKE OWNERSHIP SECOND — no `Link` is made until there is a link
  // ================================================================================================
  // Claiming the device or attaching the drop listener BEFORE the connect leaves both behind on an
  // attempt that FAILED `[owner]`, and a retry loop makes it worse with every pass: ten failed
  // attempts leave ten `gattserverdisconnected` listeners on the one device object, so a later real
  // drop tears the link down ten times and retires work belonging to a link that is still perfectly
  // good. It presents as a thermostat that will not connect however often it tries, and that a page
  // reload fixes — because a reload is what throws the accumulated state away.
  //
  // BOUNDED LIKE EVERY OTHER GATT CALL, and this one is the worst to leave unbounded: a connect that
  // never settles leaves the app saying "connecting…" for ever, and the Connect button is disabled
  // while it says that — so the one control that could recover the situation is the one the stall
  // takes away, and reloading the page is the only way out. Failing instead lands in `connectTo`'s
  // catch, which puts the button back. Generous, because this call waits for a device to be in
  // range and answer at all.
  const server = await bounded('connecting', CONNECT_TIMEOUT_MS, d.gatt!.connect())
  // A NEW LINK RETIRES EVERY QUESTION ASKED OF THE OLD ONE — the `W30` generation rule, header.
  const old = links.get(d.id)
  if (old) tearDown(old)
  const l = newLink(d)
  links.set(d.id, l)
  jotai.set(linkIdsAtom, [...links.keys()])
  // REMOVED FIRST: one device object outlives many connections, so a listener added on each
  // reconnect reports one drop many times. Each link binds its own handler, so a drop can only ever
  // tear down the link it belongs to.
  if (old) d.removeEventListener('gattserverdisconnected', old.onDrop)
  d.addEventListener('gattserverdisconnected', l.onDrop)
  // THE ADVERT WATCH IS STARTED AFTER THE LINK IS UP, and deliberately not stopped on disconnect:
  // the broadcast is aired whether or not anybody is connected, so live values survive the link
  // going away. This is also why the `BluetoothDevice` never leaves this module — the advert layer
  // is handed it, rather than the app being handed a `.gatt` it could reach a characteristic
  // through.
  //
  // **AFTER, not before, because a watch IS A RUNNING SCAN.** Android carries out a connection
  // handshake and a scan on the same radio, and starting the connection underneath one is a known
  // way to have it dropped straight after it is established. Nothing is lost by waiting: the watch
  // outlives this connection either way.
  void watch(d)
  // THE SERVICES ARE WHERE A DROPPED LINK SHOWS UP, and Chrome's own message for it ("GATT Server
  // is disconnected") says what happened but not what we were doing, so it reads as the app being
  // broken rather than as the link failing at a known point.
  const svc = await withLink(l, (io) => io.service(server, SVC)).catch((e: unknown) => {
    throw new Error(
      // NOT THE PAIRING GATE. A gated thermostat gets PAST here `[manually verified]`: connected
      // while gated, its service table enumerated normally and its ungated characteristics worked.
      // The gate refuses OPERATIONS on the attributes it covers, not the discovery of them — so a
      // gated device reaches `connected` and then hears nothing, which is the state `PairInvite`
      // owns. Failing at this line is the link going away.
      'the thermostat accepted the connection and then dropped it before its services could be ' +
        'read. That is the link failing rather than the thermostat refusing: move closer, and try ' +
        'again. (A thermostat that wants its PIN gets further than this and then answers nothing, ' +
        'which the Status tab offers a way through.) ' +
        `(${e instanceof Error ? e.message : String(e)})`,
    )
  })
  // KEPT, because the subscribe can be RETRIED later. It fails on a gated thermostat — the legacy
  // CCCD is one of the attributes the PIN gate covers — and once a person has paired, the link is
  // fine and only this subscription is missing. Without a reference there would be nothing to retry
  // and the only way back would be a reconnect — see `provokePairing`.
  //
  // DISCOVERY ONLY HERE. Getting the characteristic writes nothing; SUBSCRIBING to it writes its
  // CCCD, and that is a gated attribute — so the subscribe waits until the sealed door has had its
  // chance, further down. See the block after the sealed pair for why the order is load-bearing.
  await withLink(l, async (io) => {
    l.notifyCh = await io.characteristic(svc, NOTIFY_CH)
    l.cmdCh = await io.characteristic(svc, CMD_CH)
    // THE SEALED PAIR IS OPTIONAL AND ITS ABSENCE IS NOT AN ERROR — an older radio image simply has
    // no such characteristic, and then there is no sealed traffic and the legacy door does
    // everything it always did. Discovered rather than assumed, so one client works against both.
    try {
      const encNotify = await io.characteristic(svc, ENC_N)
      await io.subscribe(encNotify)
      // THE SAME LISTENER as the legacy notify, deliberately: both characteristics carry replies to
      // this app's commands, and `deliver` tells a sealed frame from a clear one by its marker byte.
      // Two streams, one handler, one order — which the reassembly below depends on.
      //
      // KEPT ON THE LINK so `tearDown` can take it off again. The listener is this link's own
      // closure, so it is not deduplicated by identity the way a shared function would be.
      encNotify.addEventListener('characteristicvaluechanged', l.onNotify)
      l.encNotify = encNotify
      l.encCh = await io.characteristic(svc, ENC_W)
    } catch {
      l.encCh = null
    }
  })
  // ARM THE KEY BEFORE ANYTHING GATED IS TOUCHED, and only fall back to the legacy notify if there
  // is no key to use `[owner]` `[manually verified]`.
  //
  // THE ORDER IS THE WHOLE OF IT. The legacy notify's CCCD is one of the six attributes the PIN
  // covers, so subscribing it first raises the browser's pairing dialog on EVERY connection to a
  // gated thermostat -- including one whose key we hold and whose broadcast we are decrypting
  // perfectly. Holding the key is admission enough, proven from the Python client against a
  // connection that had never paired (`../../../PROTOCOL.md`, "Sending a command encrypted").
  //
  // The sealed pair is NOT gated, by design, so this ordering makes a key-holder's connection touch
  // nothing the PIN covers. A device with no key in force does not answer the nonce request, sealing
  // does not arm, and the legacy subscribe runs as normal -- including raising the pairing dialog,
  // which is then the correct thing to do, because without a key pairing IS the way in.
  await withLink(l, async (io) => {
    await armSealing(l, io, d)
  })
  // **THE KEY QUESTION GOES HERE AND NOWHERE ELSE** — after the ungated probe has proved there is a
  // key to ask about, and before the first thing the PIN gate covers. A step earlier and it is asked
  // of the majority who have no key; a step later and a key-holder has already been shown a pairing
  // prompt, which is what asking before the chooser was protecting against.
  //
  // OUTSIDE THE WRITE QUEUE, deliberately: this waits on a person typing, and `armSealing` runs
  // holding the lock every other GATT call needs. `rearmSealing` takes that lock again for itself.
  if (l.unkeyedButSealed && askForKey) {
    const given = await askForKey(d)
    // **THE ONE THING PAUSING COSTS: the link can die while the sheet is open**, and then every step
    // after this fails with a GATT message about whichever service it happened to reach first —
    // "the radio's update service could not be opened" for a thermostat that simply hung up. Said
    // here, once, where the cause is known; it is thrown, and the Add row shows it beside a Try
    // again button.
    if (!server.connected) throw new Error('The thermostat hung up while that question was open.')
    if (given) {
      offerKey(given)
      await rearmSealing(l)
    }
  }
  await withLink(l, async (io) => {
    if (!l.sealKey) {
      // A FAILURE HERE IS NOT A FAILED CONNECTION, and treating it as one would throw away a link
      // that still sends perfectly well. On a Mac against a stock radio chip this is exactly what
      // happens — `caps.ts`, MAC_NOTIFY_HINT — so it is recorded and the connection carries on.
      //
      // THIS IS THE ONE PLACE THAT MAY RECORD IT, because it is the one connection that has no
      // other way to hear the thermostat: with no key, the legacy notify IS the reply channel. The
      // other callers subscribe to provoke a pairing dialog and are refused on purpose.
      jotai.set(repliesFor(l.id), await subscribeReplies(l, io))
    }
  })
  if (l.sealKey) {
    // Replies arrive on the sealed notify, subscribed above, so this connection has a reply channel
    // without the legacy one. Said in the log because "no legacy subscription" would otherwise look
    // like the failure it usually is.
    jotai.set(repliesFor(l.id), true)
    log('encrypted: using the sealed reply channel, so nothing the PIN covers is touched')
  }
  setState(l, 'connected')
  void introduce(l, server, d)
}

/**
 * Everything a fresh connection needs, ONE STEP AT A TIME, in this order.
 *
 * **IT IS A LIST BECAUSE THE ORDER IS THE WHOLE OF IT.** Fired off individually from the end of
 * `open()`, the sequence emerges from the queue rather than from anything a reader can see, and two
 * bugs came out of that: a read racing a write (`GATT operation failed for unknown reason`), and the
 * thermostat's version intermittently never arriving. Awaiting each step in turn costs nothing —
 * they are serialised either way — and it removes "what runs beside what" as a question.
 *
 * **EACH STEP TAKES THE QUEUE ITSELF**, which is why this function does not: `request()` serialises
 * internally, so one wrapper around the lot would deadlock on its own chain.
 *
 * Not awaited by `open()`: the UI goes live at `connected` and fills in as the answers land. A step
 * that fails is logged by the step, and the rest still run — none of them depends on the last.
 */
async function introduce(l: Link, server: BluetoothRemoteGATTServer, d: BluetoothDevice) {
  // The RADIO first: it is a plain read that needs no reply channel, so on a device whose replies
  // never arrive it is the only one of the two versions that can still answer.
  await step(l, 'the radio’s version', () => learnChipVersionRetrying(l, server))
  // **THE VERSION COMES BEFORE THE IDENTITY NOW, because its reply CARRIES half of the identity.**
  // `cmd 0x00` is stock's own command and answers on both firmwares, and its serial is the only
  // identifier a stock thermostat can give — so asking for the MAC first would decide who this
  // device is before the answer that names most of them had arrived.
  const serial = await step(l, 'which firmware it runs', () => learnFirmware(l))
  // WHO THIS THERMOSTAT IS, filed once from whatever it managed to say. Anything that wants to look
  // the device up waits for this: until it lands there is no row to file a key against or to open.
  await step(l, 'its access settings', () => identify(l, d, serial ?? null))
  // The clock, on every connection. `cmd 0x03`'s reply is a status, and the device pushes none of
  // its own `[manually verified]` — 15 s connected and running, nothing sent, zero frames — so this
  // is where the mode, setpoint, valve and flags come from.
  //
  // **It will start the adaptation phase if the thermostat was sitting on the date screen after
  // boot** `[owner]`.
  await step(l, 'the time', async () => {
    const r = await request(setDateTime(new Date()), isStatus, 1, l)
    if (r) setStatus(l, decodeStatus(r))
    return null
  })
  //
  // Whatever did not arrive, keep asking for. That covers the name too, which is why there is no
  // separate call for it: the chase's first round IS the first ask. Not awaited — it outlives this
  // function, and the UI fills in as the answers land.
  void step(l, 'the answer chase', () => chaseAnswers(l, server))
}

/**
 * ONE INTRODUCTION STEP — and a step that THROWS may not take the steps after it with it.
 *
 * **AN UNCAUGHT THROW HERE IS SILENT AND FATAL TO THE REST OF THE INTRODUCTION.** `open()` fires
 * `introduce` with `void`, so a rejection from any step becomes an unhandled promise rejection: the
 * steps below it never run, nothing is logged, and the screen shows a connected thermostat that has
 * answered some questions and not others — a firmware version filled in, the access settings and the
 * name greyed out with no reason anywhere, and no record but a console line.
 *
 * **IT DOES NOT RETRY AND IT DOES NOT FAIL THE CONNECTION.** Each step already decides for itself
 * how hard to try, and the link is up and useful whatever any of them answered — `chaseAnswers`
 * keeps asking until the device replies, and both the Install tab and the Status tab re-ask on
 * open. What this adds is the sentence saying it happened.
 */
async function step<T>(l: Link, what: string, run: () => Promise<T>): Promise<T | null> {
  try {
    return await run()
  } catch (e) {
    // NOT WHEN THE LINK IS SIMPLY GONE. A disconnect makes every operation in flight throw, and
    // saying "could not read X" four times about a thermostat that hung up names the wrong cause.
    if (!l.dead) log(`could not read ${what} — ${why(e)}`)
    return null
  }
}

/**
 * Ask the thermostat its own advertised name and put it on its row.
 *
 * **THIS IS THE ONLY THING THAT KNOWS THE NAME.** The browser's `device.name` is a stale cache (see
 * `fileRow`), so it is a seed for a row that has none and never an answer; the registry row is a
 * cache of THIS reply. One question, one authority, and the row is what every screen displays.
 *
 * **SILENCE IS AN ORDINARY ANSWER, and it is NOT recorded here** `[owner]`. A stock radio, and any
 * of our images from before the name command, answer nothing — and recording that is what makes the
 * row say "this needs a newer version of the radio firmware". That sentence is a VERDICT ON THE
 * RADIO, and one lost reply is not evidence for it: it was being printed against a radio reading 5.0
 * on a thermostat that was simply busy for a moment. Only `chaseAnswers` may record it, and only
 * after asking properly — see `NAME_ROUNDS`.
 *
 * → true when the device answered. False is "not this time", never "it cannot".
 */
export async function chaseAdvName(on: Link | null = active()): Promise<boolean> {
  if (!on) return false
  const r = await request(readAdvName(), isAdvName, DEFAULT_TRIES, on)
  if (on.dead) return false
  const got = r && decodeAdvName(r)
  if (!got) return false
  noteAdvName(got, on)
  return true
}

/**
 * Ask again for the access settings and file the answer, returning what arrived.
 *
 * A LOST REPLY LEAVES THE LAST ANSWER STANDING. Clearing it would not merely grey the switches out:
 * with nothing read, the PIN row states that the gate is OFF and anything in range can change this
 * thermostat — the opposite of the truth on a gated one.
 */
export async function refreshKeyStatus(
  on: Link | null = active(),
  tries = DEFAULT_TRIES,
): Promise<KeyStatus | null> {
  if (!on) return null
  const r = await request(KEY_STATUS, isKeyStatus, tries, on)
  const st = r && decodeKeyStatus(r)
  if (st) noteKeyStatus(st, on)
  return st || null
}

/** File a key-status reply a caller already has in hand — the switches answer with one. */
export function noteKeyStatus(st: KeyStatus, on: Link | null = active()) {
  if (on) jotai.set(keyStatusFor(on.id), st)
}

/**
 * Ask for every setting and file the answer. False when nothing came back.
 *
 * **READING THEM BACK NEEDS OUR FIRMWARE even though most of them are STOCK settings**: no stock
 * command reports any of these, which is why `cmd 0x16` exists. On an unmodified thermostat the
 * rows can still SEND and simply have nothing to show. A lost reply leaves the last answer standing.
 */
export async function refreshSettings(on: Link | null = active()): Promise<boolean> {
  if (!on) return false
  const r = await request(readSettings(), isSettings, DEFAULT_TRIES, on)
  const c = r && decodeSettings(r)
  if (c) jotai.set(settingsFor(on.id), c)
  return !!c
}

/** Ask for the advertising interval (`cmd 0x22`) and file the answer. False when nothing came back. */
export async function refreshAdvInterval(on: Link | null = active()): Promise<boolean> {
  if (!on) return false
  const r = await request(readAdvInterval(), isAdvInterval, DEFAULT_TRIES, on)
  const v = r && decodeAdvInterval(r)
  if (v) jotai.set(advIntervalFor(on.id), v)
  return !!v
}

/**
 * The connected thermostat has told us what it is called — put it everywhere that shows a name.
 *
 * **ONE WRITER, because there were two and they disagreed.** The connect-time chase above and the
 * Install tab's name row both learn this, at the only two moments it can be learnt, and each was
 * updating the registry itself. Two places deciding how a reply becomes a displayed name is two
 * places to forget the prefix in, or to update one of the copies and not the other — which is what
 * left the list showing a name the device no longer had.
 *
 * `aired` is applied HERE, once, for that reason: the row shows what a device chooser shows, the
 * radio adds the prefix, and the reply deliberately reports the owner's text without it.
 */
export function noteAdvName(got: AdvName | null, on: Link | null = active()) {
  if (!on) return
  jotai.set(advNameFor(on.id), got)
  // SILENCE AND A REFUSAL BOTH LEAVE EVERY NAME ALONE. A radio that cannot answer cannot be renamed
  // either, so whatever seeded the row is already right; and a refusal reports the name still in
  // force, which is not a name anybody just chose.
  if (!got || got.error) return
  const name = aired(got.name)
  jotai.set(deviceNameFor(on.id), name)
  // BY HANDLE, because `fileRow` has already pointed the row at this one and the handle is the only
  // thing known here without asking the device who it is a second time.
  const row = registry.byDeviceId(on.id)
  if (row && row.name !== name) registry.upsert({ ...row, name })
}

/**
 * The floor between chase rounds, measured from when the LAST one failed — not a period `[owner]`.
 *
 * The distinction is what stops it bombarding a thermostat that has stopped answering: a round that
 * gives up slowly (three attempts, each waiting out a reply timeout, or a GATT call that runs into
 * its 10 s bound) is followed by this pause, not by an immediate retry. So the slower the device is
 * to fail, the further apart the attempts are, which is the right way round.
 */
const CHASE_MS = 1000

/**
 * How many rounds the name is asked for before silence is taken as a verdict on the radio.
 *
 * Five, which at the spacing above is about a dozen seconds of genuinely asking. It is a chosen
 * number, not a measured one: long enough that a thermostat still settling after a connect answers
 * inside it, short enough that a radio that really is too old gets its explanation while somebody is
 * still looking at the row.
 */
const NAME_ROUNDS = 5

/**
 * KEEP ASKING UNTIL THE THERMOSTAT HAS ANSWERED — every question the connect path asks `[owner]`.
 *
 * **THE CONNECT PATH ASKS TOO EARLY, and that is not a fault to fix at the asking end.** The link is
 * up before the device is ready to talk: a thermostat that has just booted, one still finishing a
 * measurement, one whose radio is busy. So the first pass at any of these questions may simply get
 * nothing, and the only honest design is to ask again.
 *
 * **EVERY QUESTION, NOT JUST THE VERSIONS.** Asked once each on a too-early connection, the access
 * settings and the advertised name stay empty for the whole session on one lost reply — the Install
 * tab's rows greyed out, with the name row confidently announcing that the radio is too old to be
 * renamed — while the firmware version arrives a second later because it has this loop behind it.
 *
 * **ONE ATTEMPT EACH PER ROUND.** This loop is the retry; asking any of them to retry internally
 * would nest one retry loop inside another and stretch a round to seconds, so the spacing above
 * would describe nothing a person could observe.
 *
 * **AN INSTALL HOLDS IT OFF BY ITSELF, and there is deliberately no check for one here** `[owner]`.
 * A flash takes the queue for its whole transfer, so a chase round started during one simply waits
 * for it — the lock is the exclusion, and a `flashing` flag consulted here would be a second, worse
 * copy of it: one that can disagree, and that has to be got right at both ends. Waiting is also the
 * correct behaviour rather than merely a safe one, since an install is exactly the thing that
 * CHANGES the answer, so the round that lands afterwards asks a question worth asking.
 *
 * It stops when everything is known, and on the first round after the link goes: it holds the link
 * object, so a chase left running by a disconnect cannot ask the NEXT device the previous one's
 * question, or file its answer against it.
 */
async function chaseAnswers(l: Link, server: BluetoothRemoteGATTServer) {
  let nameRounds = 0
  while (!l.dead) {
    const needFw = jotai.get(fwVersionFor(l.id)) === null
    const needChip = jotai.get(chipVersionFor(l.id)) === null
    const needAccess = jotai.get(keyStatusFor(l.id)) === null
    const needName = jotai.get(advNameFor(l.id)) === undefined
    if (!needFw && !needChip && !needAccess && !needName) return
    if (needFw) {
      // **THE SERIAL RIDES ON THIS REPLY, so a lost one costs the IDENTITY as well as the version**
      // `[manually verified]`. Measured on a phone: an Add whose info reply went missing filed its
      // row under the MAC and no serial at all — harmless there, because a MAC is an identity too,
      // but on a STOCK thermostat the serial is the only one there is, and losing it means no row,
      // no Install tab and nothing to rescue the device with. So the chase re-files it.
      const serial = await learnFirmware(l, 1)
      if (serial) fileRow(l.device, { serial })
    }
    if (l.dead) return
    if (needChip) await learnChipVersionRetrying(l, server, 1)
    if (l.dead) return
    if (needAccess) await step(l, 'its access settings', () => refreshKeyStatus(l, 1))
    if (l.dead) return
    if (needName) {
      nameRounds++
      const got = await step(l, 'what it is called', () => chaseAdvName(l))
      // **THE ONLY PLACE ALLOWED TO RECORD SILENCE AS AN ANSWER**, and only once it has really
      // asked — see `chaseAdvName`. Everything before this leaves the row at "not asked yet", which
      // reads as waiting rather than as a fault.
      if (!got && nameRounds >= NAME_ROUNDS) {
        // SAID ONCE, WITH THE COMMAND IN IT. The row shows the verdict; the log has to show what was
        // actually asked, because "this radio is too old" and "its answer did not get through" put a
        // reader in completely different places and the row cannot tell them apart.
        complainOnce(
          l,
          'name',
          `asked this thermostat its name ${NAME_ROUNDS} times (cmd 0x5B) and no answer arrived`,
        )
        noteAdvName(null, l)
      }
    }
    if (l.dead) return
    await new Promise((r) => setTimeout(r, CHASE_MS))
  }
}

/**
 * Which door to talk through on this connection — the row's choice, or the sensible default.
 *
 * **THE DEFAULT IS THE ONLY PART THE APP DECIDES**: encrypted when a key is stored, the paired door
 * otherwise. A row that has chosen is obeyed either way, INCLUDING choosing the paired door with a
 * key stored — which is the case worth having, because the two are not interchangeable when something
 * is wrong. A key the device does not actually hold, a phone already bonded, a mismatch being
 * diagnosed: those are reasons to pick, and the app cannot see any of them.
 *
 * **Choosing the encrypted door without a key cannot conjure one.** `armSealing` finds no key and
 * says so, and the connection carries on through the paired door, which is the same path a row with
 * no preference takes.
 */
export function channelDefault(row: { key?: string; channel?: 'sealed' | 'plain' } | null) {
  return row?.channel ?? (row?.key ? 'sealed' : 'plain')
}

function channelFor(d: BluetoothDevice): 'sealed' | 'plain' {
  const row = registry.byDeviceId(d.id)
  // A device with no row yet is the one being ADDED. If a key was offered for it, the encrypted door
  // is what that key is for — and taking it means the first connection never touches the PIN gate.
  return channelDefault(row ?? (offeredKey ? { key: offeredKey } : null))
}

/**
 * A key for a thermostat this browser has not met yet, held only until it has.
 *
 * **IT EXISTS BECAUSE THE KEY AND THE IDENTITY ARRIVE IN THE WRONG ORDER.** A stored key is found by
 * the browser's handle for the device, and adding one starts with no row at all — so the first
 * connection could never arm encryption, and the app asked "do you have a key?" only after it had
 * already provoked a pairing prompt. Asked first, the answer has nowhere to live until the
 * thermostat says which thermostat it is, which is what this is.
 *
 * Cleared as soon as it is written onto a row, so it can never be applied to a second device.
 */
let offeredKey: string | null = null

/** Called with a whole key, or with nothing to clear a previous offer. */
export function offerKey(hex32: string | null) {
  offeredKey = hex32 && /^[0-9a-fA-F]{32}$/.test(hex32) ? hex32 : null
}

/**
 * Ask the person for a key — called ONLY when the thermostat itself has said it holds one.
 *
 * **THE APP DOES NOT ASK EVERYBODY, BECAUSE THE DEVICE CAN BE ASKED INSTEAD** `[owner]`. Opening Add
 * with "if this thermostat has an encryption key, put it in now" is a question about a feature most
 * thermostats do not have and that a new owner has no way to answer — but it has to be asked BEFORE
 * anything gated, because a key-holder asked afterwards has already been made to pair. "Ask first"
 * and "ask everybody" are not the same requirement, and `primeNonce` is what separates them: the
 * device answers it **if and only if it holds a key**, on a door the PIN gate does not cover, so the
 * probe is free, certain, and cannot raise a pairing prompt.
 *
 * Resolve with a 32-hex key to use the encrypted door, or with `null` to take the paired one. `null`
 * is an ordinary answer: somebody who does not hold the key can only pair, and somebody who does may
 * still prefer to.
 *
 * Returns a remover, so the React tree that installs it can take it away again. With none installed
 * the probe's answer is simply unused and the connection behaves as it did before.
 */
type KeyAsker = (d: BluetoothDevice) => Promise<string | null>
let askForKey: KeyAsker | null = null
export function installKeyAsker(fn: KeyAsker) {
  askForKey = fn
  return () => {
    if (askForKey === fn) askForKey = null
  }
}

/**
 * `W22` — put this connection on the SEALED door if all three things it needs are there.
 *
 * The three, and each one's absence is an ordinary outcome rather than a fault: this browser holds a
 * key for this thermostat, the radio has the sealed characteristic, and the DEVICE has a key in
 * force. Only the third can surprise you, and the nonce request is what settles it — the device
 * answers `0x56` if and only if it holds a key, so silence is a definite answer and not a timeout to
 * retry. **A radio that has just rebooted holds no key until the thermostat's first config frame
 * restores it**, which is exactly when a client would otherwise lock itself out of a device it could
 * still talk to.
 *
 * Falling back to plaintext when the DEVICE HOLDS NO KEY downgrades nothing: the legacy
 * characteristic is open either way, so there is no protection to lose. A WRONG key is different:
 * the nonce request succeeds, then the sealed write is refused at the ATT layer. `writeCommand`
 * reports the mismatch and keeps this connection on the sealed door; it does not hide the failure by
 * switching to plain commands.
 *
 * `unkeyedButSealed` is the probe's answer — this thermostat holds a key and this browser has none
 * for it. It is a field on the link rather than a return value because the question it decides has
 * to be ASKED outside the write queue: a sheet waits on a person, and this runs holding the lock
 * every other GATT call needs. `open()` reads it one step later.
 */
async function armSealing(l: Link, io: Io, d: BluetoothDevice) {
  l.sealKey = null
  l.session = null
  l.replyKey = null
  l.unkeyedButSealed = false
  // **ASK THE DEVICE BEFORE ASKING THE PERSON** — see `installKeyAsker`. Only for a thermostat with
  // no row, which is one being ADDED: a row that has met this browser before has already answered
  // the key question, and re-asking on every connect would be nagging rather than onboarding.
  //
  // The probe is `primeNonce`, and it cannot provoke a pairing prompt — see the header above.
  //
  // **A "NO" FROM THE PROBE IS NOT PROOF THERE IS NO KEY** `[manually verified]`, and the difference
  // matters because it decides whether anybody is asked. `primeNonce` returns false for three
  // different things: the device holds no key, its write did not get through, and its reply did not
  // arrive inside two seconds. Measured on a phone whose link had gone flaky after a dozen
  // connect/disconnect cycles — the probe said no while the device was airing an ENCRYPTED
  // broadcast a metre away, which is proof it held one.
  //
  // Left as it is, deliberately. A false no costs only the paired door, which is still a working way
  // in, and the row's Key button sets one afterwards; treating a silent probe as "probably has a
  // key" would put a key field in front of people who have none, which is what this exists to stop.
  // Retrying the probe is the fix if the false rate ever justifies it — the rate has not been
  // measured on a healthy link, where it has not yet been seen to happen.
  if (!registry.byDeviceId(d.id) && !offeredKey && l.encCh) {
    l.unkeyedButSealed = await primeNonce(l, io)
    // THE NONCE IS DROPPED AGAIN. It is a session, and holding one with no key to seal under is a
    // half-armed state: `writeCommand` tests for both, so nothing would go out sealed, but the next
    // reader of `session` should not have to know that.
    l.session = null
    return
  }
  // THE ROW'S CHOICE COMES FIRST, before the key is even looked for: preferring the paired door is a
  // decision to leave the encrypted one alone, whether or not a key is sitting there `[owner]`.
  if (channelFor(d) === 'plain') return
  // THE ROW IS FOUND BY THE BROWSER'S OWN HANDLE, NOT BY THE THERMOSTAT'S ADDRESS, and that is what
  // lets this run FIRST. Looking the key up by MAC would mean asking the device for its address, and
  // that question travels on the plaintext characteristic — which is precisely what the PIN gate
  // shuts. A gated thermostat would then never arm encryption, i.e. the app could not open the one
  // kind of device the sealed door exists for. `deviceId` is stored on the row the first time this
  // browser met the thermostat, and needs no round trip.
  //
  // **OR A KEY OFFERED FOR A THERMOSTAT THIS BROWSER HAS NEVER MET**, which is the only way a FIRST
  // connection can avoid pairing `[owner]`: the lookup above is by handle, and a device being added
  // has no row to find. `offerKey` is what the Add flow calls when the probe finds a key;
  // `identify` writes it onto the row once the thermostat says which one it is.
  const stored = registry.byDeviceId(d.id)?.key ?? offeredKey
  if (!stored) return // no key here: nothing to seal with, and nothing is wrong
  // CHECKED BEFORE IT IS USED, because the row can carry anything an import put there. A short or
  // non-hex value would become a plausible 16 bytes of nothing in particular and seal every command
  // with it — which the device drops silently, so it presents as a thermostat that stopped
  // answering rather than as a bad key.
  if (!/^[0-9a-fA-F]{32}$/.test(stored)) {
    log('the stored key for this thermostat is not 32 hex characters — commands go in the clear')
    return
  }
  if (!l.encCh) {
    log('this thermostat’s radio has no encrypted door — commands go in the clear')
    return
  }
  l.sealKey = unhex(stored)
  const ok = await primeNonce(l, io)
  if (ok) {
    log('commands are encrypted')
  } else {
    // The key stays loaded so REPLIES can still be opened if one ever arrives sealed; `writeCommand`
    // tests for the session nonce as well, so nothing goes out sealed without one.
    log('the thermostat holds no key right now — commands go in the clear')
  }
}

/**
 * **THE NEXT REPLY WILL BE SEALED UNDER A DIFFERENT KEY** — call this immediately before sending the
 * write that installs one, and with `null` afterwards.
 *
 * It affects OPENING only; the command itself still goes out under the key currently in force, which
 * is the one the radio will open it with. Getting that backwards seals the apply with a key the
 * device does not hold yet, and it is refused.
 *
 * **A CLEAR TAKES `null`, and expects NO REPLY AT ALL** `[binary]`: with no key left there is nothing
 * to seal the report under, so the radio drops it and the sealed door shuts. Silence is the
 * confirmation, and the reconnect that follows re-reads the state on the plain door anyway.
 *
 * Doing nothing here is not a broken key change — the key still lands. What is lost is the report
 * that says whether it landed, which is the whole reason the command answers at all.
 */
export function expectReplyUnderNewKey(hex32: string | null) {
  const l = active()
  if (l) l.replyKey = hex32 && /^[0-9a-fA-F]{32}$/.test(hex32) ? unhex(hex32) : null
}

/**
 * Take up whatever the row now says — its key, or its choice of door — on the open connection.
 *
 * **IT IS THE ONE PLACE THAT APPLIES A CHANNEL CHOICE**, which is why it also subscribes the legacy
 * notify when the answer is the paired door. The connect path subscribes only when it is not sealing,
 * so a connection that started sealed and is switched to plain would otherwise have no reply channel
 * at all: commands would go out and nothing would come back, which looks exactly like a thermostat
 * that has stopped answering.
 *
 * **NO ACCESS CHANGE ENDS THE LINK** `[owner]`, and each of the three has its own reason to look as
 * though it must:
 * - the **PIN gate** does not need one — it is enforced by the RADIO on the live link, with no
 *   disconnect at all `[manually verified]`: the moment the row lands the gated characteristics
 *   answer *Insufficient Authentication*, and the platform prompts to pair the moment the app
 *   touches one. Dropping the link cost a reconnect to change nothing;
 * - **unpair all** does not need one either, and a disconnect actively misleads: the phone keeps its
 *   own half of the pairing, so it will not re-prompt however the link ends. It finds out on its NEXT
 *   connection, which fails until the thermostat is forgotten on the phone as well;
 * - the **encryption key** was the one with a real problem behind it — the writes that install it go
 *   out sealed with the OLD key, the radio applies the NEW one, and every command after that is
 *   refused at the protocol level `[manually verified]`. That is what this fixes in place: the row
 *   has already been updated when this runs, so re-arming picks up the new key and the next command
 *   is sealed with it. Clearing a key re-arms to nothing, which is the plaintext path. Making the
 *   radio hang up instead would lose the reply that CONFIRMS the key was stored.
 */
export async function rearmSealing(on: Link | null = active()) {
  if (!on) return
  await withLink(on, async (io) => {
    await armSealing(on, io, on.device)
    // Sealing armed, so the sealed notify — subscribed at connect and never unsubscribed — carries
    // the replies. Otherwise the legacy one does, and it may not be subscribed yet.
    jotai.set(repliesFor(on.id), on.sealKey ? true : await subscribeReplies(on, io))
  })
}

/**
 * Ask for this connection's session nonce, and adopt it.
 *
 * STRICTLY A READ: nothing here draws a fresh one, which would also reset the device's replay
 * counter. It runs inside the write queue like every other write, and it holds that queue while it
 * waits — which is what makes everything queued behind it go out sealed rather than racing it.
 */
async function primeNonce(l: Link, io: Io): Promise<boolean> {
  if (!l.encCh) return false
  l.nonceInbox = null
  l.awaitingNonce = true
  try {
    await io.write(l.encCh, NONCE_REQUEST)
  } catch {
    l.awaitingNonce = false
    return false
  }
  try {
    for (let i = 0; i < 20; i++) {
      if (l.nonceInbox) {
        l.session = l.nonceInbox
        // Every per-connection counter restarts with the nonce. Carrying one across would judge the
        // first reply of this session against a counter from the last and drop a good frame.
        l.seq = 0
        l.frags = reassembler()
        return true
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    return false
  } finally {
    l.awaitingNonce = false
  }
}

/**
 * Ask the thermostat which firmware it is running — `cmd 0x00`, whose reply carries the version
 * byte: **200 on ours, 148 on stock** (`../../../PROTOCOL.md`, "Info reply").
 *
 * It is a STOCK command, which is the point: it answers on both images, so the app can tell them
 * apart before it knows anything else about the device. The BLE chip's own version is a separate
 * read and is not this — `learnChipVersion` asks the radio, and `device/caps.ts` says why the two
 * versions gate different things.
 *
 * @param tries how many attempts to make before returning. **The chase passes 1**, because it is
 * itself the retry loop and a round of three would make its own 1 s spacing meaningless: three
 * attempts at a reply timeout apiece is five seconds, so the gap the owner asked for would have
 * arrived as one attempt every six.
 */
async function learnFirmware(l: Link, tries = 3) {
  // MORE THAN ONE ATTEMPT ON THE CONNECT PATH `[owner]`: this goes out while a fresh connection is
  // still settling, and two attempts were enough on a quiet link and not on a busy one. Giving up
  // here is not final — `chaseAnswers` calls this again until it lands.
  const r = await request(GET_INFO, isInfo, tries, l)
  if (!r) complainOnce(l, 'fw', 'the thermostat did not answer when asked which firmware it runs')
  // NOT `setFw(null)` ON FAILURE. A version already known is still true: the device did not stop
  // running our firmware because one read was lost, and clearing it would grey out the Settings and
  // Display tabs on every hiccup — which is the whole defect this is part of fixing.
  if (!r) return null
  setFw(l, r[1] ?? null)
  // THE SAME REPLY CARRIES THE SERIAL, so it is returned rather than asked for again — `introduce`
  // needs it to identify the device, and on a stock thermostat it is the only identifier there is.
  return serialOf(r)
}

/**
 * Say something once per connection, however many times the caller fails.
 *
 * The version chase retries until it succeeds, so an unconditional `log` on failure would fill the
 * log with the same line every second and bury whatever else is in there. It is a set ON THE LINK,
 * so the next connection is allowed to say it again — and it should, since it is a different device
 * or a different attempt at the same one.
 */
function complainOnce(l: Link, key: string, message: string) {
  if (l.complained.has(key)) return
  l.complained.add(key)
  log(message)
}

/**
 * Subscribe to the thermostat's replies, and record whether it worked.
 *
 * Separate from `open()` so it can be RETRIED, which is the whole of `W25`'s second half: a gated
 * thermostat refuses this subscribe, and once somebody has paired the link is perfectly good with
 * only this missing. Reconnecting would also fix it and is the worse answer — it throws away a link
 * that has just been authenticated.
 */
async function subscribeReplies(l: Link, io: Io): Promise<boolean> {
  if (!l.notifyCh) return false
  try {
    await io.subscribe(l.notifyCh)
    // Removed first, because this can run twice: a listener added twice delivers every frame twice,
    // and for the reassembly state machine that is not a duplicate but a desynchronised stream.
    l.notifyCh.removeEventListener('characteristicvaluechanged', l.onNotify)
    l.notifyCh.addEventListener('characteristicvaluechanged', l.onNotify)
    jotai.set(repliesFor(l.id), true)
    return true
  } catch {
    // IT REPORTS, IT DOES NOT PUBLISH A VERDICT. Succeeding always means replies arrive, so the
    // `true` above is safe from any caller — but FAILING means different things depending on who
    // asked, and only the connect path knows. Two of the three callers use this as a PAIRING PROBE
    // and expect to be refused: `provokePairing` calls it four times on purpose, to raise the
    // platform's dialog. Published as a verdict, those refusals announce "the thermostat's answers
    // do not reach this browser" about a sealed link whose answers are arriving perfectly on the
    // encrypted channel, and put the pairing invitation on the Status tab of a working device.
    return false
  }
}

/**
 * `W25` — ask the platform to pair, by doing the one thing that makes it ask.
 *
 * **THERE IS NO PAIRING CALL IN WEB BLUETOOTH** `[external]`: `BluetoothDevice` is `id`, `name`,
 * `gatt`, `watchAdvertisements()` and `forget()`, and nothing else. **Pairing is PROVOKED, not
 * requested** — the platform raises its own dialog when the page touches an attribute that demands
 * authentication. So this writes an ordinary command and lets that happen. If a later reader goes
 * looking for the pairing API because of the button's name, this is the paragraph that saves them.
 *
 * **`cmd 0x00` ON THE COMMAND CHARACTERISTIC, NEVER THE RADIO'S UPDATE ONE** `[owner]`. Both are
 * gated, so either would raise the prompt — but the update control point has side effects (`02`
 * begins a download, `01` prepares one), and provoking a dialog is no reason to leave a radio
 * mid-transfer. `cmd 0x00` changes nothing, and its reply is the version we want next anyway.
 *
 * **THE SUBSCRIBE MUST BE RETRIED AFTERWARDS.** It was refused at connect for the same reason, and
 * pairing does not retroactively deliver it — without this the thermostat is reachable and still
 * silent, which looks exactly like the failure the button was pressed to fix.
 *
 * → true when replies are flowing afterwards. **False is not "no prompt appeared"** — nothing reports
 * that — it is only "still not working", which is all this can honestly claim.
 */
export async function provokePairing(): Promise<boolean> {
  const l = active()
  if (!l?.cmdCh) return false
  log('asking the thermostat for something it protects — your phone should ask for its PIN')
  // EACH STEP TAKES THE QUEUE, and separately rather than once around all three, because the third
  // is `request()` — which takes the queue itself, so wrapping the lot would deadlock on its own
  // chain. They need it at all because Android allows one GATT operation outstanding of ANY kind
  // (see `learnChipVersion`), so a write or a subscribe issued beside the connection's own opening
  // traffic fails with an error that names nothing.
  try {
    // The write is what raises the dialog. It may reject because the platform refused it or because
    // the person dismissed the prompt, and those are not distinguishable from here.
    await withLink(l, (io) => writePlain(l, io, GET_INFO))
  } catch {
    /* expected while unpaired: the point was to make the platform ask, not to succeed */
  }
  if (!(await withLink(l, (io) => subscribeReplies(l, io)))) return false
  const r = await request(GET_INFO, isInfo, 2, l)
  if (!r) return false
  setFw(l, r[1] ?? null)
  log('paired — the thermostat is answering')
  return true
}

/**
 * Get this connection ready to INSTALL firmware, and say whether it is.
 *
 * **PAIRING HAS TO HAPPEN BEFORE THE TRANSFER, NOT DURING IT** `[owner]` `[manually verified]`. An
 * install that hits the pairing dialog on its own first write makes ZERO progress: the thermostat
 * enters its bootloader, the phone puts up a dialog, and the transfer times out with the device
 * rebooting into what it started with. Both update paths are protected — the thermostat's runs over
 * the plain command characteristic, and the radio's over its own update attributes — so an
 * encryption key does NOT open either. Pairing is the only way in, and it is a step of its own.
 *
 * **AND THE RADIO'S HALF IS RE-CHECKED AFTERWARDS.** Whether its update service can be opened is
 * decided at connect, when a protected attribute may still have been refused; without this the app
 * would report a perfectly flashable radio as unreachable for the rest of the connection, which is
 * exactly the message the owner met.
 *
 * → true when the protected path answers. False means still not reachable, and the caller should
 * say so and offer to try again rather than starting a transfer that cannot finish.
 */
export async function prepareForFlash(): Promise<{ paired: boolean; radioReady: boolean }> {
  // Captured here rather than read again inside the queued closure: by the time that runs the link
  // may have been torn down by a disconnect, and this is the server the caller asked about.
  const l = active()
  const server = l?.device.gatt
  if (!l || !server?.connected) return { paired: false, radioReady: false }
  // THE PROBE IS A SUBSCRIBE, NOT A QUESTION `[owner]` `[manually verified]`. Asking the thermostat
  // for its version and reading silence as "not paired" is wrong in exactly the state that most
  // needs flashing: a device left in its bootloader by an interrupted transfer answers no commands
  // at all, so a perfectly paired phone is told to go and pair, with no way forward. Subscribing
  // writes the notify CCCD, which the PIN protects just the same, so it answers the only question
  // here -- will this link accept a protected write -- and it needs the device to say nothing. It is
  // required for the transfer anyway, so it is setup done early rather than a probe with side
  // effects.
  //
  // RETRIED, because the first attempt is what RAISES the platform's dialog and is refused while a
  // person is still reading it. ONE LOCK AROUND THE WHOLE SEQUENCE, not one per step, so nothing can
  // be interleaved between the subscribe and the read that depends on it.
  return withLink(l, async (io) => {
    let paired = false
    for (let i = 0; i < 4 && !paired; i++) {
      if (i) await new Promise((r) => setTimeout(r, 2000))
      paired = await subscribeReplies(l, io)
    }
    if (!paired) return { paired: false, radioReady: false }
    try {
      // RE-READ AFTER PAIRING, not before — see the header.
      await learnChipVersion(l, io, server)
    } catch {
      /* it reports itself through radioFlashableFor, which is what is returned below */
    }
    return { paired: true, radioReady: jotai.get(radioFlashableFor(l.id)) }
  })
}

/**
 * Ask the RADIO chip which image it is running — the WS-OTA app-info record, a plain GATT read. A
 * stock radio answers it just as readily as ours, which is the whole reason this is the instrument;
 * see `protocol.ts` and `caps.ts`.
 *
 * **IT MUST BE CALLED INSIDE `serialise()`**, and it does not take the queue itself because one of
 * its two callers (`prepareForFlash`) already holds it — a loop that took the queue would deadlock
 * against its own chain. Running it outside on the reasoning that a READ cannot contend for the
 * single WRITE in flight is wrong on Android, whose stack allows one operation of ANY kind at a
 * time: the read failed on every connection there while the identical read from a laptop succeeded.
 *
 * ONE ATTEMPT. It returns whether the version arrived, so `retrying` can stop as soon as it has.
 */
async function learnChipVersion(
  l: Link,
  io: Io,
  server: BluetoothRemoteGATTServer,
): Promise<true | null> {
  let svc: BluetoothRemoteGATTService
  try {
    svc = await io.service(server, OTA_SVC)
  } catch (e) {
    // The version already read is left alone — see the catch below for why. What DOES go is the
    // flash pair, because those are handles this connection is holding and a service that would not
    // open has not given us any.
    setRadioFlashable(l, false, `the radio's update service could not be opened (${why(e)})`)
    l.chipWhy = why(e)
    return null
  }
  // TWO INDEPENDENT ATTEMPTS ON ONE SERVICE, and separating them is the point: the version and the
  // flash pair are different questions, and letting one failure answer both is how "we cannot flash
  // this radio" came to be reported for a device whose flash characteristics were sitting right
  // there. They are neighbours in the table, not a package.
  // RETRIED, LIKE EVERY OTHER QUESTION THIS APP ASKS A DEVICE `[owner]`. On a single shot, one
  // transient failure leaves the version null for the whole connection; a read is no more reliable
  // than a write and this one is on the same wire. The loop is the CALLER's (`retrying`), so the
  // gaps happen with the wire free.
  let got: true | null = null
  try {
    const raw = await io.read(await io.characteristic(svc, APP_INFO_CH))
    const v = parseAppInfo(raw)
    setChip(l, v)
    // SAY WHY WHEN IT COMES BACK EMPTY. The top bar can only show "radio —", which does not separate
    // a record that was unreadable, too short, or simply not there. A dash is a question; the log
    // holds the answer.
    if (!v) log(`firmware: the radio's version record is ${raw.byteLength} bytes, too short to read`)
    // A RECORD THAT ARRIVED IS AN ANSWER, even a short one: asking again cannot lengthen it, so a
    // successful read ends the retries and only a THROWN read is worth repeating.
    got = true
    l.chipWhy = null
  } catch (e) {
    // NOT `setChip(null)` — same reason `learnFirmware` does not clear its version. The only thing
    // that DOES change it is an install, and that drops the link, which clears both versions.
    l.chipWhy = why(e)
  }
  // Held rather than fetched at flash time, so the Install screen can say up front whether this
  // radio is flashable instead of finding out mid-transfer.
  try {
    l.otaCtl = await io.characteristic(svc, OTA_CONTROL_CH)
    l.otaData = await io.characteristic(svc, OTA_DATA_CH)
    setRadioFlashable(l, true)
  } catch (e) {
    l.otaCtl = null
    l.otaData = null
    setRadioFlashable(l, false, `the radio's update characteristics are missing (${why(e)})`)
  }
  return got
}

/**
 * The retrying form — every caller that is not already holding the queue wants this one.
 *
 * `l.chipWhy` is why the last attempt failed. It is held on the link rather than logged on the spot
 * so that a failure which the NEXT attempt fixes says nothing at all: three lines of "could not read
 * the radio's version" for a version that then arrived is noise that reads as a fault.
 */
async function learnChipVersionRetrying(l: Link, server: BluetoothRemoteGATTServer, tries = 3) {
  const got = await retrying(l, tries, () => withLink(l, (io) => learnChipVersion(l, io, server)))
  // Once per connection: `chaseAnswers` keeps calling this until it lands.
  if (!got && l.chipWhy)
    complainOnce(l, 'chip', `firmware: could not read the radio's version (${l.chipWhy})`)
}

const why = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * Whether this connection could flash the radio.
 *
 * **AN ATOM, NOT A GETTER.** The characteristics are fetched asynchronously after `connected` is
 * announced, so a screen that has already rendered needs a reason to look again — a function reading
 * module state gives it none, and the screen goes on saying "this connection cannot reach the
 * radio's update service" about a device that is perfectly flashable.
 */
export const radioFlashableFor = atomFamily((_id: string) => atom(false))
export const radioFlashableAtom = atom((get) => {
  const id = get(activeIdAtom)
  return id ? get(radioFlashableFor(id)) : false
})

function setRadioFlashable(l: Link, ok: boolean, reason?: string) {
  jotai.set(radioFlashableFor(l.id), ok)
  // SAID ONCE, IN THE LOG, because "cannot reach it" is not a diagnosis. A radio that genuinely has
  // no update service and a service discovery that failed look identical on screen otherwise.
  if (!ok && reason) log(`firmware: ${reason}`)
}

/**
 * ONE LINK IS OVER — everything that belonged to it goes, and nothing else is touched.
 *
 * **IT IS `dead` THAT RETIRES THE WORK, not a counter** — this is the one place that sets it, and
 * the `W30` header says what every loop does with it.
 *
 * Reached twice for one drop is harmless and does happen: `disconnect()` calls it after asking the
 * browser to hang up, and the platform's own event may follow.
 */
function tearDown(l: Link) {
  if (l.dead) return
  l.dead = true
  if (links.get(l.id) === l) {
    links.delete(l.id)
    jotai.set(linkIdsAtom, [...links.keys()])
  }
  l.device.removeEventListener('gattserverdisconnected', l.onDrop)
  // EVERY LISTENER THIS LINK PUT ON A CHARACTERISTIC COMES OFF HERE. The characteristic objects
  // outlive the connection, so one left behind delivers this link's frames into a dead link on
  // every future connection to the same thermostat — and there is one more of them after every
  // reconnect.
  l.encNotify?.removeEventListener('characteristicvaluechanged', l.onNotify)
  l.notifyCh?.removeEventListener('characteristicvaluechanged', l.onNotify)
  l.otaCtl?.removeEventListener('characteristicvaluechanged', l.onOtaStatus)
  l.encNotify = null
  // THE QUEUE DOES NOT OUTLIVE THE LINK. It orders operations on ONE connection, so carrying it
  // across a disconnect can only inherit that connection's problems — and if an operation on the
  // old link never settles, everything queued behind it waits for a device that is gone. Dropping
  // the chain here is what makes reconnecting a real fix rather than something that happens to work
  // once the browser gets round to rejecting the stuck call.
  l.queue = Promise.resolve()
  l.cmdCh = null
  // W22: EVERY PIECE OF SEALED STATE IS PER-CONNECTION and none of it may survive one — see the
  // sealed-door block in `Link`. A carried-over nonce also opens nothing at all.
  l.encCh = null
  l.otaCtl = null
  l.otaData = null
  l.notifyCh = null
  jotai.set(radioFlashableFor(l.id), false) // a link that is gone can flash nothing
  l.flashing = false
  l.framesPending = []
  l.sealKey = null
  l.replyKey = null
  l.session = null
  l.seq = 0
  l.frags = reassembler()
  l.awaitingNonce = false
  l.nonceInbox = null
  l.keyRefusals = 0
  // Every waiter is now unanswerable. Resolving them null rather than leaving them pending means a
  // caller awaiting one gets its ordinary "no reply" path instead of hanging until the tab closes.
  for (const w of l.waiters) w.resolve(null)
  l.waiters = []
  setFw(l, null) // a stale version would gate the app on a device that is no longer there
  setChip(l, null)
  setStatus(l, null) // and a stale status would show a departed device's setpoint as current
  setState(l, 'disconnected')
}

/**
 * Hang up on one thermostat — the open one by default, or whichever handle a caller names.
 *
 * **NOTHING DOES THIS BY ITSELF** (`W30`): a connection survives walking back to the list and into
 * another radiator, so the only things that end one are this button, the device, and closing the
 * page.
 *
 * It also CANCELS an attempt that has not connected yet, which is the `waiting` state: pressing
 * Disconnect on a row that says "Searching…" has to stop the search, not wait out its whole window.
 */
export function disconnect(id: string | null = jotai.get(activeIdAtom)) {
  if (!id) return
  // The made-up thermostat has no `Link` to tear down — `openTestDevice` fills the atoms directly —
  // so hanging up on it is putting those back. Without this its Disconnect button does nothing,
  // which is the one state `?test=1` cannot otherwise be walked through.
  if (TEST_MODE) {
    jotai.set(
      linkIdsAtom,
      jotai.get(linkIdsAtom).filter((x) => x !== id),
    )
    setState({ id, device: null }, 'disconnected')
    return
  }
  const attempt = opening.get(id)
  if (attempt) attempt.stop.asked = true
  const l = links.get(id)
  if (!l) return
  l.device.gatt?.disconnect()
  tearDown(l)
}

/** The open thermostat's browser handle, for a caller that needs to read its saved row. */
export function deviceId(): string | null {
  return active()?.id ?? null
}

/**
 * The registry row for whatever just connected, WAITED FOR rather than looked up once.
 *
 * **CONNECTING RESOLVES BEFORE THE THERMOSTAT HAS SAID WHO IT IS** `[manually verified]`. The link
 * is up at that moment, but the address arrives afterwards, from a command the introduction sends
 * that `open()` deliberately does not await — the UI goes live and fills in. So every caller that
 * needs the ROW rather than the link has to wait for it, and looking immediately finds nothing on a
 * perfectly good connection: measured twice on a phone, once as an Add that succeeded while logging
 * "that thermostat did not report its address" in the same second the row appeared, and once as a
 * chooser that connected, filed the row and then sat on the list instead of opening it.
 *
 * Null means it really did not answer — a stock thermostat cannot, and ours cannot when its replies
 * are not getting through. That is a fact worth reporting, which is why this returns rather than
 * throwing, and why five seconds is generous: the alternative is calling a working device silent.
 */
const ROW_WAIT_MS = 250
const ROW_TRIES = 20
export async function settledRow(id: string | null = deviceId()): Promise<Thermostat | null> {
  if (!id) return null
  for (let i = 0; i < ROW_TRIES; i++) {
    const row = registry.byDeviceId(id)
    if (row) return row
    await new Promise((r) => setTimeout(r, ROW_WAIT_MS))
  }
  return registry.byDeviceId(id)
}

/* ================================================================================================
 * W14 — THE TWO FLASH DRIVERS
 * ================================================================================================
 * `flash.ts` owns the protocol: what the frames are, what a verdict means, what the CRC is. This
 * owns the WRITES, and it lives here for the reason everything else does — the characteristics are
 * module-private, and a component that could reach one could pipeline it.
 *
 * **BOTH DRIVERS TAKE THE WRITE QUEUE FOR THE WHOLE TRANSFER**, not per chunk. A flash is thousands
 * of writes that must not be interleaved with anything, and half a status read landing between two
 * chunks is a desynchronised stream, not a slow one. So each runs inside a single `serialise` and
 * everything else waits — which is right: there is nothing else worth doing to a device mid-flash.
 *
 * **PROGRESS IS REPORTED, NEVER ESTIMATED.** `onProgress` is given bytes done and bytes total and
 * nothing else. The page must not turn that into a time: the achieved rate varies about twofold
 * between runs of the same code on the same phone (`flashThermostat`), so any duration it displayed
 * would be invented.
 */

/** How a driver says where it got to. `done`/`total` are bytes; `note` is for the log, not the bar. */
export type FlashProgress = (done: number, total: number, note?: string) => void

/** Chunk retries before giving up, matching `flash_mcu.py`. A NACK is ordinary; a run of them is not. */
const CHUNK_RETRIES = 3

/* ---- the frame inbox a flash reads from ---------------------------------------------------------
 * Ordinary commands match a reply by PREDICATE, because several producers share the link and each
 * has to pick out its own answer. A flash is the opposite: it owns the link for the whole transfer
 * and wants the NEXT frame, whatever it is, so it can judge it itself — a verdict that does not match
 * has to be ignored explicitly rather than waited past. Hence a queue rather than a matcher.
 *
 * It only collects while a flash is running, or every notification of an ordinary session would pile
 * up in it for ever.
 */
function pushFrame(l: Link, b: Uint8Array) {
  if (l.frameWaiter) {
    const w = l.frameWaiter
    l.frameWaiter = null
    w(b)
  } else l.framesPending.push(b)
}

/** Forget anything already queued — what a chunk does before it sends, so a stale reply cannot count. */
function drain(l: Link) {
  l.framesPending = []
}

/** The next frame, or null if none arrives in time. */
function collect(l: Link, ms: number): Promise<Uint8Array | null> {
  const queued = l.framesPending.shift()
  if (queued) return Promise.resolve(queued)
  return new Promise((resolve) => {
    l.frameWaiter = resolve
    setTimeout(() => {
      if (l.frameWaiter === resolve) {
        l.frameWaiter = null
        resolve(null)
      }
    }, ms)
  })
}

/**
 * Write one frame to the thermostat IN THE CLEAR, whatever this connection is otherwise doing.
 *
 * **A FLASH IS NEVER SEALED, and that is not a shortcut.** Two reasons, and the second is fatal
 * rather than slow. The bootloader is reached through the radio's relay, which unwraps sealing, so
 * encrypting would be invisible to it — but a chunk packet is sixteen inner bytes, and sixteen does
 * not fit beside a sealed header in one write. Every packet would become the three-write staging
 * dance, in a protocol that bursts its packets back to back with no per-packet acknowledgement. That
 * changes the timing of the one thing here that must not be re-timed. The plaintext characteristic
 * is never gated by a key, so it is always available for this.
 */
async function writePlain(l: Link, io: Io, bytes: ArrayLike<number>) {
  if (!l.cmdCh) throw new Error('not connected')
  await io.write(l.cmdCh, bytes)
}

/**
 * WHY THE THERMOSTAT'S HALF TAKES MINUTES: THE CONNECTION INTERVAL, AND NOTHING ELSE `[owner]`.
 *
 * The payload is 34816 B in 236 chunks and 2588 sixteen-byte packets. **THE DEVICE ANSWERS EVERY
 * PACKET, not every chunk** `[manually verified]` -- a Python OTA logged 2588 acknowledgements for
 * those 2588 packets. The 9600-baud wire beneath it, 43 s for these bytes, is never the limit.
 *
 * **THE INTERVAL IS NOT SPENT ONCE PER PACKET, so the figures below may not be read as one round
 * trip each** `[manually verified]`. Measured on this Mac: that same payload transferred in 60.7 s,
 * which is 23.5 ms a packet -- less than half the 52 ms interval below. `../../../python-scripts/flash_mcu.py`
 * bursts a chunk's packets and reads one reply per chunk, so the device's acknowledgements come back
 * without the host waiting on each. What sets the pace between the interval and the wire is not
 * settled, and the radio figures below have not been re-measured against it.
 *
 * Measured with an ammeter, reading the interval straight off the radio's current spikes -- the
 * method checked against a known number first, autocorrelating idle advertising at 1018 ms where
 * the firmware sets 1022.5:
 *
 *   this Mac, both halves     52 ms interval    thermostat 60.7 s (one run), radio 158 s
 *   an Android phone          ~77 ms implied    thermostat 400 s (154 ms per packet)
 *   an Android phone, radio   much faster       radio 45 s
 *
 * **THE PLATFORM CHOOSES IT, AND THE TWO CHOOSE DIFFERENTLY IN BOTH DIRECTIONS.** macOS holds one
 * interval for everything: measured at 52 ms during BOTH transfers, so it beats Android on the
 * thermostat and loses badly on the radio. Android's default is slower, but it GRANTS the radio's
 * request for fast connection parameters (`bleprofile_SendConnParamUpdateReq` is in that ROM), which
 * is the 45 s. macOS ignores that request -- same 52 ms in the radio phase as in the thermostat's.
 * Run to run on one host varies too, by about 25 % for the same transfer, so one run is a reading
 * and not a figure to quote to a person.
 *
 * **THE APP HAS NO LEVER HERE, and an earlier reading of this said the wrong thing twice.** It
 * claimed the protocol acknowledged only chunks, so unacknowledged writes would help -- they cannot,
 * because the device answers each packet. And it proposed adding the WRITE_NO_RESPONSE property and
 * a WRITE_CMD permission: pointless, since a device runs the OLD image while being upgraded, so a
 * faster path in ours never applies to a first install onto a stock thermostat. Web Bluetooth cannot
 * ask for a connection interval at all.
 *
 * **THE RADIO HANDS ITS THERMOSTAT LINE TO ITS IDLE PATH** rather than holding it inside each GATT
 * write callback, so it adds nothing of its own to the round trip above and the interval is the
 * whole story. Details: `ble_chip/analysis/FINDINGS.md`.
 */

/** Write to the radio's OTA control point and wait for the one-byte status it notifies back. */
async function otaControl(
  l: Link,
  io: Io,
  frame: ArrayLike<number>,
  ms = 10_000,
): Promise<number | undefined> {
  if (!l.otaCtl) throw new Error('this radio has no OTA control point')
  drain(l)
  await io.write(l.otaCtl, frame)
  const r = await collect(l, ms)
  return r?.[0]
}

/**
 * Flash the THERMOSTAT, chunk at a time, over the ordinary command characteristic.
 *
 * `cmd 0xa0` leaves the application for the bootloader; from then on the device answers only this
 * protocol, so the flow is committed until it reboots. Each chunk goes out as a burst of
 * `a1 <seq> <14 bytes>` writes with NO per-packet wait of ours — that is the protocol, not an
 * optimisation — and only the CHUNK gets a verdict frame back. (The device does answer every packet
 * underneath that; see the connection-interval block above `otaControl` for what that costs.)
 *
 * **STALE FRAMES ARE DRAINED BEFORE THE FIRST CHUNK.** An aborted earlier transfer leaves replies in
 * flight, and one arriving mid-stream is read as this chunk's verdict; every later chunk is then
 * judged by its predecessor's reply and the stream desyncs into NACKs no retry can clear. That is
 * reachable by an ordinary user — an OTA that dies mid-way is a thing that happens — and it presents
 * as a device that is bricked when it is perfectly healthy.
 *
 * Returns when the device says `a1 44` (finished). It then reboots on its own, which drops the link
 * from the thermostat's side only; the radio the connection actually terminates on is untouched.
 */
export function flashThermostat(payload: Uint8Array, onProgress: FlashProgress): Promise<void> {
  const l = active()
  if (!l) return Promise.reject(new Error('not connected'))
  // THE LOCK IS TAKEN ONCE, FOR THE WHOLE TRANSFER — the `W14` header and `Io` say why.
  return withLink(l, async (io) => {
    if (!l.cmdCh) throw new Error('not connected')
    const chunks = parseChunks(payload)
    if (!chunks.length) throw new Error('that payload has no chunks in it — is it the right file?')

    l.flashing = true
    try {
    drain(l)
    onProgress(0, payload.length, 'asking the thermostat to enter its bootloader')
    // ASKED MORE THAN ONCE, because an INTERRUPTED transfer is a state a person can reach `[owner]`:
    // a thermostat still sitting in its bootloader from a previous run is exactly the device that
    // needs this to work, and on a single attempt one unanswered request ends the whole thing. It
    // also times out and reboots on its own, so a few tries spread over half a minute cover both the
    // device that answers late and the one that is about to come back.
    let entered = false
    for (let attempt = 0; attempt < 3 && !entered; attempt++) {
      await writePlain(l, io, ENTER_OTA)
      for (const deadline = Date.now() + 10_000; Date.now() < deadline; ) {
        const r = await collect(l, 10_000)
        if (!r) break
        if (isOtaMode(r)) { entered = true; break }
      }
    }
    if (!entered) {
      throw new Error(
        'the thermostat did not answer the request to enter its bootloader. If a previous attempt ' +
          'was interrupted it may still be in there and busy — it gives up and restarts by itself ' +
          'after a minute or two, so wait for its display to come back and try again.',
      )
    }

    // Drain whatever an aborted earlier transfer left in flight, so it cannot be taken for a verdict.
    for (;;) if (!(await collect(l, 2000))) break

    // TIMED FROM THE FIRST CHUNK, so the achieved rate can be READ rather than guessed at. One run
    // measured 87 B/s and the next was about twice that, on the same code and the same phone
    // `[owner]`, and we have no explanation -- the write mode is identical and the flash order puts
    // this half on a fresh connection. Two numbers per run in the log is what turns that into
    // something answerable instead of an impression.
    const began = Date.now()
    let sent = 0
    for (const [i, chunk] of chunks.entries()) {
      let ok = false
      for (let attempt = 0; attempt <= CHUNK_RETRIES && !ok; attempt++) {
        drain(l)
        // A FAILED WRITE RETRIES THE CHUNK; IT DOES NOT END THE TRANSFER `[owner]`. A run died on
        // "GATT operation failed for unknown reason" part-way through: let out of this function, a
        // single refused write throws away everything already delivered and leaves the thermostat in
        // its bootloader. Re-sending a chunk is already safe, since the device is asked for a verdict
        // on each one.
        try {
          for (const pkt of chunkPackets(chunk)) await writePlain(l, io, pkt)
        } catch (e) {
          log(`firmware: a write failed on chunk ${i} (${why(e)}) — resending it`)
          await new Promise((r) => setTimeout(r, 300))
          continue
        }
        // Only a1 22 / a1 33 / a1 44 is an answer to THIS chunk; anything else is ignored and we
        // keep listening, which is what `chunkVerdict` returning null means.
        for (;;) {
          const r = await collect(l, 10_000)
          if (!r) break // nothing more is coming; fall through to the retry
          const v = chunkVerdict(r)
          if (v === 'ok') { ok = true; break }
          if (v === 'finished') {
            // The usual ending, so it carries the timing too -- the other one is the fallback.
            log(
              `firmware: thermostat ${payload.length} B in ` +
                `${Math.round((Date.now() - began) / 1000)} s ` +
                `(${Math.round(payload.length / ((Date.now() - began) / 1000))} B/s)`,
            )
            onProgress(payload.length, payload.length, 'the thermostat has the whole image')
            return
          }
          if (v === 'nack') break // retry this chunk
        }
      }
      if (!ok) throw new Error(`the thermostat refused chunk ${i + 1} of ${chunks.length}`)
      sent += chunk.length
      onProgress(sent, payload.length)
    }
    // Every chunk went and no `a1 44` came. The device usually reboots anyway on the last one, so
    // this is reported rather than called a failure — the version read afterwards is what decides.
    log(
      `firmware: thermostat ${payload.length} B in ${Math.round((Date.now() - began) / 1000)} s ` +
        `(${Math.round(payload.length / ((Date.now() - began) / 1000))} B/s)`,
    )
    onProgress(payload.length, payload.length, 'all chunks delivered; waiting for it to restart')
    } finally {
      // **THE FLAG AND THE INBOX BELONG TO THIS LINK, so clearing them is unconditional.** A new
      // link is a new object, so there is nothing of anybody else's here to clear. Held module-wide
      // they would not be: this transfer can still be unwinding — its reply wait alone can be parked
      // for ten seconds — while a transfer on a NEW link is under way, and the clear would turn off
      // that run's frame routing and empty its inbox, presenting as a fresh transfer refused at its
      // first chunk on a perfectly healthy thermostat.
      l.flashing = false
      drain(l)
    }
  })
}

/**
 * Flash the RADIO, over the WICED OTA pair in the same service the version record lives in.
 *
 * prepare `01 <len16>` → start `02` → the image, twenty bytes at a time → verify `03 <crc32>`.
 * Each control write is answered by a one-byte status on the control point itself.
 *
 * **THE LINK USUALLY DIES AT THE VERIFY STEP, AND THAT IS THE SUCCESS PATH** — the chip verifies,
 * applies and reboots, which drops the connection before a status can come back. So a disconnect
 * there is not an error and must not be reported as one; `flash.ts`'s `VERIFY_DROP_MEANS` is the
 * sentence for it. What settles it is reading the version back afterwards, on a new connection.
 */
export function flashRadio(image: Uint8Array, onProgress: FlashProgress): Promise<void> {
  const l = active()
  if (!l) return Promise.reject(new Error('not connected'))
  return withLink(l, async (io) => {
    const ctl = l.otaCtl
    if (!ctl || !l.otaData) {
      throw new Error('this radio has no OTA service — it is not one this app can flash')
    }
    const say = (s: number | undefined) => WS_STATUS[s ?? -1] ?? `status ${s}`
    l.flashing = true
    try {
    // The control point notifies its own status, so it needs its own subscription for the transfer.
    await io.subscribe(ctl)
    ctl.addEventListener('characteristicvaluechanged', l.onOtaStatus)

    onProgress(0, image.length, 'preparing the radio')
    let s = await otaControl(l, io, otaPrepare(image.length))
    if (s !== 0) throw new Error(`the radio refused the transfer: ${say(s)}`)

    s = await otaControl(l, io, OTA_START)
    if (s !== 0) throw new Error(`the radio would not start: ${say(s)}`)

    for (let off = 0; off < image.length; off += OTA_CHUNK) {
      const end = Math.min(off + OTA_CHUNK, image.length)
      await io.write(l.otaData, image.subarray(off, end))
      onProgress(Math.min(off + OTA_CHUNK, image.length), image.length)
    }

    onProgress(image.length, image.length, 'verifying — the link will drop, and that is expected')
    try {
      s = await otaControl(l, io, otaVerify(crc32Wiced(image)), 20_000)
    } catch {
      return // the link went: the success path, per VERIFY_DROP_MEANS
    }
    if (s !== undefined && s !== 0) throw new Error(`the radio refused the image: ${say(s)}`)
    } finally {
      // Unconditional, for the reason the thermostat driver's `finally` gives — this state is one
      // link's, and a transfer on a different link holds a different object.
      l.flashing = false
      drain(l)
      // The characteristic is very likely gone with the link by now, so tidying it is best-effort.
      try {
        ctl.removeEventListener('characteristicvaluechanged', l.onOtaStatus)
      } catch {
        /* the link went with the reboot, which is the ordinary ending */
      }
    }
  })
}

/** The radio's OTA status byte, into the same inbox the thermostat driver reads. */
function onOtaStatus(l: Link, e: Event) {
  const ch = e.target as BluetoothRemoteGATTCharacteristic
  if (ch.value) pushFrame(l, new Uint8Array(ch.value.buffer.slice(0)))
}

/**
 * Learn the device's own Bluetooth address, so nobody is ever asked for one.
 *
 * WHY IT HAS TO BE ASKED FOR AT ALL. Decrypting the BThome broadcast needs the MAC — BThome v2 fixes
 * the nonce as `MAC ‖ 0xFCD2 ‖ device_info ‖ counter` — and the browser will not supply it:
 * `device.id` is opaque and origin-scoped by design and no Web Bluetooth API returns a BD_ADDR, on
 * any platform. The device's GATT table has a manufacturer name and a model number and nothing with
 * an address in it either.
 *
 * WHY THIS COMMAND AND NOT THE MEMORY PEEK. The chip stores its own MAC in a cell the debug oracle
 * can read, and doing that was built here and REVERTED: the cell sits at an address `build_mod.py`
 * ALLOCATES, so it moves on any size change. A client meets whatever firmware a thermostat happens
 * to be running, not the build it was compiled against — it would read some other cell and get a
 * PLAUSIBLE WRONG address, which then fails every decrypt with a tag mismatch, indistinguishable
 * from a wrong key. **A command id is a wire contract; an address is not**, and only a wire contract
 * may cross a version boundary. `0x51 02` is that contract, it changes nothing, and the host tools
 * have used it for this exact purpose all along.
 *
 * It answers on OUR firmware only — but an encrypted broadcast is our feature too, so a device that
 * needs decoding always has the command to ask with. On a stock chip this simply gets no reply,
 * which is not an error.
 */
async function identify(l: Link, d: BluetoothDevice, serial: string | null) {
  const r = await request(KEY_STATUS, isKeyStatus, 2, l)
  // **THE WHOLE REPLY IS KEPT, NOT JUST THE SIX BYTES THIS FUNCTION CAME FOR** — it also carries
  // the PIN gate, the broadcast switch and the key's state, which is all the Install tab needs.
  const st = r && decodeKeyStatus(r)
  if (st) noteKeyStatus(st, l)
  const mac = st?.mac ?? null
  // **NEITHER ANSWER IS A FAULT, AND NEITHER IS REQUIRED — but one of them must arrive.** A stock
  // thermostat gives the serial and not the MAC, because the MAC comes from our radio's own command;
  // one whose STM8 is sitting in its updater gives neither, which `unsavedLinkAtom` is for.
  fileRow(d, { mac, serial })
}

/**
 * Put what a thermostat has said about itself onto its row, creating one if there is none.
 *
 * Split out from `identify` because it is reached TWICE and the second caller must not re-ask: the
 * version chase carries the serial, so when a lost info reply finally lands it has an identifier
 * that was missing, and going through `identify` would spend another round trip on a MAC that is
 * already known.
 *
 * **An empty report does nothing at all**, which is the STM8-in-its-updater case: it answers neither
 * question, so there is nothing to file it under. A live connection is still usable without a row.
 */
function fileRow(d: BluetoothDevice, { mac, serial }: { mac?: string | null; serial?: string | null }) {
  if (!mac && !serial) return
  // THIS IS ALSO WHERE A THERMOSTAT JOINS THE REGISTRY, and where an imported row is matched to
  // this origin's handle: both are the same upsert, because the identity is the device's own and the
  // handle is the thing the file could not carry. A row that was already here keeps its name and key.
  const had = registry.match({ mac, serial })
  registry.upsert({
    ...(mac ? { mac } : {}),
    ...(serial ? { serial } : {}),
    // THE NAME FOLLOWS THE DEVICE — there is no local alias, because the thermostat's own name is
    // settable and two names for one thing is one too many `[owner]`. But `d.name` is NOT how it
    // follows it.
    //
    // **THE BROWSER'S NAME FOR A HANDLE IS A CACHE, AND IT DOES NOT REFRESH AFTER A RENAME**
    // `[manually verified]`. Chrome keeps it with the grant: a thermostat renamed over this very
    // connection still reads `CC-RT-BLE` here, and goes on doing so until the grant is dropped and
    // re-made — which is also why the browser's own chooser goes on offering the old name. Letting
    // it win overwrites a correct stored name with a stale one on every connect, so the list says
    // `CC-RT-BLE` the moment you open the device it had just been showing correctly.
    //
    // It SEEDS a row that has none, which is right — a thermostat this app has never met, and a
    // stock one that cannot answer the name command at all, have nothing better. `chaseAdvName`
    // asks the device itself immediately after this and overwrites both cases with the truth.
    name: had?.name || d.name || 'Thermostat',
    deviceId: d.id,
    // A KEY OFFERED WHILE ADDING BELONGS TO WHICHEVER THERMOSTAT ANSWERED, and this is the first
    // moment that is known. An existing key is never overwritten: the row is the authority for a
    // thermostat this browser already knows, and the offer was only ever a guess about a stranger.
    ...(had?.key || !offeredKey ? {} : { key: offeredKey, channel: 'sealed' as const }),
  })
  // SPENT. It described one connection to one unknown device; keeping it would apply it to the next.
  offeredKey = null
  // ONLY WHEN THE PAIRING ACTUALLY CHANGED. The broadcast may have been arriving undecodable for
  // want of exactly this row-to-handle pairing, so what accumulated then is worth dropping — but
  // this runs on EVERY connect, and dropping it every time is what makes the readings vanish the
  // moment a link opens `[owner]`.
  if (had?.key && had.deviceId !== d.id) resetDevice(d.id)
}
