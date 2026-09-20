import { useAtomValue } from 'jotai'
import { ChevronDown } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import { SUPPORTED, reportFor, watch } from '@/device/advert'
import {
  HAS_BLUETOOTH,
  HAS_GET_DEVICES,
  grantedDevices,
  grantedIdsAtom,
  refreshGranted,
  watchTroubleAtom,
} from '@/device/link'
import { advertsAtom, registryAtom } from '@/state/atoms'

import { Button } from './ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible'

/**
 * The four facts that decide whether a saved row can show readings — PRINTED RATHER THAN REASONED
 * ABOUT. A row shows readings only when THREE ids line up: the one `getDevices()` hands back, the
 * one a watch is keyed under, and the one stored on the row. Any two of them matching is not enough,
 * and every mismatch looks identical from the outside — a row with no numbers — which is how one
 * blank phone produced two contradictory theories in a session. So this shows the ids themselves.
 *
 * It is deliberately plain text: the point is that it can be read out loud.
 */
export function AdvertDiagnostics() {
  const rows = useAtomValue(registryAtom)
  const adverts = useAtomValue(advertsAtom)
  const granted = useAtomValue(grantedIdsAtom)
  const trouble = useAtomValue(watchTroubleAtom)

  /** The button, which re-asks AND starts the watches — the same call the rest of the app makes. */
  const recheck = useCallback(() => refreshGranted().then(() => {}), [])

  /**
   * THE RE-ARM EXPERIMENT: do broadcasts come back if the watch is restarted WHILE CONNECTED?
   *
   * The question it answers `[owner]`. On this Mac, Chrome delivers about one advertisement at the
   * moment a connection opens and then nothing, while the same thermostat on Android keeps
   * broadcasting throughout; the Home Assistant box behaves like the Mac on ONE adapter and fine on
   * two. The device is NOT the variable — its advert is verified to survive a connection
   * (`connup_nonconn`) — so the open question is whether the browser's subscription is being torn
   * down, or the reports are being filtered somewhere below it. If a plain re-arm brings them back,
   * it is the former and the fix is a few lines here. If it does not, no amount of app code helps.
   *
   * **`Re-check` above cannot answer it**: `refreshGranted` deliberately skips devices that are
   * already watched, because re-arming one that is live races `installReArm`. This calls `watch()`
   * unconditionally, which aborts and re-subscribes.
   *
   * The counts are snapshotted BEFORE the re-arm, because the answer is whether the number MOVES —
   * a cumulative total that was already non-zero says nothing on its own.
   */
  const [mark, setMark] = useState<Record<string, number> | null>(null)
  const rearm = useCallback(async () => {
    const devices = await grantedDevices()
    setMark(Object.fromEntries(devices.map((d) => [d.id, reportFor(d.id).count])))
    await Promise.all(devices.map((d) => watch(d)))
  }, [])

  /**
   * A TICKING CLOCK, so the age below counts up on its own. Without it the line only re-renders
   * when a broadcast lands — which is exactly the case this is here to show the absence of, so a
   * frozen "0s ago" would be the most misleading thing on the panel.
   */
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  const watched = Object.keys(adverts)
  const short = (id: string) => (id.length > 12 ? `${id.slice(0, 10)}…` : id)
  /** How long since this device last said anything. `—` means it never has. */
  const age = (id: string) => {
    const at = adverts[id]?.lastAt
    return at == null ? '—' : `${Math.max(0, Math.round((now - at) / 1000))}s ago`
  }

  return (
    <Collapsible className="rounded-xl border px-4 py-3 text-xs">
      <CollapsibleTrigger className="flex w-full items-center gap-2 text-left text-muted-foreground">
        <ChevronDown className="size-4 shrink-0 transition-transform data-[state=open]:rotate-180" />
        Bluetooth state
      </CollapsibleTrigger>
      <CollapsibleContent>
      <div className="mt-3 space-y-2 font-mono">
        {/* FIRST, because everything below it is a question you can only ask once this is true —
            and because this is the one that explains a button that does nothing at all. (Further
            down: "available" is NOT "the flag is on" — Chrome offers `getDevices` either way and
            returns an empty list when the backend is off, which is what that line really tests.) */}
        <div className={HAS_BLUETOOTH ? undefined : 'text-warn'}>
          web bluetooth:{' '}
          {HAS_BLUETOOTH
            ? 'present'
            : 'ABSENT — this page is not a secure context, or this browser has none'}
        </div>
        <div className={SUPPORTED ? undefined : 'text-warn'}>
          watchAdvertisements: {SUPPORTED ? 'present' : 'ABSENT — needs the experimental flag'}
        </div>
        <div>
          getDevices: {HAS_GET_DEVICES ? 'method present' : 'ABSENT — this browser is too old'}
          {granted !== null && granted.length === 0 && ' but hands over NOTHING — the flag is off'}
        </div>
        <div>granted: {granted === null ? '…' : granted.length === 0 ? 'none' : granted.map(short).join(' ')}</div>
        {/* THE COUNT AND ITS AGE TOGETHER, because neither answers the question alone. A count
            says how many have EVER arrived, so a healthy-looking number can be an hour stale; the
            age says whether they are still coming. Read together they separate the two failures
            that look identical on a row with no readings: a browser that never received one, and a
            browser that received a few and then stopped. */}
        <div>
          watched:{' '}
          {watched.length === 0
            ? 'nothing'
            : watched.map((id) => `${short(id)}=${adverts[id]!.count} (${age(id)})`).join('  ')}
        </div>

        {/* HOW OFTEN THE PLATFORM TOOK THE SCAN AWAY. Only drawn once it has happened: on Android
            it stays 0 for ever, and a permanent zero is a number to explain on every screen that
            never has anything to say. A total that keeps climbing beside a healthy `watched` count
            is the thing working; one that climbs while the age also grows is it no longer helping. */}
        {watched.some((id) => adverts[id]!.rearms > 0) && (
          <div>
            discovery restarts:{' '}
            {watched
              .filter((id) => adverts[id]!.rearms > 0)
              .map((id) => `${short(id)}=${adverts[id]!.rearms}`)
              .join('  ')}
          </div>
        )}

        {/* ONE COUNT PER HALF. `setsSeen` already says whether both have ever arrived; this says
            how the traffic DIVIDES, which is the question on a platform that is losing broadcasts —
            a healthy-looking total can be one half arriving and the other never, and then half the
            readings on screen are as old as the page. Labelled with the decoder's own wire name for
            the first value in the set, so it cannot claim something the payload does not. */}
        {watched.map((id) =>
          Object.keys(adverts[id]!.setCounts).length === 0 ? null : (
            <div key={`${id}-halves`}>
              halves {short(id)}:{' '}
              {Object.entries(adverts[id]!.setCounts)
                .map(([name, n]) => `${name}=${n}`)
                .join('  ')}
            </div>
          ),
        )}
        {/* A DEVICE HANDED OVER AND THEN REFUSED A WATCH looks identical to one never handed over —
            a blank row either way — because a watch is started for its side effect. This is what
            tells the two apart. */}
        {trouble && <div className="text-warn">watch refused: {trouble}</div>}
        {rows.map((r) => (
          <div key={r.mac}>
            {r.name}: stored {r.deviceId ? short(r.deviceId) : 'NO HANDLE'}
            {r.deviceId && !watched.includes(r.deviceId) && ' — NOT WATCHED'}
            {r.deviceId && !(granted ?? []).includes(r.deviceId) && ' — NOT GRANTED'}
            {r.key ? '' : ' — NO KEY'}
          </div>
        ))}
      </div>
      <p className="mt-3 font-sans text-muted-foreground">
        A row shows readings only when the same handle appears in all three lines. “NOT WATCHED”
        means nothing is listening to it; “NOT GRANTED” means this browser will not hand the page
        that device without the chooser; “NO KEY” means the broadcast cannot be decoded.
      </p>

      {/* The re-arm experiment's own readout. It is only drawn once the button has been pressed,
          because before that there is no question on the screen and a row of zeroes would just be
          one more thing to interpret. */}
      {mark && (
        <div className="mt-3 space-y-1 font-mono">
          <div className="text-muted-foreground">since re-arm:</div>
          {Object.entries(mark).map(([id, before]) => {
            const gained = (adverts[id]?.count ?? 0) - before
            return (
              <div key={id} className={gained > 0 ? 'text-ok' : 'text-warn'}>
                {short(id)}: {gained > 0 ? `+${gained} broadcasts` : 'nothing yet'}
              </div>
            )
          })}
          <p className="font-sans text-muted-foreground">
            Connect first, wait for this to stop rising, then press Re-arm. If it climbs again the
            subscription was being torn down and the app can fix it; if it stays put, the
            broadcasts are not reaching the browser at all.
          </p>
        </div>
      )}

      <div className="mt-2 flex gap-2">
        <Button variant="outline" size="sm" onClick={() => void recheck()}>
          Re-check
        </Button>
        <Button variant="outline" size="sm" onClick={() => void rearm()}>
          Re-arm watches
        </Button>
      </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
