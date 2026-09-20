/**
 * Green → yellow → red, interpolated, for the two numbers that say whether a thermostat is really
 * there: how well it is heard, and how long ago it last spoke.
 *
 * **THE THRESHOLDS ARE THE OWNER'S** `[owner]` and are not derived from anything, so they live here
 * once rather than in each component that paints a number:
 *
 *   signal   green at −70 dBm or better · yellow at −80 · red at −90 or worse
 *   age      green at 1 s or less · yellow at 3 s · red at 5 s or more
 *
 * **INTERPOLATED THROUGH HUE, NOT THROUGH RGB.** Mixing green and red as numbers passes through a
 * muddy brown; walking the hue circle from green to red passes through yellow, which is the middle
 * stop being asked for. So the middle stop costs no special case — it is simply where the hue
 * already is.
 */

/** Hue stops: 140 is a green that is not mistaken for the accent, 48 a gold, 0 red. */
const GOOD = 140
const MID = 48
const BAD = 0

/**
 * ONE LIGHTNESS FOR BOTH THEMES, chosen rather than inherited. A bright yellow is invisible on white
 * and a dark one is invisible on the dark ground, so the ramp sits at a middle lightness that keeps
 * every hue legible on either — the point is a value a person can read, not the most saturated
 * possible colour. Tailwind's `text-green-500` and friends are three discrete classes; this is a
 * continuous ramp.
 */
const hsl = (h: number) => `hsl(${h.toFixed(0)} 70% 45%)`

/** `v` mapped onto the hue ramp, clamped at both ends. `good` and `bad` may be in either order. */
function ramp(v: number, good: number, mid: number, bad: number): string {
  const between = (a: number, b: number, ha: number, hb: number) =>
    ha + ((v - a) / (b - a)) * (hb - ha)
  const rising = bad > good
  if (rising ? v <= good : v >= good) return hsl(GOOD)
  if (rising ? v >= bad : v <= bad) return hsl(BAD)
  return hsl((rising ? v <= mid : v >= mid) ? between(good, mid, GOOD, MID) : between(mid, bad, MID, BAD))
}

/**
 * The colour for an RSSI, which arrives NEGATIVE. Taking its magnitude is the whole conversion, and
 * it is done here so no caller has to remember that −90 is worse than −70.
 */
export const signalTint = (rssi: number): string => ramp(Math.abs(rssi), 70, 80, 90)

/** The colour for an age in SECONDS. */
export const ageTint = (seconds: number): string => ramp(seconds, 1, 3, 5)

/**
 * The ramp's three stops on their own, for things that are GOOD / SO-SO / BAD rather than measured —
 * a firmware version is the newest, old enough to still be worth running, or neither. Reusing the
 * stops keeps one palette across the app: the same green in the version badge as in a strong signal.
 */
export const GOOD_TINT = hsl(GOOD)
export const MID_TINT = hsl(MID)
export const BAD_TINT = hsl(BAD)
