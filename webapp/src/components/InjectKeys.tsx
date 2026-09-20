import { useEffect, useRef, useState } from 'react'

import { BOOST, MODE, PA0, WHEEL_CCW, WHEEL_CW, setOf } from '@/device/panel'
import { buzz } from '@/lib/haptics'
import { cn } from '@/lib/utils'

import { Button } from './ui/button'

/**
 * The thermostat's own buttons, pressed by pressing them.
 *
 * ================================================================================================
 * HOLD IS HOLDING, NOT A DURATION YOU PICK `[owner]`
 * ================================================================================================
 * A tap sends `hold 0`, which is a real tap: the firmware releases each armed bit the instant a
 * read has shown it, so the press is as short as the device's own poll. **Keep the button down past
 * the dwell and the release sends a long press instead** — the fill across the button is how far
 * through you are, and reaching the end is the moment letting go becomes the long gesture.
 *
 * **The dwell is the PLATFORM's 500 ms, not the firmware's 1.25 s.** It only decides which command
 * to send, so it should feel like every other long-press on the phone; what reaches the device is
 * `hold 4` = 2 s, which clears the firmware's threshold while staying under stock's ~3 s BOOST
 * pairing hold. Mirroring 1.25 s here would only make it feel slow.
 *
 * **THE LAYOUT IS THE DEVICE'S.** On this head the wheel IS the boost button — turn left, press,
 * turn right — so those three are one row and coloured as one control, with MODE and COMFORT under
 * them. A detent is not a press and has no long form.
 *
 * **THE CHILD-LOCK GRIP HAS NO BUTTON.** Hold MODE and COMFORT together, the way you would on the
 * device, and lifting either sends `0x86` once and consumes both — so neither also fires on its
 * own. The single-button codes arm one pin at a time, which is why that bitmask form is the only
 * way to close both contacts at once.
 *
 * Every one of the touch defences below is load-bearing: without them the phone runs its own
 * long-press detection at ~500 ms and buzzes half a second before the fill is done, which looks
 * exactly like the button firing early.
 */

/** Android's long-press, and the only thing this timing has to match. */
const DWELL_MS = 500
/** What reaches the device: a tap, or 2 s. Half-seconds, as `cmd 0x19` takes them. */
const SHORT_HS = 0
const LONG_HS = 4
/** MODE + the PA0 button closed together. */
const GRIP = setOf(0b110)

type Key = { what: number; label: string; turn?: true }

const ROW_WHEEL: Key[] = [
  { what: WHEEL_CCW, label: '↶ left', turn: true },
  { what: BOOST, label: 'BOOST' },
  { what: WHEEL_CW, label: 'right ↷', turn: true },
]
const ROW_BUTTONS: Key[] = [
  { what: MODE, label: 'MODE' },
  { what: PA0, label: 'COMFORT' },
]

type Held = { what: number; t0: number; armed: boolean; turn: boolean }

const gripping = (held: Map<number, Held>) => held.has(MODE) && held.has(PA0)

/**
 * Grow every held button's fill until its dwell is up, then keep going until the last finger lifts.
 *
 * OUTSIDE THE COMPONENT on purpose: it reads the clock and schedules itself, and a function that
 * does either has no business being defined during a render. It is handed the mutable map and the
 * setter instead, which is all it needs.
 */
function runFill(
  held: Map<number, Held>,
  setFill: (f: Record<number, number>) => void,
  raf: { current: number },
): number {
  const step = () => {
    const now = performance.now()
    const next: Record<number, number> = {}
    for (const h of held.values()) {
      if (h.turn) continue
      // BOTH FINGERS SHARE ONE CLOCK. If MODE and COMFORT are down together the fill has to mean
      // the grip, not either button, so it runs from whichever went down LAST — otherwise the first
      // would already be part-filled when the second arrived and the pair would arm early.
      const t0 =
        gripping(held) && (h.what === MODE || h.what === PA0)
          ? Math.max(held.get(MODE)!.t0, held.get(PA0)!.t0)
          : h.t0
      const pct = Math.min(100, ((now - t0) / DWELL_MS) * 100)
      next[h.what] = pct
      if (pct >= 100 && !h.armed) {
        h.armed = true
        // Two buzzes that must be tellable apart: 10 ms on touch says "registered", this longer one
        // says "let go now and it is a long press". Once per gesture, not per button.
        if (!gripping(held) || h.what === MODE) buzz(40)
      }
    }
    setFill(next)
    raf.current = held.size ? requestAnimationFrame(step) : 0
  }
  return requestAnimationFrame(step)
}

/**
 * IT HAS NO `disabled` OF ITS OWN `[owner]`. Whether these buttons may be used is a question about
 * the DEVICE, and `caps.ts` is the only thing in this app allowed to answer one — the `Gate` around
 * the Display tab makes this whole block inert when the link is down.
 */
export function InjectKeys({
  onPress,
}: {
  /** `hold` is in half-seconds: 0 is a tap, 4 is two seconds. */
  onPress: (what: number, hold: number, label: string) => void
}) {
  const held = useRef(new Map<number, Held>())
  // The fills, and which buttons are armed — the only state that renders.
  const [fill, setFill] = useState<Record<number, number>>({})
  const raf = useRef(0)

  const start = () => {
    if (!raf.current) raf.current = runFill(held.current, setFill, raf)
  }

  useEffect(() => () => cancelAnimationFrame(raf.current), [])

  const down = (k: Key) => (e: React.PointerEvent<HTMLButtonElement>) => {
    if (held.current.has(k.what)) return
    e.preventDefault() // a touch-hold must not select text or open a menu
    e.currentTarget.setPointerCapture?.(e.pointerId) // ...and must still fire up() if it slides off
    buzz(10)
    held.current.set(k.what, { what: k.what, t0: performance.now(), armed: false, turn: !!k.turn })
    start()
  }

  const up = (k: Key) => () => {
    const h = held.current.get(k.what)
    if (!h) return
    // THE GRIP WINS: lifting either finger of a MODE+COMFORT hold sends the combo once and consumes
    // both, matching the device, where two contacts closed together are one gesture rather than two
    // presses that happen to overlap.
    if (gripping(held.current) && (h.what === MODE || h.what === PA0)) {
      const other = held.current.get(h.what === MODE ? PA0 : MODE)!
      const hold = h.armed || other.armed ? LONG_HS : SHORT_HS
      held.current.clear()
      setFill({})
      onPress(GRIP, hold, 'MODE + COMFORT')
      return
    }
    const hold = h.armed ? LONG_HS : SHORT_HS
    held.current.delete(h.what)
    setFill((f) => ({ ...f, [h.what]: 0 }))
    onPress(k.what, hold, k.label)
  }

  const cancel = (k: Key) => () => {
    held.current.delete(k.what)
    setFill((f) => ({ ...f, [k.what]: 0 }))
  }

  const render = (k: Key) => {
    const pct = fill[k.what] ?? 0
    const armed = pct >= 100
    return (
      <Button
        key={k.what}
        variant="outline"
        onPointerDown={down(k)}
        onPointerUp={up(k)}
        onPointerCancel={cancel(k)}
        onContextMenu={(e) => e.preventDefault()}
        className={cn(
          'relative h-14 flex-1 select-none overflow-hidden',
          // `touch-none` is the one that stops the phone running its OWN long-press at ~500 ms.
          'touch-none',
          k.turn ? 'text-sky-200' : 'text-foreground',
          armed && 'ring-2 ring-primary',
        )}
      >
        {/* The fill is a hard-edged block rather than an animation, so it tracks the finger exactly:
            what it shows is elapsed hold, and the end is when the release becomes a long press. */}
        <span
          aria-hidden
          className={cn(
            'absolute inset-y-0 left-0',
            k.turn ? 'bg-sky-500/25' : 'bg-primary/25',
          )}
          style={{ width: `${pct}%` }}
        />
        <span className="relative">{k.label}</span>
      </Button>
    )
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2">{ROW_WHEEL.map(render)}</div>
      <div className="flex gap-2">{ROW_BUTTONS.map(render)}</div>
      <p className="text-xs text-muted-foreground">
        Tap for a press. Hold until the button fills for a long press — and hold MODE and COMFORT
        together for the child lock, as you would on the thermostat.
      </p>
    </div>
  )
}
