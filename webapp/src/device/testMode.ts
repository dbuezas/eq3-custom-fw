import type { KeyStatus } from './access'
import type { AdvName } from './advname'
import { ADV_NORMAL, DESCALE_WEEKLY, type Settings } from './config'
import type { Status } from './status'

/**
 * `?test=1` — drive the whole app from a made-up thermostat, away from any radio.
 *
 * ================================================================================================
 * IT IS NOT LINKED FROM ANYWHERE, AND THAT IS THE DESIGN `[owner]`
 * ================================================================================================
 * Add `?test=1` to any address by hand. There is no button that turns it on, because it is for
 * working on the UI rather than for using a thermostat. A banner sits at the top of every screen
 * for as long as it is on, and its one button leaves.
 *
 * **IT LATCHES AT LOAD**, so navigating on with the query string gone keeps the mode; only a reload
 * without `?test=1` ends it, which is what the banner does.
 *
 * **NOTHING PERSISTENT IS TOUCHED.** No registry write, no key, no storage: the mode fills the
 * connection's atoms and a reload is a clean slate. The thermostats in the list are the real saved
 * ones, because opening one is how the tabs are reached — opening it connects to this instead.
 *
 * ================================================================================================
 * IT ANSWERS AT THE MODEL LEVEL, NOT IN BYTES
 * ================================================================================================
 * Everything the connection knows now lives in an atom (`link.ts`), so the mode fills those with
 * plain objects rather than forging frames for the decoders to parse. That matters: a second set of
 * hand-written frames would be a second spec of the wire, and the app would then have two — one of
 * which nothing on a radio ever checks.
 *
 * **The programme is the exception**, because seven day reads have no atom behind them. Its frames
 * are the shortest thing `decodeDay` accepts and nothing else forges one.
 */

/** Whether this page load asked for test mode. Read ONCE — see the header. */
export const TEST_MODE =
  typeof location !== 'undefined' && new URLSearchParams(location.search).get('test') === '1'

/** Leave: the same address without the flag, loaded fresh so the latch above clears. */
export const exitTestMode = () => location.assign(location.pathname + location.hash)

/** Everything the made-up thermostat says about itself, in the app's own types. */
export const TEST_DEVICE = {
  fw: 200,
  chip: { product: 0x1000, major: 5, minor: 0 },
  /** Aired as `eQ3-Test`, which is what the Install tab shows. */
  advName: { name: 'Test', max: 15, error: null } satisfies AdvName,
  /** Broadcast on, gate off, no key: what a thermostat ships as, and what both switches move from. */
  keyStatus: {
    present: false,
    advertEncrypted: false,
    storeRead: true,
    broadcastOn: true,
    pinGateOn: false,
    mac: '00:1a:22:aa:bb:cc',
  } satisfies KeyStatus,
  settings: {
    comfort: 21,
    eco: 17,
    offset: 0,
    windowTemp: 12,
    windowMinutes: 15,
    boostMinutes: 5,
    boostPercent: 80,
    screenMask: 0x01,
    screenSeconds: 3,
    contrast: 4,
    windowAutoDetect: true,
    // The descaling run as a thermostat leaves the factory: every week, whatever the
    // battery says. Both are the values an unconfigured device really reports, not placeholders.
    descale: DESCALE_WEEKLY,
    descaleBatterySkip: false,
  } satisfies Settings,
  /** Not part of `Settings` — `cmd 0x16` does not carry it, so it is a field of its own here too. */
  advInterval: ADV_NORMAL,
  status: {
    mode: 'auto',
    boost: false,
    dst: true,
    window: false,
    lock: false,
    batteryLow: false,
    valve: 30,
    uiState: 4,
    setpoint: 21,
    at: 0,
  } satisfies Omit<Status, 'at'> & { at: number },
}

/**
 * A whole day at one temperature — `21 <day> (temp*2, minutes/10) x 7`, every slot to midnight
 * (1440 / 10 = 144). Weekdays warm and the weekend cooler, so the editor opens on a week with more
 * than one shape in it.
 */
const flatDay = (day: number, temp: number) =>
  [0x21, day, ...Array.from({ length: 7 }, () => [Math.round(temp * 2), 144]).flat()]

/**
 * What the made-up thermostat answers to a command, or null for "it said nothing".
 *
 * Null is a real answer here as well as on a radio: a command with nothing behind it shows the
 * app's own "did not answer" path, which is worth being able to look at.
 */
export function testReply(bytes: number[]): number[] | null {
  const [id, arg] = bytes
  if (id === 0x20) return flatDay(arg ?? 0, arg === 0 || arg === 1 ? 17 : 21)
  return null
}
