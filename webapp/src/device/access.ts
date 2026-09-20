/**
 * The settings a person configures ONCE when taking a thermostat over: the pairing PIN, the
 * encryption key the device itself holds, and the three switches on its own Bluetooth page.
 *
 * They live in Install rather than Settings `[owner]` — they belong to installing, not to running a
 * radiator, and it keeps a "turn Bluetooth off" control away from the temperature dial.
 *
 * ================================================================================================
 * THE DEVICE WILL NOT TELL YOU ITS KEY OR ITS PIN, AND THAT IS THE SHIPPED DESIGN
 * ================================================================================================
 * There is no command that reads either back, here or on the radio chip. So from a thermostat this
 * app has just met it can report **that** a key is in force and offer to replace or clear it, and
 * nothing more. The app's OWN stored copy is a different matter and is shown, on the thermostat's
 * row in the saved list `[owner]` — that is the person's own key in their own registry.
 *
 * **Setting a key is not dangerous and must not be presented as though it were** `[owner]`: it
 * opens the encrypted characteristic pair and encrypts the broadcast, the legacy characteristic
 * keeps working either way, and a key therefore never locks anybody out.
 */
import type { Match, Reply } from './protocol'

/* ---- the pairing PIN -------------------------------------------------------------------------- */

/**
 * `cmd 0x1E` — the six-digit pairing passkey, packed BCD, most significant pair first.
 *
 * **ALL SIX ZEROS MEANS "FORGET THE STORED ONE"**, not the PIN `000000` — the chip clears it and
 * its next boot draws a random one, so `000000` cannot be chosen. Every nibble must be a decimal
 * digit or the whole command is refused; the check lives on the thermostat and is repeated here
 * only to keep an impossible value off the wire, not as a second authority.
 */
export function setPin(pin: string): number[] | null {
  const d = pin.trim()
  if (!/^[0-9]{6}$/.test(d)) return null
  // `123456` becomes `12 34 56`.
  const bcd = (i: number) => (Number(d[i]) << 4) | Number(d[i + 1])
  return [0x1e, bcd(0), bcd(2), bcd(4)]
}

/** The all-zero form above: forget the stored passkey. */
export const clearPin = () => [0x1e, 0, 0, 0]

export const isPinReply: Match = (b) => b.length >= 3 && b[0] === 0x01 && b[1] === 0x1e
/** `0xFF` means a nibble was not a decimal digit; anything else is acceptance. */
export const pinAccepted = (b: Reply) => b[2] !== 0xff

/* ---- unpair all -------------------------------------------------------------------------------- */

/**
 * `cmd 0x1F` — delete every pairing the thermostat's radio holds.
 *
 * **THE ARGUMENT IS A GUARD BYTE, NOT A PARAMETER.** A command that destroys owner data does not act
 * on its id alone, so a bare `1f` is refused; the value differs from the factory reset's guard so the
 * two cannot be mistaken for each other.
 *
 * **THE REPLY MEANS "ACCEPTED", NOT "DONE"** `[manually verified]`. The thermostat latches the frame
 * and sends it to the radio a main-loop pass later — it has to, because the unpair puts the radio
 * into a blocking write and a reply sent any earlier is lost in that window. There is nothing to
 * poll: the only proof is a counter on the radio that no command reads.
 *
 * **AND NEITHER CHIP DROPS THE LINK.** A connection already open keeps working on a session key both
 * sides already agreed; what has gone is the stored key the NEXT connection would have used. The app
 * hangs up itself, which is what its own confirmation promises.
 */
export const unpairAll = () => [0x1f, 0xa5]

export const isUnpairReply: Match = (b) => b.length >= 3 && b[0] === 0x01 && b[1] === 0x1f
/** `0xFF` means the guard byte was wrong or missing; anything else is acceptance. */
export const unpairAccepted = (b: Reply) => b[2] !== 0xff

/* ---- factory reset ------------------------------------------------------------------------------ */

/**
 * `cmd 0xf0` — clear every setting and reboot. **THE ONE CONTROL IN THIS APP WHOSE FAILURE NEEDS
 * HANDS**, which is why it is worth reading what it does before offering it.
 *
 * **THE ID ALONE — there is no guard byte.** Stock's table gives it a frame length of 2, and that
 * column counts one more than the host writes throughout (`0x03` set-date is 8 and its builder emits
 * seven bytes; `0x00` get-info is 2 and the app writes one). Unlike the unpair, whose guard byte is
 * ours to require, this is a stock command and stock decides its shape.
 *
 * **IT ANSWERS NOTHING, because it reboots.** Sending it through `request()` would wait out every
 * attempt and then call a command that worked a failure.
 *
 * **AND IT TAKES THE RADIO OFF THE AIR** `[manually verified]` — by this route and by the `rES` page
 * on the glass alike. The reboot marks the device as never-paired and the thermostat then tells the
 * radio to go quiet, and that persists: it comes up dark and stays dark. The way back is
 * `RADIO_BACK_ON` below, since `1D 00 01` needs the radio this has just switched off.
 * `../../../PROTOCOL.md`, "a factory reset takes the radio off the air", has both.
 *
 * It also drops the two secrets the thermostat cannot reach — the pairing passkey and the AES bind
 * key both live on the radio, so a reset that stopped at the thermostat would hand back a "reset"
 * device still demanding the old owner's PIN.
 */
export const factoryReset = () => [0xf0]

/* ---- settings page 6's three switches ---------------------------------------------------------- */

export const ITEM_RADIO = 0
export const ITEM_BROADCAST = 1
export const ITEM_PIN_GATE = 2

/**
 * `cmd 0x1D <item> <0|1>` — press one item on the thermostat's own Bluetooth page for you.
 *
 * It drives the SAME routine the item's own button press drives, so there is one implementation of
 * "turn the sensor data off" rather than two. **Item 3 (start pairing) is refused** — putting a
 * device into pairing mode is something a person does standing at it.
 */
export const setSwitch = (item: number, on: boolean) => [0x1d, item, on ? 1 : 0]

export const isSwitchReply: Match = (b) => b.length >= 4 && b[0] === 0x01 && b[1] === 0x1d
/** The value the device stored, or null when it refused the item. */
export const switchStored = (b: Reply) => (b[3] === 0xff ? null : b[3]!)

/**
 * TURNING THE RADIO OFF LOSES THE DEVICE, and the app cannot turn it back on `[owner]`.
 *
 * `1d 00 00` takes Bluetooth down and the reply may never arrive. That is the one control here worth
 * asking about; nothing else on this page is. The opposite direction is genuinely useful — `1d 00 01`
 * also clears the flag that makes the radio come up dark at its next boot.
 *
 * The way back is the `EnA` item on the thermostat's own glass, or an ST-Link, and it is the same for
 * EVERY route that takes the radio off — this switch, and a factory reset, which does it as a
 * consequence rather than as the point. Hence a constant, not a sentence in whichever dialog is
 * being written at the time.
 */
export const RADIO_BACK_ON =
  'To turn it back on, hold the thermostat’s wheel to open its menu, go to the Bluetooth page, ' +
  'and set EnA to on.'

export const RADIO_OFF_WARNING =
  'This turns the thermostat’s Bluetooth off. This app will lose it and cannot turn it back on. ' +
  RADIO_BACK_ON

/* ---- the AES bind key, on the DEVICE ------------------------------------------------------------ */

/** An AES-128 key is 16 bytes, so 32 hex characters — the length every field for it enforces. */
export const KEY_CHARS = 32

/**
 * Keep only what a key can be made of, as it is typed or pasted.
 *
 * IT IS THE VALIDATION, rather than a check that runs afterwards: a field that cannot hold a wrong
 * character has no wrong state to report, and a key pasted out of Home Assistant with spaces or
 * capitals in it lands clean instead of being rejected. Length is what remains, and a counter beside
 * the field says that better than a message does.
 *
 * Here rather than in the form because BOTH key fields need it — the one that writes the key to the
 * thermostat and the one that stores this app's own copy on the saved row.
 */
export const cleanKey = (raw: string) =>
  raw.toLowerCase().replace(/[^0-9a-f]/g, '').slice(0, KEY_CHARS)

/**
 * A fresh random key, because a person choosing this one has to invent 16 bytes.
 *
 * `crypto.getRandomValues` and not `Math.random`: this is the key that seals the broadcast, and a
 * predictable one is worse than none because it looks encrypted. It is the only thing on this
 * screen a person cannot reasonably produce themselves.
 */
export const randomKey = () =>
  [...crypto.getRandomValues(new Uint8Array(KEY_CHARS / 2))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

/**
 * `cmd 0x51` — set or clear the key the thermostat itself holds. THREE writes, in order: stage the
 * low half, stage the high half, apply.
 *
 * Returns the three frames, so the caller sends them one at a time through the same queue as
 * everything else — they are ordinary commands and there is nothing special about their pacing.
 */
export function setDeviceKey(hex32: string): number[][] | null {
  const k = hex32.trim().replace(/\s/g, '').toLowerCase()
  if (!/^[0-9a-f]{32}$/.test(k)) return null
  const bytes = k.match(/../g)!.map((h) => parseInt(h, 16))
  return [
    [0x51, 0x00, 0, ...bytes.slice(0, 8)],
    [0x51, 0x00, 8, ...bytes.slice(8, 16)],
    [0x51, 0x01, 0xa5],
  ]
}

/** The same three writes, spelling "no key" — see `spellsClear`. */
export const clearDeviceKey = () => setDeviceKey('0'.repeat(32))!

/**
 * **SIXTEEN ZEROS IS HOW "CLEAR" IS SPELLED, so it is not a key anybody may SET** `[binary]`.
 * `key_restore` in `ble_chip/mod/bthome.S` puts `BKEY = zeros, KEY_PRESENT = 0`, and that is the
 * same all-zero convention the pairing passkey uses (`cmd 0x1E`). A person typing 32 zeros into a
 * key field would therefore turn encryption OFF while believing they had set the simplest possible
 * key — the field says 32/32, the writes go out, the device reports no key, and nothing anywhere
 * explains it. `ble_chip/tools/set_bindkey.py` has refused it from the host all along.
 *
 * It is NOT in `setDeviceKey`, deliberately: that encoder is what `clearDeviceKey` is built on, so
 * rejecting the value there would break the one caller that means it. The forms are what refuse it,
 * the same way the PIN sheet refuses `000000`.
 */
export const spellsClear = (hex: string) => /^0*$/.test(hex)

export type KeyStatus = {
  /** A key is in force. Only meaningful when `storeRead` is true — see below. */
  present: boolean
  /** The broadcast is encrypted. */
  advertEncrypted: boolean
  /**
   * The radio chip has actually READ its key store.
   *
   * **"NOT YET ASKED" IS NOT "NO KEY", and reporting it as one has misled twice.** Both read 0 in
   * `present`; this flag is the only thing that separates them. Reading its store needs a
   * connection or the thermostat's config frame, so a freshly booted device can legitimately say
   * "I do not know yet".
   */
  storeRead: boolean
  /**
   * Settings page 6, as the RADIO chip has it — bit 0 broadcast on, bit 1 PIN gate on.
   *
   * **BOTH BITS CLEAR IS A REAL STATE, not a missing answer**, and reading it as one cost a device
   * owner both switches: with the broadcast turned off and the gate already off the byte is 0, the
   * app called that "not known yet", disabled both rows, and left no way to turn the broadcast back
   * on. There is no unknown here to detect — the radio chip's copy powers up at `CFG_BTHOME`
   * `[binary]` (`ble_chip/mod/bthome.S`), which is what it did before the feature existed, so a
   * stock thermostat, an interrupted update and a radio that rebooted by itself all land on the
   * same defined answer rather than on nothing.
   */
  broadcastOn: boolean
  /** True when the PIN gate is on: a passkey is demanded before anything can be read or written. */
  pinGateOn: boolean
  /** The device's own Bluetooth address, in printed order. */
  mac: string
}

export function decodeKeyStatus(b: Reply): KeyStatus | null {
  if (b.length < 13 || b[0] !== 0x51) return null
  const cfg = b[5]!
  return {
    present: b[2] === 1,
    advertEncrypted: b[3] === 1,
    storeRead: b[4] === 1,
    broadcastOn: (cfg & 1) !== 0,
    pinGateOn: (cfg & 2) !== 0,
    // `Array.from`, because `b` is a Uint8Array: its own `map` would give another Uint8Array and
    // the hex strings would be truncated back to bytes. The conversion is the point, not a copy.
    mac: Array.from(b.subarray(7, 13), (x) => x.toString(16).padStart(2, '0')).join(':'),
  }
}
