/**
 * Putting firmware on a thermostat — both chips, both directions.
 *
 * ================================================================================================
 * THE THERMOSTAT IS FLASHED FIRST, IN BOTH DIRECTIONS
 * ================================================================================================
 * Why is at the foot of this file, beside the order itself.
 *
 * **THE STEP BETWEEN THEM IS A WIRE CONTRACT, not an address**: `cmd 0x00`'s reply carries the
 * version byte (`FW_MOD` in `protocol.ts`), so the flow reads it back after the thermostat step and
 * STOPS if it is not what was asked for. Stopping half-way is a safe state, so the failure path is
 * "stop and say so", never "press on".
 *
 * **ONE CONNECTION SPANS BOTH STEPS.** The thermostat reboots into its bootloader for its own flash
 * and comes back on the new image, and none of that touches the radio chip the link is actually
 * terminated on. The radio's step is the one that ends the connection, because that chip reboots
 * into the image it just took — expected, and the last thing the flow does.
 *
 * ================================================================================================
 * WHAT THIS MODULE IS AND IS NOT
 * ================================================================================================
 * It is the PROTOCOL: the payload parsing, the frame shapes, the state machines and their verdicts,
 * with the transport handed in. That is what makes it testable without a device, and the tests hold
 * it to the byte sequences `../../../python-scripts/flash_mcu.py` and `../../../python-scripts/flash_ble_firmware.py`
 * already send — those two are the proven implementations and this is a translation of them.
 *
 * **IT HAS NEVER BEEN RUN FROM A BROWSER.** See `webapp/PLAN.md`.
 */

/* ---- the thermostat: chunk-at-a-time over the command characteristic --------------------------- */

/**
 * An OTA payload is a run of length-prefixed chunks: two bytes of length, then that many bytes.
 *
 * A trailing fragment that claims more than remains is dropped rather than sent — the file ends,
 * and a short chunk would be padded into something the bootloader would reject at best.
 */
export function parseChunks(raw: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = []
  for (let i = 0; i < raw.length; ) {
    const n = ((raw[i]! << 8) | raw[i + 1]!) + 2
    if (n > raw.length - i) break
    out.push(raw.slice(i, i + n))
    i += n
  }
  return out
}

/** The payloads are stored as hex text, which is what the eQ-3 updater shipped. */
export function unhexPayload(text: string): Uint8Array {
  const s = text.trim()
  const out = new Uint8Array(s.length >> 1)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** `cmd 0xa0` — leave the application and enter the bootloader. */
export const ENTER_OTA = [0xa0]
/** The bootloader answers its own id. */
export const isOtaMode = (b: Uint8Array) => b.length > 0 && b[0] === 0xa0

/**
 * One chunk becomes a run of `a1 <seq> <14 payload>` writes, zero-padded to fourteen.
 *
 * They go out back to back and only the CHUNK is acknowledged — that is the protocol, not an
 * oversight, and it is why the thermostat's flash is fast while its command channel is one at a
 * time.
 */
export function chunkPackets(chunk: Uint8Array): number[][] {
  const out: number[][] = []
  for (let off = 0, seq = 0; off < chunk.length; off += 14, seq++) {
    // `Array.from`, because `chunk` is a Uint8Array and this needs a real array to pad below —
    // a typed array has a fixed length and `push` would be silently ignored.
    const part = Array.from(chunk.subarray(off, off + 14))
    while (part.length < 14) part.push(0)
    out.push([0xa1, seq, ...part])
  }
  return out
}

export type ChunkVerdict = 'ok' | 'nack' | 'finished' | null

/**
 * A CHUNK VERDICT IS ONLY `a1 22`, `a1 33` OR `a1 44`. Anything else here is not an answer to this
 * chunk — notably a stale `a0 11` from an aborted transfer, which arrives after the new session's
 * own response. Accepting it shifts every later chunk by one, so chunk N is judged by chunk N-1's
 * reply and the stream desyncs into NACKs no retry can clear.
 *
 * **That is reachable by an ordinary user and presents as a brick**: an OTA that dies mid-stream is
 * a thing that happens, and every retry after it then fails at the first chunk, forever, on a device
 * that is perfectly healthy. Measured in the Python tool: one aborted transfer at chunk 109, three
 * retries all giving up at chunk 1, then a clean run to `a1 44` once the verdict was matched
 * strictly. `a1 11` is a PER-PACKET receipt and is not a verdict either.
 */
export function chunkVerdict(b: Uint8Array): ChunkVerdict {
  if (b.length < 2 || b[0] !== 0xa1) return null
  if (b[1] === 0x22) return 'ok'
  if (b[1] === 0x33) return 'nack'
  if (b[1] === 0x44) return 'finished'
  return null
}

/* ---- the radio chip: WICED Smart OTA ----------------------------------------------------------- */

const bitrev = (v: number, bits: number) => {
  let r = 0
  for (let i = 0; i < bits; i++) r = (r << 1) | ((v >> i) & 1)
  return r >>> 0
}

/** Broadcom's WICED CRC32: poly `0x04C11DB7`, bit-reversed in and out. */
export function crc32Wiced(data: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc = (crc ^ (bitrev(byte, 8) << 24)) >>> 0
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x80000000 ? (((crc << 1) ^ 0x04c11db7) >>> 0) : ((crc << 1) >>> 0)
    }
  }
  return (bitrev(crc, 32) ^ 0xffffffff) >>> 0
}

/**
 * The widest image this protocol can announce. Sixteen bits because the WICED field is sixteen bits,
 * so it is a fact about the wire and not a limit to raise.
 */
export const OTA_MAX_IMAGE = 0xffff

/**
 * `01 <length little-endian>` — tell the chip how much is coming.
 *
 * **IT THROWS RATHER THAN WRAPPING, and that is the only safe answer.** `setUint16` truncates in
 * silence, so an image over 64 KB would announce its own low sixteen bits: the chip would be told to
 * expect a short image and then handed a long one, which is a failure discovered part-way through a
 * write rather than before one. Today's radio image is about 27 kB, so this cannot fire — it is the
 * guard on a field that has no room to grow.
 */
export function otaPrepare(length: number): Uint8Array {
  if (!Number.isInteger(length) || length < 0 || length > OTA_MAX_IMAGE)
    throw new Error(
      `this radio image is ${length} bytes. The update protocol announces a length in 16 bits, so ` +
        `it cannot describe anything larger than ${OTA_MAX_IMAGE} bytes — nothing has been written.`,
    )
  const b = new Uint8Array(3)
  b[0] = 1
  new DataView(b.buffer).setUint16(1, length, true)
  return b
}
/** `02` — begin. It also ZEROES the staging cells, so it destroys the evidence of a failure. */
export const OTA_START = new Uint8Array([2])
/** `03 <crc little-endian>` — verify and apply. */
export function otaVerify(crc: number): Uint8Array {
  const b = new Uint8Array(5)
  b[0] = 3
  new DataView(b.buffer).setUint32(1, crc, true)
  return b
}

/** Twenty bytes per write, which is what one ATT value holds on this stack. */
export const OTA_CHUNK = 20

/**
 * The chip's own status codes. **The glosses do not diagnose anything**, and one of them used to:
 * the app can only ever answer 3 for a refused verify `[binary]`, so 3 is what EVERY refusal says
 * whatever went wrong. What separates arrival from loss is the three staging cells, which `02`
 * clears — so they must be read BEFORE a retry.
 */
export const WS_STATUS: Record<number, string> = {
  0: 'OK',
  1: 'Unsupported command',
  2: 'Illegal state',
  3: 'Verification failed — the cause is NOT implied by this code',
  4: 'Invalid image',
  5: 'Invalid image size',
  6: 'More data needed',
  7: 'Invalid app id',
  8: 'Invalid version',
}

/**
 * THE LINK USUALLY DIES AT THE VERIFY STEP, AND THAT IS THE SUCCESS PATH.
 *
 * The chip verifies, applies and reboots, which drops the connection before any status can come
 * back — so a flash that WORKED ends in a disconnect. Measured: six OTAs in one session, not one of
 * them returning a status.
 *
 * **A disconnect is therefore not proof of success either.** It is consistent with the image having
 * taken and with a silent non-take; one of those six came back up on the previous image. Only a byte
 * compare separates them, and the honest verdict here is "unknown, go and check the version".
 */
export const VERIFY_DROP_MEANS =
  'The thermostat’s radio rebooted, which is how a successful flash ends — and also how a silent ' +
  'failure ends. Reconnect and check the version before believing either.'

/* ---- where the images are fetched from ---------------------------------------------------------- */

/**
 * **ROOT-ABSOLUTE, AND THAT IS THE WHOLE POINT OF THESE EXISTING** `[manually verified]`.
 *
 * The app's URL is `/thermostat/<id>/install`, so a RELATIVE `firmware/…` resolves against it and
 * asks for `/thermostat/<id>/firmware/…`. **The dev server's SPA fallback answers that with
 * `index.html` and status 200** — so `response.ok` is TRUE and nothing looks wrong until the JSON
 * fails to parse, at which point the page reports that no firmware is staged on a deploy where seven
 * releases are. It is a 200 that means "not found", which is the shape a fetch cannot catch for you.
 *
 * They are functions in this module rather than strings in the component so the leading slash is one
 * decision with a test on it, instead of a character that has to be got right at each call.
 */
const FIRMWARE_BASE = '/firmware/'
export const catalogueUrl = () => `${FIRMWARE_BASE}catalogue.json`
export const imageUrl = (file: string) => `${FIRMWARE_BASE}${file}`

/* ---- and what came back must be what the catalogue promised ----------------------------------- */

/**
 * SHA-256 of some bytes, lower-case hex — the spelling `tools/stage_firmware.py` writes.
 *
 * `crypto.subtle` needs a secure context, which this page already is: Web Bluetooth refuses to run
 * anywhere else, so a browser that can reach a thermostat can always hash.
 */
export async function sha256Hex(data: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', data as unknown as BufferSource)
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Hold a downloaded image to the catalogue entry that offered it. Throws rather than returning a
 * verdict, because every caller's answer to a mismatch is the same: stop before anything is written.
 *
 * ================================================================================================
 * THE CASE THIS IS REALLY FOR IS A 200 THAT MEANS "NOT FOUND"
 * ================================================================================================
 * The note above `FIRMWARE_BASE` records it for the catalogue: a dev server answers a MISSING path
 * with `index.html` and status 200, so `response.ok` is true and the bytes are an HTML page. **The
 * image URLs have the same shape and nothing caught it there.** An absent `radio-<version>.bin` came
 * back as the app's own markup and went to `flashRadio`, which checks no length and no hash — and
 * the CRC it sends is computed over whatever it was handed, so the CRC always agrees with itself.
 * The thermostat half survived it only by accident, because `parseChunks` finds no chunks in HTML.
 *
 * **A MISSING HASH IS A FAILURE, NOT A PASS.** `stage_firmware.py` writes one for every image it
 * stages, so an entry without one is a hand-made catalogue — and a check that quietly examines
 * nothing is indistinguishable from one that passed.
 *
 * The length is deliberately NOT compared: the catalogue's `bytes` is what reaches the DEVICE, which
 * for the thermostat is half the file, because its payload ships as hex text. The hash is over the
 * file, which is what was downloaded, and it subsumes the length anyway.
 */
export async function checkImage(
  got: Uint8Array,
  want: { file: string; sha256: string },
): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(want.sha256))
    throw new Error(
      `the firmware list offers ${want.file} with no usable checksum, so what was downloaded ` +
        'cannot be checked. Nothing has been written.',
    )
  const actual = await sha256Hex(got)
  if (actual !== want.sha256)
    throw new Error(
      `${want.file} did not arrive intact — the firmware list expects ${want.sha256.slice(0, 12)}… ` +
        `and ${got.length} bytes arrived as ${actual.slice(0, 12)}…. Nothing has been written. ` +
        'Reload the page and try again; if it keeps happening the staged image is wrong.',
    )
}

/* ---- what order the two chips go in ------------------------------------------------------------ */

export type Chip = 'stm8' | 'radio'

/**
 * **THE THERMOSTAT IS FLASHED FIRST, THEN THE RADIO — always, in both directions** `[owner]`, and it
 * is written into the installer as two steps rather than computed, because it is not a decision any
 * more.
 *
 * **The radio does not need a quiet thermostat**, which is why the order does not depend on the
 * direction: what made a pushing one dangerous was our own sealed reply overrunning its ACL block,
 * which is fixed, and 12 of 12 radio updates have since been taken with the thermostat pushing
 * throughout `[manually verified]` (`CLAUDE.md`, "Flash the BLE-chip mod").
 *
 * Two things make this the order that serves. The radio is the thermostat's flash path — it relays
 * the OTA frames — so going thermostat-first sends that transfer through a radio image already there
 * and known to work. And the radio's own step ends by dropping the link, which is how it reports
 * success, so it must be the step with nothing after it.
 *
 * Stopping between them stays a safe state: both mixes are known to stay flashable, walked end to end
 * over the radio in both directions.
 */
