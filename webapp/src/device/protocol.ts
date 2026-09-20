/**
 * Wire constants for the eQ-3 thermostat, and nothing else.
 *
 * ================================================================================================
 * NO BUILD-ALLOCATED ADDRESS MAY APPEAR IN THIS APP, EVER — NOT EVEN FROM A MAP `[owner]`
 * ================================================================================================
 * Every other tool in this repo is rebuilt beside the firmware, so a generated map describes the
 * image it will meet. **This app has that relationship with nothing.** It is shipped once and then
 * meets whatever a thermostat happens to be running — 2.00 today, **2.01 tomorrow, which moves
 * every cell `pack.py` places**. An address baked in here is right until the next release and
 * returns TRASH afterwards, plausibly and with no error to notice. It has already cost one revert:
 * this app read the BLE chip's own MAC out of a cell `build_mod.py` allocates, so on any other
 * firmware it read some other cell and every decrypt failed with a tag mismatch — indistinguishable
 * from a wrong key. The fix was `cmd 0x51 02`, a WIRE CONTRACT, and that is the shape to reach for.
 *
 * **What may be named here:** command ids and GATT UUIDs, which cross versions by construction; and
 * stock `$00xx-$05xx` RAM, `$10xx` EEPROM and `$50xx` peripherals, which are stable per firmware
 * version. **A stock address is a stopgap, not the design** `[owner]` — a setting an owner can
 * change should be read and written through a COMMAND, and every one of them now is.
 *
 * **THERE IS NO ADDRESS LEFT IN THIS APP.** The panel mirror held the last one, the LCD's mapped
 * segment RAM, and it went when `cmd 0x23` (read the panel) started answering the glass without
 * being told where it is. That one could not have gone stale — a peripheral does not move — and it
 * was still worth a command, because one tolerated address is a rule with an exception, and because
 * a shipped feature was the only reason `cmd 0x18` (the block read, a read-any-address primitive)
 * had to stay reachable in a release build. `check_addresses.py` scans this directory and enforces
 * the build-allocated rule; preferring a command to a stock address is a design rule no tool checks.
 */

/** The EQ-3 service every command and reply rides on. */
export const SVC = '3e135142-654f-9090-134a-a6ff5bb77046'
/** Command characteristic: phone → BLE chip → STM8. */
export const CMD_CH = '3fa4585a-ce4a-3bad-db4b-b8df8179ea09'
/** Notification characteristic: the STM8's replies, relayed back. */
export const NOTIFY_CH = 'd0e8434d-cd29-0996-af41-6c90f4e0eb2a'

/**
 * The SEALED pair — a second command characteristic that accepts nothing but AES-CCM frames, and its
 * own notify. The envelope that rides on them is `sealed.ts`; `../../../PROTOCOL.md`, "Sending a command
 * encrypted", is the contract.
 *
 * **THEY ARE WHY A GATED THERMOSTAT IS STILL REACHABLE.** The pairing gate refuses an unpaired
 * central on every characteristic in the service above; it does not cover these. So a browser that
 * holds the key can still talk to a thermostat with `PIn` on, which is otherwise a device this app
 * cannot open at all.
 *
 * **ABSENT ON AN OLDER RADIO IMAGE, and that is not an error.** Discover them rather than assume
 * them: absent simply means no sealed traffic, and the legacy characteristic every build has.
 */
export const ENC_W = '2e3fa1b0-5a55-4c0d-9e11-0b130a1c0001'
export const ENC_N = '2e3fa1b0-5a55-4c0d-9e11-0b130a1c0002'

/** BThome v2 service data, read from the ADVERT with no connection at all. */
export const BTHOME_SVC = 0xfcd2

/**
 * The Broadcom WS-OTA service and its app-info record — the BLE CHIP's own version.
 *
 * READ AS A PLAIN GATT CHARACTERISTIC, which is the whole point: it is a stock attribute and
 * answers on BOTH images, so it can tell them apart. The instruments that cannot, each of which
 * gave a confidently wrong verdict in one session, are listed in
 * `ble_chip/analysis/FINDINGS.md` — "HOW TO ASK WHICH BLE-CHIP IMAGE IS RUNNING".
 *
 * Both UUIDs were read off the device's own table rather than recalled: the service ends `386f`.
 * The record is product id (u16 little-endian), major, minor — **4.6 is stock 1.48, 5.0 is ours**.
 */
export const OTA_SVC = '9e5d1e47-5c13-43a0-8635-82ad38a1386f'
export const APP_INFO_CH = '347f7608-2e2d-47eb-913b-75d4edc4de3b'

/**
 * The same service's two OTA characteristics — the control point, which is written AND notifies its
 * one-byte status, and the data pipe the image itself goes down.
 *
 * `flash.ts` owns the frames; `link.ts` owns the writes. Nothing else may reach these, for the same
 * reason nothing else may reach the command characteristic.
 */
export const OTA_CONTROL_CH = 'e3dd50bf-f7a7-4e99-838e-570a086c666b'
export const OTA_DATA_CH = '92e86c7a-d961-4091-b74f-2409e72efe36'

export type ChipVersion = { product: number; major: number; minor: number }

/** Our BLE-chip image's major. Anything below it is a stock radio, whatever the number. */
export const CHIP_MOD_MAJOR = 5

export function parseAppInfo(v: DataView): ChipVersion | null {
  if (v.byteLength < 4) return null
  return { product: v.getUint16(0, true), major: v.getUint8(2), minor: v.getUint8(3) }
}

/**
 * The radio's version AS SHOWN — with the `v`, because every version in this app carries one.
 *
 * **DISPLAY ONLY. Never compare with it** — `chipIs` is for that. A comparison against formatted
 * text breaks the moment the format changes, and does so silently: the catalogue spells its expected
 * version `5.0`, so the day this gained its `v` every "is the device on this release" test would
 * have started answering no, and the app would have offered an upgrade to the version already
 * installed.
 */
export const chipText = (c: ChipVersion) => `v${c.major}.${c.minor}`

/**
 * The radio's version with NO prefix — for the one place that supplies the word itself: the firmware
 * card's badge reads `radio 5.0`, so a `v` inside it would be a second label.
 */
export const chipNumber = (c: ChipVersion) => `${c.major}.${c.minor}`

/**
 * Does this radio report the version a catalogue entry expects? Compares NUMBERS.
 *
 * `expect` comes from the catalogue as `"5.0"` — a wire fact, not a label — so it is parsed rather
 * than formatted, and neither side of the comparison is anything a person reads.
 */
export const chipIs = (c: ChipVersion, expect: string) => {
  const [major, minor] = expect.split('.').map(Number)
  return c.major === major && c.minor === minor
}

/**
 * How many bytes cover the whole panel — a PAYLOAD LENGTH, not an address.
 *
 * The base address that used to sit beside this is gone: `cmd 0x23` answers the panel without being
 * told where it is, so this app now names no memory address at all. The header above says why that
 * was worth a command rather than a better constant.
 */
export const LCD_PANEL_BYTES = 13

/** A frame from the device. */
export type Reply = Uint8Array

/** Matches a reply against what a caller is waiting for. */
export type Match = (b: Reply) => boolean

/**
 * Every MOD command answers `01 <tag> <13 payload>`; the tag is how concurrent-looking waiters tell
 * their own reply apart. (`stm8/ble/fdbg.py` owns this protocol.)
 */
export const byTag =
  (tag: number): Match =>
  (b) =>
    b[0] === 0x01 && b[1] === tag

/**
 * Stock `cmd 0x00` (get info) answers `01 <ver> <b3> <b4> <11-byte serial>` — no tag byte.
 *
 * `ver` is the whole reason the app sends it: **200 on our firmware, 148 on stock**, so it is what
 * says which features a thermostat actually has. It is a stock command, so it answers on both.
 */
export const GET_INFO = [0x00]

/**
 * **LENGTH AND FIRST BYTE CANNOT SEPARATE THIS FROM A MOD REPLY** `[binary]`. The info reply is
 * `01 <ver> <b3> <b4> <11-byte serial>` — fifteen bytes — and the mod envelope is `01 <tag> <13
 * payload>`, also exactly fifteen and also starting `01`, so a test on those two accepts any mod
 * command's answer and reads its TAG as the version: a settings report shows as 0.22.
 *
 * **The two reserved bytes are the discriminator**: `b3:b4` are zeroed exactly as stock zeroes them
 * `[binary]` (`../../../PROTOCOL.md`, "Info reply"), confirmed on the device — `01 c8 00 00 …`.
 *
 * It is a narrowing, not a proof: a block read of two zero bytes still fits. What makes that
 * tolerable is that the queue puts one command in flight at a time, so the frame this has to reject
 * is a STALE one, not a concurrent one.
 */
export const isInfo: Match = (b) => b.length >= 15 && b[0] === 0x01 && b[2] === 0 && b[3] === 0

/**
 * The serial out of an info reply, or null if the bytes are not one.
 *
 * **IT IS WHAT IDENTIFIES A STOCK THERMOSTAT, so it is read out of the one reply stock gives.** The
 * MAC needs `cmd 0x51 02`, which is our radio firmware's own command; this is `cmd 0x00`, which is
 * stock's. `state/registry.ts`'s header has the rest.
 *
 * **THE BYTES ON THE WIRE ARE THE ASCII SERIAL PLUS 0x30, and reading them as ASCII yields nothing**
 * `[binary]`. The serial sits in RAM as plain ASCII, and `build_info_reply` adds 0x30 to every byte
 * on its way out (`stm8/reference/decomp_1.48/app_main.c`, `app_init`) — so a serial beginning `PEQ`
 * goes out as bytes 0x80, 0x75, 0x81 … , most of them above the printable range. Measured: a device
 * whose version arrived perfectly produced no serial at all until this subtraction was added.
 *
 * Rejected rather than cleaned up when what comes out is not printable: a row keyed on a
 * half-decoded serial cannot be matched again, so the same thermostat joins the list afresh on every
 * connection.
 */
export function serialOf(b: Uint8Array): string | null {
  // **TEN BYTES, NOT THE ELEVEN THE FRAME CARRIES, and the difference is an identity that MOVES**
  // `[binary]`. The serial in RAM is `$0010..$0019`, ten bytes; the byte after it is `g_pin_b0` —
  // the first byte of the pairing PIN the radio reported, a cache that starts as an 0xFF sentinel
  // and goes stale the moment the passkey is set. Measured on a device: reading eleven appended one
  // extra character to the ten-character serial, and that character was the cell. A row keyed on it
  // would be re-filed under a new identity the first time somebody changed the PIN.
  const raw = b.subarray(4, 14)
  if (raw.length < 10) return null
  // & 0xff so a byte below 0x30 wraps rather than going negative, which would sail through
  // `String.fromCharCode` as some other character instead of failing the test below.
  const s = String.fromCharCode(...Array.from(raw, (x) => (x - 0x30) & 0xff)).replace(/[^\x20-\x7e]+$/, '')
  return /^[\x20-\x7e]{6,}$/.test(s) ? s.trim() : null
}
/** The thermostat's version AS SHOWN: `200` → `v2.00`, the byte being hundredths. Display only, for
 * the reason on `chipText`. */
export const fwText = (v: number) => `v${(v / 100).toFixed(2)}`
/** A release's version as shown — the catalogue stores it bare, and everything displays it with a `v`. */
export const relText = (version: string) => `v${version}`
/**
 * A release named the way this app names one EVERYWHERE: `v2.00 (radio v5.0)` `[owner]`.
 *
 * A version here is a PAIR of images, and the radio's own number is the one that disagrees when
 * something has half-installed — so it is never worth showing one without the other.
 */
export const releaseText = (version: string, radio: string) => `v${version} (radio v${radio})`
/** Our firmware's version byte. Anything else is a stock image, whatever its number. */
export const FW_MOD = 200

/**
 * `cmd 0x51 02` — report the key's status WITHOUT changing anything, and with it the device's own
 * Bluetooth address.
 *
 * This is the BLE chip's own command, not the STM8's, so it does not use the mod envelope above.
 * Reply, 13 bytes: `51 | sub | key present | advert encrypted | store read | page-6 flags |
 * EEPROM rc | MAC ×6`, the address already in PRINTED byte order — which is the order the BThome
 * nonce wants.
 */
export const KEY_STATUS = [0x51, 0x02]
export const KEY_STATUS_LEN = 13

/**
 * MATCHING NEEDS BOTH THE ID AND THE LENGTH, and that is load-bearing rather than belt-and-braces:
 * the thermostat's unsolicited ~1 Hz status frames arrive on this same handle and would otherwise
 * be taken as the reply.
 */
export const isKeyStatus: Match = (b) =>
  b.length === KEY_STATUS_LEN && b[0] === 0x51

/**
 * `cmd 0x5B` — the name the thermostat ADVERTISES, which is what a device chooser shows.
 *
 * The radio chip's own command, like `0x51` above, so no mod envelope. Reply:
 * `5b | sub | rc | max bytes | the name now in force` — **variable length, and the name's length is
 * the notification's**, so there is no count byte to read and none to get wrong. The limit arrives
 * in the reply and is never assumed; `device/advname.ts` owns that and the encoding, and
 * `../../../PROTOCOL.md` is the contract.
 */
export const ADV_NAME_READ = [0x5b, 0x02]
/** `5b | sub | rc | max` — the shortest a report can be, which is a device with an empty name. */
export const ADV_NAME_HDR = 4
export const isAdvName: Match = (b) => b.length >= ADV_NAME_HDR && b[0] === 0x5b
