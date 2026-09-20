/**
 * The thermostat's status reply — what almost every command answers with, decoded once here.
 *
 * ================================================================================================
 * IT IS BOTH A REPLY AND A BROADCAST
 * ================================================================================================
 * The device pushes one of these about once a second without being asked, AND every setting command
 * ends in the same builder — so a command's own reply already carries the new state, and the page
 * never needs a follow-up read. `link.ts` publishes both through here.
 *
 * **THE PUSH IS NOT A GUARANTEE, AND A CONTROL MAY NOT WAIT FOR ONE** `[manually verified]`. It
 * comes from `main_loop`'s periodic path, which does not run until the thermostat is past date
 * entry and is not sitting on a fault screen — so a device in either state answers commands
 * perfectly and pushes nothing at all. Measured: a connection held for 15 s against a unit whose
 * date was unset received ZERO notifications with nothing sent. That is why
 * `StatusControls` never disables a control for want of one: the BThome broadcast carries the same
 * target, needs no connection, and a person can set a temperature without having read the old one.
 *
 * ON THE WIRE, measured on a bench unit `[manually verified]`:
 *
 *     02 01 <status> <valve%> <ui state> <setpoint> …
 *
 * The `FD` frame marker and the CRC are stripped before a host sees it, which is why byte 0 is the
 * type rather than `FD`. Bytes past the setpoint are not decoded: `../../../PROTOCOL.md` documents them only
 * for vacation mode, and reading meaning into the rest would be inventing it.
 *
 * WHAT IS NOT IN IT: the measured room temperature. The reply carries the SETPOINT; the room's own
 * reading reaches a client through the BThome broadcast (`advert.ts`) and nowhere else on this
 * channel. Do not reach for a memory read to close that gap — `device/protocol.ts`'s header says
 * why an address has no place in this app.
 */
import type { Match, Reply } from './protocol'

export type Mode = 'auto' | 'manual' | 'vacation'

export type Status = {
  mode: Mode
  /** A boost is running. */
  boost: boolean
  /** The device applies the European daylight-saving change to its own clock. */
  dst: boolean
  /** A window is open — either the thermostat's own detector, or told so with `cmd 0x30`. */
  window: boolean
  /** The buttons on the device are locked. */
  lock: boolean
  batteryLow: boolean
  /** How far the valve is open, already a rounded percent on the device. */
  valve: number
  /** Where the device is in its boot sequence; 4 is running. `stm8/docs/12_boot_sequence.md`. */
  uiState: number
  /** Degrees C. The device stores half-degree steps, which is what the 2 is. */
  setpoint: number
  /** When this arrived, so a view can say how fresh it is. */
  at: number
}

export const STATUS_TYPE = 0x02

/** The status reply, and the unsolicited push, are the same frame. */
export const isStatus: Match = (b) => b.length >= 6 && b[0] === STATUS_TYPE

/**
 * The two mode bits, in order. **The BROADCAST carries the same field**: the radio chip builds its
 * `0x09` object as `status & 3` `[binary]` (`ble_chip/mod/bthome.S`), so `readings.ts` names it from
 * this table rather than keeping a second copy that could disagree about what `1` means.
 */
export const MODES: Mode[] = ['auto', 'manual', 'vacation']

export function decodeStatus(b: Reply): Status | null {
  if (!isStatus(b)) return null
  const s = b[2]!
  return {
    mode: MODES[s & 3] ?? 'auto',
    boost: !!(s & 0x04),
    dst: !!(s & 0x08),
    window: !!(s & 0x10),
    lock: !!(s & 0x20),
    batteryLow: !!(s & 0x80),
    valve: b[3]!,
    uiState: b[4]!,
    setpoint: b[5]! / 2,
    at: Date.now(),
  }
}

/**
 * `cmd 0x03` — set the date and time. Six bytes, in the device's own order.
 *
 * SEND PLAIN LOCAL TIME. The thermostat keeps wall-clock time and applies the European
 * daylight-saving change to its OWN clock at the boundary, exactly as a browser's local time moves
 * — so there is no second shift to compensate for. Measured: 22:46:07 sent, 22:46:07 read back out
 * of the soft-RTC cells, with auto-DST on `[manually verified]`.
 *
 * THE HOST VALIDATES, BECAUSE THE DEVICE DOES NOT (`../../../PROTOCOL.md`, `0x03`) — a month above 12 is
 * stored and gives a garbage weekday, which in auto mode runs the wrong day's programme for up to a
 * month. A `Date` cannot produce one, which is exactly why the clock is taken from one.
 */
export function setDateTime(d: Date): number[] {
  return [
    0x03,
    d.getFullYear() % 100,
    d.getMonth() + 1,
    d.getDate(),
    d.getHours(),
    d.getMinutes(),
    d.getSeconds(),
  ]
}
