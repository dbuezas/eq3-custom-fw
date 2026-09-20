/**
 * Every setting an owner can change — read with ONE command, written with the commands that own
 * each one.
 *
 * ================================================================================================
 * THE WHOLE PAGE IS ONE ROUND TRIP, AND THIS FILE NAMES NO MEMORY ADDRESS
 * ================================================================================================
 * `cmd 0x16` (settings report) answers with all thirteen values, **each in the units of the command
 * that sets it** — so a row can show a value and send it straight back, and nothing here has to know
 * how the thermostat stores anything. That is the point of the id: the three conversions a host is
 * wrong by a constant on (the offset stored plus 7, the window duration cell in minutes against an
 * argument in five-minute units, the inverted auto-detect flag) are the firmware's business, and are
 * done once, where the cells are.
 *
 * **A COMMAND, NOT AN ADDRESS** — `device/protocol.ts`'s header owns that rule and the revert it has
 * already cost. `cmd 0x16` is why this page names no cell.
 *
 * **AN UNSET CELL ALREADY READS AS ITS DEFAULT** `[binary]`. `0` is the config block's "unset"
 * sentinel and the firmware substitutes the value it really runs before answering, so a row shows a
 * number that is true of the device and this file needs no defaults table. The one exception is the
 * idle-screen mask, where `0` is a value — "the stock target screen" — and is reported raw.
 */
import { TEMP_MAX, TEMP_MIN } from './commands'
import { byTag, type Match, type Reply } from './protocol'
import { isStatus } from './status'

export type Settings = {
  /** The temperature the comfort button selects, °C. */
  comfort: number
  /** The temperature the eco/night button selects, °C. */
  eco: number
  /** Calibration, °C, signed — what the thermostat adds to what it reads. */
  offset: number
  /** What the thermostat drops to while a window is open, °C. */
  windowTemp: number
  /** How long a window stays open, MINUTES. Zero is not "off" — see `setWindowConfig`. */
  windowMinutes: number
  /** Boost length in minutes. */
  boostMinutes: number
  /** How far the valve opens during a boost, percent. */
  boostPercent: number
  /** Idle-screen bits, PLUS bit 4 which is not a screen — see `SCREEN_BAR_VALVE`. */
  screenMask: number
  /** Seconds between idle screens, 1–9. */
  screenSeconds: number
  /**
   * LCD drive strength, stored and sent as PON+1, 1–8 — the display's CONTRAST.
   *
   * Not brightness: the panel has no backlight, so this changes how dark a lit segment is against
   * the glass rather than how much light comes out of it `[owner]`.
   */
  contrast: number
  /** Whether the thermostat may guess a window is open from a temperature drop. */
  windowAutoDetect: boolean
  /** How often the descaling stroke runs — one of `DESCALE_*`. */
  descale: number
  /** Whether a flat battery holds the descaling stroke back until the batteries are changed. */
  descaleBatterySkip: boolean
}

/* ---- the descaling stroke ------------------------------------------------------------------- */

/**
 * HOW OFTEN THE VALVE PIN IS DRIVEN ITS FULL TRAVEL, so limescale cannot seize it.
 *
 * `0` IS "EVERY WEEK" AND IS ALSO WHAT AN UNCONFIGURED THERMOSTAT DOES, so this is the one setting
 * on the page with no default to resolve — the firmware reports the byte it really holds and zero is
 * a value rather than the config block's "unset" sentinel.
 *
 * The thermostat's own menu writes these same numbers, so a value can round-trip through either.
 */
export const DESCALE_WEEKLY = 0
export const DESCALE_4_WEEKS = 1
export const DESCALE_8_WEEKS = 2
export const DESCALE_OFF = 3

/** `cmd 0x16` — report the settings. It takes no arguments; the reply is `01 16 <13 bytes>`. */
export const readSettings = () => [0x16]

export const isSettings = (b: Reply) => b.length >= 15 && byTag(0x16)(b)

/**
 * Which reply acknowledges a settings WRITE — and it is not the same shape for all of them.
 *
 * **OUR commands answer with their own tag** (`FD 01 <id>`, the mod envelope; `../../../PROTOCOL.md`
 * spells it out for `0x16`). **Stock's answer with the ORDINARY STATUS FRAME** instead — `FD 02 01`,
 * tag `0x02` — which `../../../PROTOCOL.md` states while explaining the one command that answers nothing at
 * all: "a host waiting for the status reply every other setting command produces" `[binary]`
 * `[manually verified]`.
 *
 * **WAITING FOR THE WRONG ONE IS NOT A SILENT LOSS, IT IS A SLOW ONE.** Match a stock setter on its
 * tag and nothing ever matches: the request spends every attempt and its gaps, about six seconds,
 * then logs that the thermostat did not answer and closes the dialog — on a write that worked. From
 * the outside it reads as a dialog that will not close.
 */
const STOCK_SETTERS = new Set([0x11, 0x13, 0x14])
export const settingAck = (id: number): Match => (STOCK_SETTERS.has(id) ? isStatus : byTag(id))

/**
 * The thirteen bytes, in the order `../../../PROTOCOL.md` lists them.
 *
 * **A 2.00 BUILT BEFORE THE DESCALING SETTING EXISTED STILL ANSWERS FIFTEEN BYTES**, because the mod
 * reply envelope is padded to its full length whatever the handler emitted. Its last two read `0`,
 * which is "every week, run whatever the battery says" — exactly what that firmware does. So the
 * length gate above can assert the whole envelope without cutting those thermostats off.
 *
 * The only arithmetic left here is display arithmetic — halving the half-degree temperatures the
 * commands themselves take, and turning the five-minute duration unit into the minutes a person
 * reads. Both are inverted by the `set*` builders below, so a value can round-trip unchanged.
 */
export function decodeSettings(b: Reply): Settings | null {
  if (!isSettings(b)) return null
  return {
    comfort: b[2]! / 2,
    eco: b[3]! / 2,
    offset: (b[4]! - 7) / 2,
    windowTemp: b[5]! / 2,
    windowMinutes: b[6]! * WINDOW_STEP_MINUTES,
    boostMinutes: b[7]!,
    boostPercent: b[8]!,
    screenMask: b[9]!,
    screenSeconds: b[10]!,
    contrast: b[11]!,
    windowAutoDetect: b[12] === 1,
    descale: b[13]!,
    descaleBatterySkip: b[14] === 1,
  }
}

/**
 * `cmd 0x17` — how often the descaling stroke runs, and whether a flat battery holds it back.
 *
 * The two are independent, and the command carries both every time, so a caller changing one has to
 * pass the other through. The thermostat refuses the whole command if either is out of range and
 * writes neither value, which is why nothing here clamps: a wrong number must come back as a
 * refusal, not as a quietly different setting.
 */
export const setDescale = (every: number, batterySkip: boolean) => [
  0x17,
  every,
  batterySkip ? 1 : 0,
]

/* ---- the advertising interval ------------------------------------------------------------- */

/**
 * HOW OFTEN THE THERMOSTAT ANNOUNCES ITSELF over Bluetooth — `cmd 0x22`.
 *
 * **NOT ONE OF THE THIRTEEN BYTES `cmd 0x16` ANSWERS** — `../../../PROTOCOL.md` states that reply is
 * already full — so this is read with its own command, `22 00`, rather than folded into `Settings`.
 * What each choice costs in battery and in how long a phone waits to find the thermostat is in
 * `../../../PROTOCOL.md`'s `cmd 0x22` table, not duplicated here.
 */
export const ADV_FAST = 1
export const ADV_NORMAL = 2
export const ADV_SLOW = 3

/** `22 00` — report the interval in force. Writes nothing and sends nothing to the radio. */
export const readAdvInterval = () => [0x22, 0x00]

export const isAdvInterval = byTag(0x22)

/** `cmd 0x22` — set the advertising interval to `ADV_FAST` / `ADV_NORMAL` / `ADV_SLOW`. */
export const setAdvInterval = (interval: number) => [0x22, interval]

/**
 * Decode a `cmd 0x22` reply. **The answer is always 1, 2 or 3, never 0** — a thermostat that has
 * never been told keeps the default and answers `ADV_NORMAL`. Anything else (a refusal answers
 * `0xFF`) reads as `null` rather than being guessed at as a fourth interval.
 */
export function decodeAdvInterval(b: Reply): number | null {
  if (!isAdvInterval(b)) return null
  const v = b[2]!
  return v === ADV_FAST || v === ADV_NORMAL || v === ADV_SLOW ? v : null
}

/**
 * `cmd 0x0E` — how long a boost lasts and how far it opens the valve.
 *
 * **BOTH HALVES MATTER, and the valve percentage is the one that changes how warm the room gets**
 * `[owner]`. The menu offers up to 4 hours; the command takes any byte, and the firmware clamps the
 * percentage to 100.
 */
export const setBoostConfig = (minutes: number, percent: number) => [
  0x0e,
  Math.min(240, Math.max(0, Math.round(minutes))),
  Math.min(100, Math.max(0, Math.round(percent))),
]

/* ---- the idle screen ---------------------------------------------------------------------- */

export const SCREEN_TARGET = 0x01
export const SCREEN_ROOM = 0x02
export const SCREEN_CLOCK = 0x04
export const SCREEN_VALVE = 0x08
/**
 * BIT 4 IS NOT A SCREEN `[binary]`. It selects what the 24-slot top bar shows while the thermostat
 * runs — clear for the weekly schedule (stock, and the default), set for the valve's own position.
 * It shares this cell because the menu page and this command already reached it, and the price of
 * that is exactly this: **a host rebuilding the mask from the screen bits alone turns the valve bar
 * off without meaning to.**
 */
export const SCREEN_BAR_VALVE = 0x10

export const SCREEN_BITS = SCREEN_TARGET | SCREEN_ROOM | SCREEN_CLOCK | SCREEN_VALVE

/**
 * `cmd 0x15` — which idle screens rotate, how fast, and what the top bar shows.
 *
 * The mask is passed whole rather than rebuilt, so bit 4 survives whatever the caller did with the
 * screen bits. `seconds` is a single digit on the glass, hence the 1–9 clamp.
 */
export const setScreen = (mask: number, seconds: number) => [
  0x15,
  mask & 0x1f,
  Math.min(9, Math.max(1, Math.round(seconds))),
]

/**
 * `cmd 0x1A` — the LCD's CONTRAST (its drive strength), applied LIVE.
 *
 * That is why it exists as a command rather than being left to a memory write: stock programs the
 * LCD's drive register exactly once at boot, so a byte written into the cell shows nothing until
 * the next reboot. Stored as PON+1 (1–8), and **0 is a real argument** — it stores the unset
 * sentinel and puts the panel back to stock, so a contrast set over the air can be undone.
 */
export const setContrast = (ponPlusOne: number) => [
  0x1a,
  Math.min(8, Math.max(0, Math.round(ponPlusOne))),
]

/* ---- the STOCK settings, which every eQ-3 has ------------------------------------------------- */

/** `cmd 0x11` — the two temperatures the thermostat's own comfort/eco button switches between. */
export const setComfortEco = (comfort: number, eco: number) => [
  0x11,
  Math.round(Math.min(TEMP_MAX, Math.max(TEMP_MIN, comfort)) * 2),
  Math.round(Math.min(TEMP_MAX, Math.max(TEMP_MIN, eco)) * 2),
]

/**
 * `cmd 0x13` — the calibration offset, in degrees C.
 *
 * **STORED AS THE OFFSET PLUS 7, in half degrees** `[binary]`, so 7 is neutral and the device's own
 * menu offers 0..14 = −3.5 … +3.5 °C. The command refuses anything above 15.
 *
 * **On the ORIGINAL firmware this command writes the cell and changes nothing** `[binary]`: stock
 * never updates the RAM copy the reading is actually corrected with, so the offset only appears
 * after a reboot. Our firmware fixes that (`offset_shadow_fix`), which is why the row is worth
 * having at all.
 */
export const OFFSET_MIN = -3.5
export const OFFSET_MAX = 3.5
export const setOffset = (degrees: number) => [
  0x13,
  Math.round(Math.min(OFFSET_MAX, Math.max(OFFSET_MIN, degrees)) * 2) + 7,
]

/**
 * `cmd 0x14` — what the thermostat does when it thinks a window is open.
 *
 * **THE DURATION ARGUMENT IS IN FIVE-MINUTE UNITS**, not minutes: the handler multiplies by five
 * before storing, so the cell reads minutes and the command does not take them `[binary]`.
 *
 * **ZERO IS NOT "OFF", IT IS "UNTIL I SAY"** `[manually verified]`. With a non-zero duration a
 * window closes itself after that many minutes; with zero it holds until closed by hand — and zero
 * also switches the thermostat's own automatic detection off. That is why this row and the Status
 * tab's window control are one subject in two places.
 */
export const WINDOW_STEP_MINUTES = 5
export const WINDOW_MAX_MINUTES = 75
export const setWindowConfig = (temp: number, minutes: number) => [
  0x14,
  Math.round(Math.min(TEMP_MAX, Math.max(TEMP_MIN, temp)) * 2),
  Math.min(15, Math.max(0, Math.round(minutes / WINDOW_STEP_MINUTES))),
]

/**
 * `cmd 0xe0` — may the thermostat guess a window is open from a rapid temperature drop?
 *
 * **THE ARGUMENT NAMES THE FEATURE**: `e0 01` means "it may guess". The cell behind it is
 * `off`-sensed, i.e. the opposite, but that is the firmware's business — `cmd 0x16` reports this
 * flag in the command's own sense, so nothing here inverts anything. Both this and the thermostat's
 * own `oPEn dEtECt` menu row drive one writer, so the two can never disagree. It is a MOD id — the
 * stock handler for it is reclaimed.
 */
export const setAutodetect = (mayGuess: boolean) => [0xe0, mayGuess ? 1 : 0]

/* ---- sounds ---------------------------------------------------------------------------------- */

/**
 * `cmd 0x1B` — play one of the firmware's canned tunes on the valve motor.
 *
 * **THE REPLY FOLLOWS THE SOUND, not the command** `[binary]`: the tone masks interrupts, so the
 * device answers nothing at all while it plays — up to about 1.4 s. A caller must allow for that
 * rather than reading the silence as a failure.
 *
 * The numbers are `jingle_tbl`'s own row order (`tone.asm`), which is the directory and the
 * authority — these names are read off it, not invented. Out of range plays the blip.
 *
 * **THESE FOUR ARE ALL THERE ARE** `[owner]`. The firmware held sixteen and this button offered
 * these four; the other twelve were reachable only by typing a number at the command, which is not
 * a feature anybody had, so they were deleted and these renumbered 0..3. The point of the button is
 * "which radiator am I talking to" — a person needs one recognisable sound at the far end of a
 * flat, not sixteen. The order below is the button's, not the firmware's.
 */
export const JINGLES = [
  { id: 1, name: 'Trill', hint: 'about a second — the one to find a radiator with' },
  { id: 0, name: 'Blip', hint: 'a single tick' },
  { id: 2, name: 'Fanfare', hint: 'ta-da' },
  { id: 3, name: 'Scale', hint: 'an octave, the longest' },
] as const

export const playJingle = (id: number) => [0x1b, id]
