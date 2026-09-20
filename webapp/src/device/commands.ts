/**
 * Every command this app sends, built in one place.
 *
 * A builder here returns the bytes and nothing else — no transport, no queue, no device. That is
 * what makes them testable, and it keeps `link.ts`'s `request()` the only door to the radio.
 *
 * **THE HOST WRITES ONLY THE BYTES IT MEANS.** The thermostat's length gate wants a whole frame,
 * but the radio chip is what builds one: it pads what a host writes out to the id's relay length.
 * Measured — `cmd 0x00` is a one-byte write and answers normally.
 *
 * **THE APP VALIDATES, BECAUSE STOCK DOES NOT.** `cmd 0x41` writes whatever arrives straight into
 * the setpoint on a stock thermostat: 127.5 °C was accepted, displayed, and held the valve wide
 * open against a target no room reaches — indistinguishable from a thermostat that has stopped
 * responding. Our firmware clamps at the commit point, but a client meets both, so every value
 * leaves here already inside the device's own range.
 */

/** The thermostat's own limits `[binary]`: 4.5 is its "off" and 30.0 its "on". */
export const TEMP_MIN = 4.5
export const TEMP_MAX = 30
export const TEMP_STEP = 0.5

/** Degrees C → the device's half-degree byte, clamped and snapped to the step. */
export function tempByte(c: number): number {
  const clamped = Math.min(TEMP_MAX, Math.max(TEMP_MIN, c))
  return Math.round(clamped * 2)
}

/** The two ends read as words on the glass, so they read as words here too. */
export const tempText = (c: number) =>
  c <= TEMP_MIN ? 'Off' : c >= TEMP_MAX ? 'On' : `${c.toFixed(1)}°`

/**
 * `cmd 0x41` — set the target temperature, and NOTHING else.
 *
 * Chosen over `cmd 0x40` for this control because `0x40`'s argument packs the mode into its top two
 * bits, so setting a temperature with it also sets a mode `[binary]`. The app shows those as two
 * separate controls, so it sends them as two separate commands.
 */
export const setTemperature = (c: number) => [0x41, tempByte(c)]

/**
 * `cmd 0x40` — the mode, with no temperature change.
 *
 * The argument is `mode << 6 | sub`, and `sub` 0 means "change no temperature" `[binary]` — the
 * other sub values load the eco, comfort or window temperature, which are their own controls.
 *
 * **VACATION IS NOT OFFERED.** Its form carries an end date and time in four further bytes, and a
 * mode that silently ends at an unstated moment is worse than no control at all. The app SHOWS
 * vacation when a thermostat is in it, because that is a fact about the device.
 */
export const setMode = (mode: 'auto' | 'manual') => [0x40, mode === 'manual' ? 0x40 : 0x00]

/** `cmd 0x45` — boost on or off. */
export const setBoost = (on: boolean) => [0x45, on ? 1 : 0]

/**
 * `cmd 0x80` — the child lock, the same one the eQ-3 app and Home Assistant use.
 *
 * **The flag is the FIRST argument byte and the second is ignored** `[manually verified]` — a
 * plausible reading of the two-argument frame is that the second one carries it, and it does not.
 */
export const setLock = (on: boolean) => [0x80, on ? 1 : 0, 0]

/**
 * `cmd 0x30` — tell the thermostat a window is open, or closed.
 *
 * **IT ANSWERS NOTHING AT ALL** `[binary]`, `[manually verified]`. Its handler ends without ever
 * calling the status builder, unlike every other control here — so it must be SENT, never
 * requested: waiting for a reply would time out every attempt and report a command that worked as
 * a failure. The effect shows up in the device's own ~1 Hz status push, within a second. Measured:
 * a 2-byte `30 01` moved the target from 17.0 to 12.0 °C and `30 00` put it back, with no reply to
 * either. (The radio chip pads the write out to the 16 bytes this id's length gate wants, which is
 * why two bytes are enough.)
 *
 * **HOW LONG IT STAYS OPEN IS THE OWNER'S OWN `Win` DURATION, not this command's** — `setWindowConfig`
 * in `device/config.ts` owns that rule. So the app must not present this as a switch that stays where
 * it is put: the device may close it on its own, and the status push is what says so.
 */
export const setWindow = (open: boolean) => [0x30, open ? 1 : 0]

/**
 * Jump the target to the stored comfort or eco temperature — `cmd 0x43` and `cmd 0x44`.
 *
 * **THESE ARE THE THERMOSTAT'S OWN COMFORT BUTTON**, the one on the glass that toggles between the
 * two saved temperatures, and they are why the two VALUES are worth setting in the Settings tab at
 * all: without a way to select them, a saved pair is a pair of numbers nothing reaches.
 *
 * They carry no argument — the temperature is the one already stored — and they answer with the
 * ordinary status reply, so the page updates from the device rather than from what the button
 * hoped. Changing the two values is `setComfortEco` in `device/config.ts` (`cmd 0x11`); these only
 * choose between them.
 */
export const selectComfort = () => [0x43]
export const selectEco = () => [0x44]
