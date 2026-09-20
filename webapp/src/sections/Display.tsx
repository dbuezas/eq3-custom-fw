import { useAtomValue } from 'jotai'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { log } from '@/state/log'
import { Gate } from '@/components/Gate'
import { InjectKeys } from '@/components/InjectKeys'
import { PanelArt } from '@/components/PanelArt'
import { panelAtom, request } from '@/device/link'
import {
  PANEL_CANCEL,
  PANEL_LEASE,
  PANEL_RENEW_MS,
  isPanel,
  isPressReply,
  lit,
  press,
  readPanel,
} from '@/device/panel'
import { DAYS, SEGMAP, SYM_A, SYM_B } from '@/device/lcd_tables'
import { cn } from '@/lib/utils'
import { connectedAtom } from '@/state/atoms'

/**
 * THE MIRROR IS NOT SAMPLED, so there is no rate here to get wrong.
 *
 * It used to poll, and the number that took was delicate: the thermostat redraws about once a
 * second, so a period near that does not merely lag, it ALIASES — the two rates drift past each
 * other, whole frames are never sampled, and on screen that is a mirror that skips. The thermostat
 * now SENDS the glass when it changes, so the screen and the mirror share one clock, which is the
 * device's. `panel.ts`'s `PANEL_RENEW_MS` is the only interval left, and it keeps the subscription
 * alive rather than deciding what is seen.
 */

/**
 * WHICH SVG ELEMENT EACH GROUP-A ICON IS — the only thing this file owns about the panel, because
 * it is the only part that does not follow the firmware tables.
 *
 * **Index 4 is absent on purpose.** It is the phantom: a table entry for a crosspoint this glass
 * does not implement, so there is no element and lighting it would draw a segment that cannot
 * exist. `stm8/docs/10_lcd_panel.md` is the legend.
 */
const ICON_ELEMENT: Record<number, string> = {
  0: 'suitcase', 1: 'moon', 2: 'sun', 3: 'degree', 5: 'window', 6: 'battery',
  7: 'dp-after-2', 8: 'dp-after-3', 9: 'colon', 10: 'Manu', 11: 'Auto',
  12: 'pct', 13: 'hour-ticks',
}

/**
 * The thermostat's screen as it actually is, and its buttons.
 *
 * ================================================================================================
 * THIS TAB ASKS FOR NOTHING REPEATEDLY — the thermostat SENDS the glass when it changes
 * ================================================================================================
 * The only traffic this tab makes is a lease renewal, and its whole job is to keep the subscription
 * alive; what appears on screen is decided by the device. That removes the hazard this file used to
 * be: a refresh timer beside a button tap and a retrying request was the three-producer overlap
 * that made the depth-one write queue necessary, and a timer feeding retryable reads could build a
 * backlog of frames already stale by the time they ran.
 *
 * **WHAT BOUNDS THE COST IS THE TAB, NOT A SWITCH** `[owner]`. A renewal wakes the STM8 and holds
 * it out of HALT, which is the most expensive thing measurable on this hardware — so the
 * subscription lives while you are looking at it and is CANCELLED the moment you leave, which is
 * what a switch would achieve without a switch to forget. Nothing in the app polls.
 */
export function Display() {
  const connected = useAtomValue(connectedAtom)
  // READ, never held. The thermostat pushes the glass to `link.ts`, which owns the atom — so this
  // tab has no copy to keep current and no read to schedule.
  const bits = useAtomValue(panelAtom)

  /**
   * WHETHER THE LAST RENEWAL WAS ANSWERED — this tab's own knowledge about its own subscription,
   * which is why it is `useState` and not an atom. It is not something the thermostat told us, and
   * it DIES WITH THE COMPONENT in the strongest sense available: the cleanup cancels the lease, so
   * once this tab is gone the fact has no subject left to be about.
   *
   * It starts `true` so re-entering the tab does not blink the glass grey for the one round trip
   * the arming renewal takes.
   */
  const [answered, setAnswered] = useState(true)

  /**
   * THE LEASE. This tab does not read the panel; it asks to be SENT it, and keeps asking.
   *
   * **A LEASE RATHER THAN A SWITCH, and that is the thermostat's constraint rather than a
   * preference** — it is never told the phone hung up, so a subscription that could not lapse would
   * leave it pushing frames to nobody for the rest of its battery. It expires about 10 s after the
   * last renewal; `PANEL_RENEW_MS` carries the spacing and what its margin is worth.
   *
   * **EVERY RENEWAL ANSWERS UNCONDITIONALLY**, so this loop is also the repair for a push that went
   * missing — which is why there is no backstop poll here. The arm is what puts the first frame on
   * screen, so nothing extra is needed at mount either.
   *
   * The cleanup CANCELS rather than just letting it lapse: closing the tab should stop the traffic
   * now, not when the lease happens to run out.
   *
   * **THE RENEWAL IS ALSO THE LIVENESS TEST, and it is the only one there is.** Every renewal
   * answers unconditionally, so a renewal that comes back empty is the thermostat having gone
   * quiet — and it is the FIRST thing that notices, because a lapsed lease produces no event at
   * all: the pushes simply stop and the glass would otherwise sit there showing a screen from
   * seconds ago with nothing to say so. One unanswered renewal dims the glass `[owner]`.
   */
  useEffect(() => {
    if (!connected) return
    let live = true

    const renew = async () => {
      const r = await request(readPanel(PANEL_LEASE), isPanel, 1)
      if (live) setAnswered(r !== null)
    }
    void renew()
    const timer = setInterval(() => void (live && renew()), PANEL_RENEW_MS)

    return () => {
      live = false
      clearInterval(timer)
      void request(readPanel(PANEL_CANCEL), isPanel, 1)
    }
  }, [connected])

  /**
   * Send a press. `hold` is in half-seconds and comes from how long the button was held.
   *
   * **IT DOES NOT RE-READ THE PANEL, and that is the point of the lease.** A press causes a
   * repaint, a repaint causes a push — so asking for what the thermostat is already about to send
   * would be a wasted round trip, and this used to take TWO of them, after waiting out the hold.
   *
   * It also removes a thing that had to be got right: a button shows its effect only on RELEASE
   * `[manually verified]`, so a read fired too early drew the screen as it was and looked like
   * nothing happened. The push has no such timing to guess at — it arrives when the glass actually
   * changes.
   */
  const tap = async (what: number, hold: number, label: string) => {
    const r = await request(press(what, hold), isPressReply)
    if (!r) log(`${label}: the thermostat did not answer`)
  }

  return (
    <Gate need="modThermostat" className="space-y-4">
      {/* THE GLASS IS THE READOUT. The digits are drawn as segments, so printing them again as
          text underneath said the same thing twice `[owner]`. `panelText` still exists and is
          still tested — it is what holds this app's font table to `stm8/ble/lcd_read.py`'s. */}
      <section className="overflow-hidden rounded-xl border bg-card p-3">
        <Glass bits={bits} live={answered} />
      </section>

      <section className="space-y-2">
        {/* The `Gate` above is what makes these buttons inert — `modThermostat` fails on a dropped
            link before it looks at a version — so `InjectKeys` takes no `disabled`. */}
        <InjectKeys onPress={(what, hold, label) => void tap(what, hold, label)} />
      </section>
    </Gate>
  )
}

/**
 * Which element ids are lit, for one panel snapshot: a bit address out of the generated tables,
 * against the ids `PanelArt` is contracted to. Nothing here decides what a segment means.
 */
export function litIds(bits: Uint8Array | null): ReadonlySet<string> {
  const on = new Set<string>()
  if (!bits) return on
  SYM_B.forEach((bit, i) => lit(bits, bit) && on.add(`bar${i}`))
  DAYS.forEach((bit, i) => lit(bits, bit) && on.add(`day${i}`))
  SYM_A.forEach((bit, i) => {
    const id = ICON_ELEMENT[i]
    if (id && lit(bits, bit)) on.add(id)
  })
  SEGMAP.forEach((slot, i) =>
    slot.forEach((bit, k) => lit(bits, bit) && on.add(`d${i}.${'abcdefg'[k]}`)),
  )
  return on
}

/**
 * The glass itself. `PanelArt` is the drawing as ordinary tags, so there is nothing to parse and no
 * effect keeping a DOM in step: lighting a segment is a class name, and React changes what moved.
 *
 * **DIMMED MEANS "THIS IS NOT LIVE", and it says that for both of its reasons** — no frame has
 * arrived yet, or the frames have stopped coming. They are one thing to a person looking at it, so
 * they get one appearance; splitting them would be the app explaining its own plumbing.
 */
function Glass({ bits, live }: { bits: Uint8Array | null; live: boolean }) {
  const on = useMemo(() => litIds(bits), [bits])
  const cls = useCallback((id: string, base: string) => (on.has(id) ? `${base} on` : base), [on])
  return (
    <div className={cn('lcd-host', (!bits || !live) && 'opacity-50')}>
      <PanelArt cls={cls} />
    </div>
  )
}
