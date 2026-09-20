/**
 * The name a thermostat ADVERTISES — `cmd 0x5B`, and the counting that goes with it.
 *
 * ================================================================================================
 * WHY THIS IS WORTH A SETTING AT ALL
 * ================================================================================================
 * Every one of these thermostats calls itself `CC-RT-BLE`, and the browser's device chooser shows
 * that name and nothing else — no address, no serial, no way to tell three of them apart. The app
 * cannot fix that with a name of its own, because **the chooser appears before the page has a
 * device**: whatever this browser has written down is unreachable at the only moment it would help.
 * So the name has to be on the thermostat, and this is the command that puts it there.
 *
 * **THE LIMIT IS THE DEVICE'S TO STATE, NOT OURS.** It falls out of how much room is left in the
 * radio's scan response beside eq-3's own manufacturer data, so it belongs to a firmware version and
 * not to this app — and a number baked in here would be wrong the first time a release finds more
 * room, silently, in the direction that refuses a name the device would have accepted. Every reply
 * carries it; `read()` hands it back and the row uses that.
 *
 * **BYTES, NOT CHARACTERS.** A Complete Local Name goes on the air as UTF-8 `[external]`, so `é`
 * costs two and an emoji four. `count()` is the one place that is decided, and the field, the
 * counter and the Save button all ask it rather than each measuring `.length` their own way.
 */
import { ADV_NAME_HDR, type Reply } from './protocol'

/** What a thermostat with no stored name calls itself — and what `clear()` puts back. */
export const ADV_NAME_DEFAULT = 'CC-RT-BLE'

/**
 * Every name eQ-3 ships, so a device chooser can be narrowed to un-renamed thermostats.
 *
 * TWO, because there are two hardware variants and they differ by this string and by a product id
 * and nothing else that matters to us `[binary]`. `CC-RT-M-BLE` is the `-M-` variant; our firmware
 * does not support it separately, but a person installing for the first time is looking at a stock
 * device and it has to be in the list.
 *
 * MATCHED EXACTLY rather than by a `CC-RT` prefix `[owner]` — the same two devices either way, with
 * nothing else swept in, and both strings visible instead of implied.
 */
export const ADV_NAME_STOCK = [ADV_NAME_DEFAULT, 'CC-RT-M-BLE'] as const

/**
 * The prefix a CUSTOM name goes on the air under. **The radio adds it, not this app.**
 *
 * It exists because the name is the only thing in that packet that says what the device is: the
 * advertisement carries flags and BThome service data, and `0xFCD2` is the UUID every BThome device
 * in the world airs, so it names the protocol and not the product. Without a prefix a thermostat
 * called `Kitchen` matches nothing that looks for a thermostat, and reads as one that is out of
 * range rather than one that was renamed.
 *
 * **THE DEFAULT IS NOT PREFIXED**, deliberately: an un-renamed thermostat must keep matching
 * everything that looks for `CC-RT-BLE`, which is what a person has before they rename anything. So
 * this marks "named", not "is an eQ-3" — and `aired()` below is the only place that distinction is
 * spelt out, because the chooser filter and the name row both need the same answer.
 *
 * The prefix is the radio's own and is not counted: `max` applies to the text a person types, which
 * is what is set, reported and counted everywhere in this app.
 */
export const ADV_NAME_PREFIX = 'eQ3-'

/** What the device actually broadcasts for a given stored name. */
export const aired = (name: string) =>
  name === '' || name === ADV_NAME_DEFAULT ? name : ADV_NAME_PREFIX + name

/**
 * Sub-ops, mirroring `name_cmd`'s own. A WIRE format, so it is written out here rather than derived
 * from anything — there is no build this app is compiled beside.
 */
const SUB_STAGE = 0x00
const SUB_APPLY = 0x01
/** Bytes one stage write carries. A full-length name does not fit beside its id, so it is two. */
const HALF = 8
/**
 * The apply's guard byte. **It is not a parameter and must not be treated as optional**: the radio
 * is handed the characteristic's declared sixteen bytes whatever this app writes, so a three-byte
 * apply would take its LENGTH out of whatever the previous write left behind — and the previous
 * write is a stage, full of name bytes.
 */
const GUARD = 0xa5

/** UTF-8 bytes — see the header for why that, and not characters. */
export const encode = (name: string) => new TextEncoder().encode(name)
export const count = (name: string) => encode(name).length

export type AdvName = {
  /** The name in force, read back out of the field the radio's packet builder actually uses. */
  name: string
  /** The most UTF-8 bytes this device will accept. Read from the reply; never assumed. */
  max: number
  /** What the last operation did — `null` when it worked. */
  error: string | null
}

/**
 * What each result code means, in the words the row shows.
 *
 * `refused` is the device applying its own rules and is the ordinary one; `eeprom` is its store
 * declining a write it had already accepted, which we have never seen and which would leave the
 * name exactly as it was.
 */
const RC: Record<number, string | null> = {
  0: null,
  1: 'the thermostat refused that name — too long, or a character it cannot broadcast',
  2: 'the thermostat could not save it, so nothing changed',
}

/**
 * Decode a report. `null` when the bytes are not one.
 *
 * **THE NAME IS THE REST OF THE FRAME**, so a device with an empty name is a four-byte reply and
 * not a malformed one. It is decoded as UTF-8 with replacement rather than strictly: a name this
 * app did not write could hold anything, and refusing to show it would turn a readable row into an
 * error about a thermostat that is working perfectly.
 */
export function decodeAdvName(b: Reply): AdvName | null {
  if (b.length < ADV_NAME_HDR || b[0] !== 0x5b) return null
  const rc = b[2]!
  return {
    name: new TextDecoder().decode(b.subarray(ADV_NAME_HDR)),
    max: b[3]!,
    // `in`, NOT `??`: success IS `null` in the table above, so `??` would fall through on the one
    // code that matters most and report every working write as an unknown result.
    error: rc in RC ? RC[rc]! : `the thermostat answered with a result this app does not know (${rc})`,
  }
}

/** `5b 02` — report the name and the limit, changing nothing. */
export const readAdvName = () => [0x5b, 0x02]

/**
 * The writes that set a name: the stage halves, then the apply. The caller sends them in order.
 *
 * **THE STAGES ANSWER NOTHING, BY DESIGN** — `name_cmd`: "staging answers nothing: the apply is what
 * has news". So they go out through `send()`, and only the apply is waited on. Through `request()`
 * each one would sit out a full reply timeout for an answer that was never coming.
 *
 * A SHORT NAME STILL STAGES A FULL HALF, padded with zeros, because the radio copies a fixed count
 * per stage — it is the apply's `len` that says how many of those bytes are the name. The padding is
 * never aired: bytes past `len` are not copied into the field at all.
 *
 * `null` when the name does not fit, so a caller cannot send one the device will refuse. The device
 * checks too, and its check is the authority; this one exists to keep an impossible value off the
 * wire, not as a second opinion.
 */
export function setAdvName(name: string, max: number): number[][] | null {
  const bytes = encode(name)
  if (bytes.length === 0 || bytes.length > max) return null
  const writes: number[][] = []
  for (let off = 0; off < bytes.length; off += HALF) {
    const chunk = Array.from(bytes.subarray(off, off + HALF))
    while (chunk.length < HALF) chunk.push(0)
    writes.push([0x5b, SUB_STAGE, off, ...chunk])
  }
  writes.push([0x5b, SUB_APPLY, bytes.length, GUARD])
  return writes
}

/**
 * Put `CC-RT-BLE` back. **An apply of length zero is how "use the default" is spelled** — the same
 * convention the encryption key's sixteen zero bytes use — so clearing needs no stage and no command
 * of its own.
 */
export const clearAdvName = () => [0x5b, SUB_APPLY, 0, GUARD]

/**
 * Does a rename cost this thermostat its automatic discovery? Only if it has a custom name.
 *
 * Home Assistant finds a thermostat by the name `CC-RT-BLE` `[external]`, and the official eQ-3 app
 * appears to as well `[inferred]`, so a renamed one stops being found by either on its own.
 * Anything that has already been introduced to the device keeps working — a browser grant, a
 * pairing and a Home Assistant entry all identify it by address, not by name.
 */
export const isDefaultAdvName = (name: string) => name === ADV_NAME_DEFAULT
