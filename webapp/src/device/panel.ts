/**
 * The thermostat's LCD, read as it actually is, and its buttons driven.
 *
 * ================================================================================================
 * THE WHOLE PANEL IS ONE ROUND TRIP
 * ================================================================================================
 * The mapped segment RAM is exactly thirteen bytes and `cmd 0x18` returns thirteen — so a screen is
 * read ATOMICALLY and cannot be sampled across a repaint. That is not a coincidence: the mod
 * envelope's payload is thirteen bytes, and the panel was made to fit one.
 *
 * **The tables are GENERATED from the firmware image** (`lcd_tables.ts`, written by
 * `stm8/ble/webapp/gen_tables.py`) and never typed. A hardcoded copy is right until the next build
 * and silently wrong afterwards; the host tools avoid that by reading them out of the image at
 * runtime, which a browser cannot do, so this app takes them at build time instead.
 */
import { ALIASES, BLANK, CELLS, FIELD, GLYPHS, PATCHAR, SEGMAP, SYM_A, SYM_B } from './lcd_tables'
import { LCD_PANEL_BYTES, byTag, type Match, type Reply } from './protocol'

/**
 * `cmd 0x23` — read the panel. NO ARGUMENTS, because the glass is always the same thirteen bytes.
 *
 * **IT REPLACES A MEMORY ADDRESS, and that is the point of it existing** `[owner]`. This used to be
 * `cmd 0x18` (the block read) pointed at the STM8's mapped segment RAM, which was the last address
 * anywhere in this app. That address is a peripheral and could not have gone stale — what it cost is
 * that the app had one at all, and that a read-any-address primitive had to keep shipping for the
 * Display tab to work. There is no fallback to the old way: 2.00 has never been released, so there
 * is no device in anyone's hands that answers one and not the other.
 */
export const PANEL_ONCE = 0
/** Ask to be SENT the panel whenever it changes — and answer once now. Renew it or it lapses. */
export const PANEL_LEASE = 1
/** Stop sending. */
export const PANEL_CANCEL = 2

export const readPanel = (mode: number = PANEL_ONCE) => [0x23, mode]

/**
 * How often to renew, against the thermostat's 10 s lease (`PANEL_LEASE_TICKS`).
 *
 * **TWO RENEWALS FILL THE LEASE EXACTLY** `[owner]`, so a single lost renewal is not comfortably
 * survived — the retry arrives on the same half-second tick the lease expires on. It self-heals,
 * because the next renewal re-arms and the mirror resumes, but the gap is visible. Widening the
 * LEASE is what buys margin here; renewing faster only costs the thermostat wakes.
 *
 * A lease at all because the thermostat is never told the phone hung up: one that could not lapse
 * would leave it pushing to nobody. Every renewal answers unconditionally, so this doubles as the
 * repair for a push that went missing — which is why this tab needs no poll of its own.
 */
export const PANEL_RENEW_MS = 5000

/** Tagged with its own id, like every other mod command — a PUSH looks exactly like a reply. */
export const isPanel: Match = byTag(0x23)

/** The thirteen segment bytes out of the reply, or null. */
export function panelBytes(b: Reply): Uint8Array | null {
  return b.length >= 2 + LCD_PANEL_BYTES ? b.slice(2, 2 + LCD_PANEL_BYTES) : null
}

/** Is one segment lit? Bit addresses index the thirteen bytes as byte `bit>>3`, bit `bit&7`. */
export const lit = (bits: Uint8Array, bit: number) => ((bits[bit >> 3] ?? 0) >> (bit & 7)) & 1

/**
 * The four big digits as text.
 *
 * **NOTHING DRAWS THIS, and it is not dead** `[owner]`: the glass already shows the digits as
 * segments, so printing them again underneath said the same thing twice. It stays because it is the
 * assertion vehicle for the cross-check in `panel.test.ts` — the one test that holds this app's
 * font table to `stm8/ble/lcd_read.py`'s, on bytes read off the real device. Delete it and the
 * segment maps are checked only against themselves.
 *
 * AN UNKNOWN PATTERN IS SHOWN RAW, never guessed at and never blanked: the firmware's font maps
 * several codes onto one pattern and the glass can light combinations no character covers, so a
 * decoder that silently substitutes the nearest letter would make a wrong screen look right. Slot 0
 * is the RIGHTMOST cell, so the display order is 3, 2, 1, 0.
 */
export function panelText(bits: Uint8Array): string {
  let s = ''
  for (const slot of [3, 2, 1, 0]) {
    const pat = SEGMAP[slot]!.reduce((a, bit, k) => a | (lit(bits, bit) << k), 0)
    s += PATCHAR[String(pat)] ?? (pat ? `<${pat.toString(16)}>` : ' ')
  }
  return s
}

/** Which of the fixed icons are lit, by the measured legend in `lcd_tables.ts`. */
export const litIcons = (bits: Uint8Array) =>
  SYM_A.map((bit, i) => (lit(bits, bit) ? i : -1)).filter((i) => i >= 0)

/** The 24-slot bar across the top, left to right. */
export const barSlots = (bits: Uint8Array) => SYM_B.map((bit) => !!lit(bits, bit))

/* ---- driving the buttons --------------------------------------------------------------------- */

/**
 * `cmd 0x19 <what> <hold>` — press a button, several at once, or turn the wheel one detent.
 *
 * **`hold 0` IS A TAP** and costs no dead time: each armed bit is released the instant a read has
 * shown it. A real duration is only for the threshold gestures, and it is in HALF-SECONDS, clamped
 * on the device to 1..20.
 *
 * The press is applied where the STOCK firmware reads the pin, so it reaches every input path —
 * the settings menu, the boost cancel, the locked-input hooks — and it auto-releases, with the
 * release evaluated inside the pin read itself, so even a firmware busy-wait ends on its own.
 */
export const BOOST = 1
export const MODE = 2
export const PA0 = 3
export const WHEEL_CW = 4
export const WHEEL_CCW = 5
/** A SET of buttons at once: `0x8<bits>`, bit0 BOOST, bit1 MODE, bit2 PA0. */
export const setOf = (bits: number) => 0x80 | (bits & 7)
/** MODE+PA0 — the child-lock grip, the one gesture a single pin cannot express. */
export const GRIP_LOCK = setOf(0b110)

export const press = (what: number, halfSeconds = 0) => [0x19, what, halfSeconds]
/** `19 00` — release any injection now. It is a `what` code, not a button. */
export const RELEASE = 0
export const releaseAll = () => [0x19, RELEASE]

export const isPressReply: Match = byTag(0x19)

/**
 * A LONG BOOST HOLD IS NOT A NEUTRAL TEST `[binary]`.
 *
 * Over ~1.25 s on BOOST is the Bluetooth pairing gesture, which spins waiting for a PIN — and on a
 * radio chip that has stopped answering it never returns. So the app offers taps, and the one hold
 * it does offer is the child-lock grip, which is not that gesture.
 */
export const BOOST_PAIRING_HOLD_HALFSECONDS = 3

/* ==================================================================================================
 * WRITING TO THE GLASS — `cmd 0x0F`
 * ================================================================================================*/

/** The longest message the frame can carry, so a text field can stop a person before the device does. */
export const MESSAGE_MAX = FIELD

/** Half-seconds, and the widest a hold can be. `0xff` is the "until cancelled" sentinel, not 127.5 s. */
export const HOLD_FOREVER = 0xff
export const HOLD_MAX_SECONDS = 127

/**
 * What a message will look like on the glass, and what it cannot draw.
 *
 * **SEVEN SEGMENTS ARE NOT AN ALPHABET.** `m`, `M`, `X` and `i` have no shape of their own, so the
 * font either borrows a neighbouring letter's (`ALIASES`) or has nothing at all — and a cell asked
 * for a shape that does not exist draws the wrong letter rather than failing. So a character that
 * cannot be drawn is REPORTED, not silently swapped or dropped: `bad` is what the caller shows the
 * person, and it is the reason this returns a pair instead of throwing.
 *
 * **UP TO FOUR CHARACTERS ARE RIGHT-ALIGNED, ANYTHING LONGER IS LEFT-ALIGNED.** Four is what the
 * panel shows at once; more than that and the firmware walks a four-cell window across the message,
 * and a scroll starts at the first letter. Same rule as `stm8/ble/lcd_text.py`, which is where this
 * behaviour is specified.
 */
export function toGlyphs(text: string): { glyphs: number[]; bad: string[] } {
  const glyphs: number[] = []
  const bad: string[] = []
  for (const ch of text.slice(0, FIELD)) {
    const c = ch in GLYPHS ? ch : ALIASES[ch]
    if (c === undefined || !(c in GLYPHS)) bad.push(ch)
    else glyphs.push(GLYPHS[c]!)
  }
  const padded =
    glyphs.length <= CELLS ? [...Array(CELLS - glyphs.length).fill(BLANK), ...glyphs] : glyphs
  return { glyphs: [...padded, ...Array(FIELD - padded.length).fill(BLANK)], bad }
}

/**
 * `cmd 0x0F` — paint the panel: nine glyphs, then how long to hold it, then the two masks.
 *
 * **ALL FIFTEEN ARGUMENT BYTES GO EVERY TIME.** The relay buffer is a fixed sixteen bytes and is
 * not cleared between commands, so a byte left off is not zero — it is whatever the last command
 * put there. This is also the widest command the device has: one more byte and it is refused
 * before it is relayed.
 *
 * **THE MESSAGE OWNS THE WHOLE PANEL.** The icon and bar masks are sent as zero, so a message never
 * inherits the icons the previous screen happened to light. The app does not offer them: an icon
 * mask is a thing a script composes, not a thing a thumb picks at a radiator `[owner]`.
 *
 * **IT IS ALWAYS ACCEPTED AND STILL MAY NOT APPEAR.** A boost, a fault, date entry or the fitting
 * procedure owns the panel, and the firmware shows a message only if its hold outlives whatever
 * owns it. So an ack means "stored", never "you can see it".
 */
export const showText = (glyphs: number[], halfSeconds: number) => [
  0x0f,
  ...glyphs,
  halfSeconds,
  0, // icon mask, high byte — bits 15:14 are the scroll speed, and 00 is the 1.0 s default
  0, // icon mask, low byte
  0, // schedule bar, slots 0..7
  0, // slots 8..15
  0, // slots 16..23
]

/** Put the normal screen back now. A hold of zero is the firmware's own cancel. */
export const clearText = () => showText(Array(FIELD).fill(BLANK), 0)

/** The ack for a paint. Like every mod command, it answers under its own id. */
export const isTextReply: Match = byTag(0x0f)
