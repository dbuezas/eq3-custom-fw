/**
 * The app's two standing subscriptions to the BROWSER — not to the device modules.
 *
 * NOTHING HERE CARRIES A DEVICE VALUE. `device/link.ts` and `device/advert.ts` write their own
 * atoms, so there is nothing to copy across and no pair to keep equal (ONE FACT, ONE HOME,
 * `webapp/README.md`). What is left genuinely belongs to a React lifetime: two window listeners and
 * a first ask.
 */
import { useEffect, useRef } from 'react'

import { getDefaultStore } from 'jotai'

import { installReArm } from '@/device/advert'
import { grantedSettledAtom, refreshGranted } from '@/device/link'

/** How many times the boot ask is repeated before an empty answer is believed, and how far apart. */
const RETRIES = 3
const RETRY_MS = 1500

export function useLinkBridge() {
  // A ref, not state: this guards a side effect and must never cause a render of its own. It also
  // has to survive StrictMode's deliberate double-invoke in development, which a state flag set
  // inside the effect does not — both passes would see `false` and both would run.
  const started = useRef(false)

  /**
   * Re-arm the advert watches on the way back (`advert.ts`, trap 2) — and re-ask which devices this
   * browser hands over, in the SAME handler, because a grant made in another tab and an adapter that
   * was off at load both show up on the way back. One listener rather than two: `installReArm` says
   * what a second one races with.
   */
  useEffect(() => installReArm(() => void refreshGranted()), [])

  /**
   * WATCH EVERY GRANTED DEVICE AT BOOT, because the app opens on the list and every row on it is
   * showing a broadcast from a thermostat nothing is connected to. It needs no user gesture — only
   * `requestDevice()` does — so this is free and it is what makes the front door live.
   *
   * **AND ASK AGAIN, BECAUSE THE FIRST ANSWER AT LOAD WAS WRONG** `[manually verified]`: a
   * thermostat this origin held was reported as not granted at boot and turned up moments later.
   * The cause is not established — we only know the answer moved — so the page re-asks a few times
   * over the first seconds and stops as soon as it gets one, rather than trusting a single reply
   * and leaving the whole list blank for the session.
   */
  useEffect(() => {
    if (started.current) return
    started.current = true
    let tries = 0
    const ask = () => {
      void refreshGranted().then((n) => {
        // STOPPING IS THE INTERESTING EVENT, not the number. Until this loop gives up, a zero is
        // just an answer that has not arrived — see `grantedSettledAtom`.
        if (n === 0 && ++tries < RETRIES) return setTimeout(ask, RETRY_MS)
        getDefaultStore().set(grantedSettledAtom, true)
      })
    }
    ask()
  }, [])
}
