import { useAtomValue, useSetAtom } from 'jotai'
import { ChevronLeft } from 'lucide-react'
import { useEffect, useState } from 'react'

import { LinkButton } from '@/components/LinkButton'
import { LogStrip } from '@/components/LogStrip'
import { log } from '@/state/log'
import { pairing } from '@/device/caps'
import { connect, disconnect } from '@/device/link'
import { useChooseFor } from '@/device/useChooseFor'
import { useRetryOpen } from '@/device/useRouteLink'

import { ageTint, signalTint } from '@/lib/tint'

import {
  advertAtom,
  chipVersionAtom,
  connectedAtom,
  deviceNameAtom,
  fwVersionAtom,
  grantedAtom,
  grantedSettledAtom,
  leaveAtom,
  linkStateAtom,
  openDeviceAtom,
} from '@/state/atoms'

import { Button } from './ui/button'

/**
 * The bar above the tabs: which thermostat is open, whether the link is up, and the way back.
 *
 * **THE VERSIONS DO NOT LIVE HERE** `[owner]`. A version is a PAIR, and this line has room for a
 * name, not for two numbers and the words that say which chip each belongs to; the Firmware tab has
 * that room and is where somebody goes to act on them. What stays here is the STATE, which belongs
 * to every tab: half installed is ordinary and temporary, and reads as a fault if nothing names it.
 */
export function ConnectBar() {
  const state = useAtomValue(linkStateAtom)
  const device = useAtomValue(openDeviceAtom)
  const linkName = useAtomValue(deviceNameAtom)
  const fw = useAtomValue(fwVersionAtom)
  const chip = useAtomValue(chipVersionAtom)
  const pair = pairing(fw, chip)
  const report = useAtomValue(advertAtom)
  const leave = useSetAtom(leaveAtom)
  const retryOpen = useRetryOpen()
  const chooseFor = useChooseFor()
  /**
   * Whether re-attaching can work at all — SETTLED-AND-ZERO, never a raw zero.
   *
   * Derived here rather than stored, and read from the two atoms that own it: a raw count cannot
   * tell "this browser hands nothing back" from "it has not answered yet", and acting on the second
   * as if it were the first pushes the chooser at people who have already picked.
   * `grantedSettledAtom` is where the distinction is defined; `DeviceList` and `OpenFailed` ask the
   * same question the same way.
   */
  const granted = useAtomValue(grantedAtom)
  const grantedSettled = useAtomValue(grantedSettledAtom)
  const dry = grantedSettled && granted === 0
  // THE AGE HAS TO TICK ITSELF HERE. This bar re-renders only when the link state or a version
  // changes, so without a timer the age would freeze at whatever it read when the last advert
  // landed — and freezing is the exact condition the colour exists to show.
  //
  // IT IS THE CLOCK ITSELF IN STATE, not a counter beside a `Date.now()` read during render:
  // reading the clock while rendering makes the output depend on when React happened to run. Same
  // shape as `LiveValues`.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  // `waiting` and `connecting` are read here because this bar is their only reader; `connected` is
  // NOT — it is `connectedAtom`, which every other view reads too, so what counts as up is settled
  // in one place.
  //
  // **`waiting` IS NOT A LAG, IT IS THE APP REFUSING TO TRY YET** (`W29`). A saved thermostat
  // cannot be opened until the platform has HEARD it, which takes about a second; the button says
  // "Searching…" for that second rather than offering a Connect that would do nothing visible.
  const waiting = state === 'waiting'
  const busy = state === 'connecting'
  const on = useAtomValue(connectedAtom)

  /**
   * Back to the list. It spends the history entry opening this thermostat pushed, so this arrow and
   * the phone's own Back do the same thing — and dropping the link is `useRouteLink`'s job, for
   * every way out, because the phone's Back presses no button.
   */
  const back = () => leave()

  /**
   * Connect, or hang up.
   *
   * **A HANDLE MEANS BE PATIENT.** What a single attempt usually loses to is the platform not
   * having HEARD the thermostat yet — a wait of about a second, not a fault — and the chooser lists
   * every thermostat in range under the same name, so jumping to it asks a person to pick again
   * something they had already picked. So it goes through the same arrival the address bar uses,
   * which waits for the device to be heard, retries until its deadline and raises its own dialog if
   * it genuinely cannot.
   *
   * **UNLESS PATIENCE IS PROVABLY POINTLESS, IN WHICH CASE THE CHOOSER OPENS RIGHT HERE** `[owner]`.
   * A browser that has settled at handing back nothing will hand back nothing on the next press too,
   * so the patient path can only fail again. `requestDevice()` needs a live user gesture and THIS
   * PRESS IS ONE, so the browser's own list can come up without leaving the thermostat. Picking from
   * it lands on whatever was actually granted — usually the thermostat already open, in which case
   * nothing moves and the link simply comes up.
   *
   * With no handle at all there is nothing to be patient about either, and it is the same answer:
   * this browser has never been given this thermostat.
   */
  const link = () => {
    // **ANYTHING THAT IS NOT `disconnected` HANGS UP**, `waiting` and `connecting` included — the
    // same press the list's rows answer, because it is visibly the same button `[owner]`. With the
    // word saying "Searching…" beside a spinner, stopping is what pressing it means; what it must
    // not do is restart the open deadline, and it cannot.
    if (state !== 'disconnected') return disconnect()
    // A row is what the chooser is aimed at — it carries the key to offer and the name to check the
    // pick against. `/connected` has no row, so there is nothing to re-grant and nothing to compare.
    if (device && (!device.deviceId || dry)) return void chooseFor(device)
    if (device?.deviceId) return retryOpen()
    connect().catch((e: unknown) => log(String(e instanceof Error ? e.message : e)))
  }

  return (
    // TWO ROWS IN ONE STICKY BLOCK, not two sticky elements: the log strip has to travel with this
    // bar, and stacking a second `sticky top-0` under it puts them on top of each other.
    <header className="sticky top-0 z-10 border-b bg-background/85 backdrop-blur">
      <div className="flex items-center gap-2 px-2 py-3">
        <Button
          variant="ghost"
          size="icon"
          onClick={back}
          aria-label="Back to the thermostat list"
          className="shrink-0 rounded-full text-muted-foreground"
        >
          <ChevronLeft />
        </Button>

        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            {/* THE ROW'S NAME, THEN THE ONE THE DEVICE ADVERTISES, then a word. The middle one is
                what `/connected` has and nothing else does: a thermostat that cannot say which one
                it is has no row to take a name from, and "Thermostat" over a live link reads as the
                app having lost track of what it is talking to. `CC-RT-BLE` is not much, but true. */}
            <span className="truncate text-sm font-medium">
              {device?.name ?? linkName ?? 'Thermostat'}
            </span>
          </span>
          {/* THE LINK'S STATE, AND NO VERSION NUMBERS — see the header. A device can genuinely be
              one version on each chip, which is the state every install passes through. */}
          <span className="block truncate text-xs text-muted-foreground">
            {on
              ? pair === 'mixed'
                ? 'half installed — the two chips are on firmware that does not match'
                : pair === 'unknown'
                  ? 'still asking what it runs'
                  : 'connected'
              : waiting
                ? 'listening for it — a thermostat is heard about once a second'
                : busy
                  ? 'connecting…'
                  : 'readings only — connect to change anything'}
          </span>
        </span>

        {/* THE SAME TWO NUMBERS AS THE LIST, TINTED THE SAME WAY `[owner]`: same thresholds, same
            ramp (`lib/tint.ts`), so a colour means the same thing on both screens — and the screen a
            person stands on while the link misbehaves is the one that has to say whether the device
            is still being heard.

            THEY KEEP UPDATING WHILE CONNECTED, which is not obvious: this firmware keeps advertising
            through a connection (non-connectable, so nothing else can take it), so the age here is a
            live reading rather than a frozen one from before the link opened. */}
        {(report.rssi !== null || report.lastAt !== null) && (
          <span className="flex shrink-0 flex-col items-end text-[10px] leading-tight tabular-nums">
            {/* WITH ITS UNIT `[owner]`. A bare −63 beside a bare 2s is two anonymous numbers, and
                the list right behind this screen says "dBm" — the same value labelled differently in
                two places reads as two different measurements. */}
            {report.rssi !== null && (
              <span style={{ color: signalTint(report.rssi) }}>{report.rssi} dBm</span>
            )}
            {report.lastAt !== null && (
              <span style={{ color: ageTint((now - report.lastAt) / 1000) }}>
                {Math.max(0, Math.round((now - report.lastAt) / 1000))}s
              </span>
            )}
          </span>
        )}

        {/* THE SAME BUTTON AS EVERY ROW ON THE LIST `[owner]` — see `LinkButton`, which owns the
            words and the colour. The list is the front door to this screen, so the control a person
            just pressed there is the control they meet here. */}
        <LinkButton state={state} onClick={link} />
      </div>
      {/* WHAT THE APP LAST SAID, on the screen where the things it says actually happen — see
          `LogStrip`. */}
      <LogStrip />
    </header>
  )
}
