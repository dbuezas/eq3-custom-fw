import { useAtomValue } from 'jotai'
import { Radio } from 'lucide-react'
import { useEffect, useState } from 'react'

import { describeSets } from '@/device/readings'
import { advertAtom } from '@/state/atoms'

import { Alert, AlertDescription } from './ui/alert'

/**
 * WHAT THE THERMOSTAT IS BROADCASTING — all of it, in one table, always the same table.
 *
 * ================================================================================================
 * IT DOES NOT CHANGE SHAPE WHEN THE LINK OPENS `[owner]`
 * ================================================================================================
 * No cards, no filtering, no branch on the link state: every value the broadcast carried, in
 * `device/readings.ts`'s order, whether or not anybody is connected. Hiding the broadcast's copy of
 * the target and the room while connected — on the grounds that the controls above own them, and
 * that two answers differing by a second is worse than one — makes readings VANISH the moment you
 * connect and come back when you disconnect, which reads as data being lost. A panel that says
 * "here is what is on the air" is one thing and stays one thing; the controls below are a different
 * thing, and the header of each says which it is.
 */

/**
 * How old the last broadcast is, in words — or null while it is fresh enough not to mention.
 *
 * TEN SECONDS, against a device that airs about once a second. That is wide enough that an ordinary
 * gap or a missed advert says nothing, and narrow enough that a torn-down stream is named within a
 * few seconds of it happening.
 */
const STALE_AFTER_MS = 10_000

function staleness(lastAt: number | null, now: number): string | null {
  if (lastAt === null) return null
  const s = Math.round((now - lastAt) / 1000)
  if (s * 1000 < STALE_AFTER_MS) return null
  return s < 90 ? `${s} seconds` : `${Math.round(s / 60)} minutes`
}

export function LiveValues() {
  const adv = useAtomValue(advertAtom)
  // A tick, because staleness is a function of the clock and nothing else re-renders when the
  // broadcasts STOP — which is precisely the case being reported.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 2000)
    return () => clearInterval(t)
  }, [])
  const stale = staleness(adv.lastAt, now)
  const sets = describeSets(adv.values)

  return (
    <section className="space-y-2">
      <h2 className="text-xs uppercase tracking-wide text-muted-foreground">
        What it is broadcasting
      </h2>

      {/* ONE COLUMN PER ADVERT `[owner]`, and every field has a row from the first render, empty
          ones included. The grouping is not a layout choice: the thermostat alternates two object
          sets about a second apart and never sends them together, so the columns are what actually
          arrives, and a whole column of dashes says WHICH of the two has not been heard. A table
          built only from what has arrived would instead grow from four rows to nine while somebody
          watches it. A dash is a value not heard yet; it is not an error and it rearranges nothing.

          The hairline between them is a 1px gap over a border-coloured backing rather than a border
          on either column, so it stays a single rule however unequal the two lists are. */}
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border bg-border text-sm">
        {sets.map((rows, i) => (
          <dl key={i} className="divide-y bg-card">
            {rows.map((r) => (
              <div key={r.key} className="flex items-baseline justify-between gap-2 px-3 py-2">
                <dt className="truncate text-muted-foreground">{r.label}</dt>
                <dd className="shrink-0 font-medium tabular-nums">
                  {r.text ?? <span className="text-muted-foreground">—</span>}
                </dd>
              </div>
            ))}
          </dl>
        ))}
      </div>

      <p className="flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
        {adv.count === 0 ? (
          <>
            <Radio className="size-3" /> nothing heard yet — it airs about once a second, connected
            or not
          </>
        ) : (
          <>
            {adv.count} broadcast{adv.count === 1 ? '' : 's'}
            {adv.rssi !== null && ` · ${adv.rssi} dBm`}
            {/* WITH NO READINGS IN THE ADVERT, the rest of this line is about a payload that is not
                there — a counter and a set count would both read as 0 and invite the conclusion
                that something failed. The thermostat is heard; its broadcast is switched off. */}
            {!adv.sensorData ? (
              ' · broadcast off — every field below is waiting for it to be switched back on'
            ) : (
              <>
                {adv.counter !== null ? ` · counter ${adv.counter}` : ' · plain'}
                {adv.setsSeen < 2 && ` · ${adv.setsSeen} of 2 field sets seen`}
              </>
            )}
          </>
        )}
      </p>

      {/* THESE READINGS CAN BE STALE AND LOOK EXACTLY LIKE FRESH ONES, which is the failure this
          line exists to end. The thermostat broadcasts about once a second, so anything older than
          a few seconds means the stream stopped — and the usual cause is not the device: advert
          delivery is torn down when the tab is hidden, occluded or MERELY unfocused, while the
          browser still reports the watch as active (`device/advert.ts`, trap 2). Returning to the
          tab re-arms it, which is why it "fixes itself" and why the age is the only way to know it
          ever happened. */}
      {stale !== null && (
        <Alert variant="warn">
          <AlertDescription>
            These readings are {stale} old. The thermostat broadcasts every second, so the stream
            has stopped — usually because this tab lost focus. Come back to it and it resumes.
          </AlertDescription>
        </Alert>
      )}
    </section>
  )
}
