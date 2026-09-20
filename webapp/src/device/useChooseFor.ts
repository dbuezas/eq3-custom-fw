/**
 * THE BROWSER'S DEVICE CHOOSER, AIMED AT A ROW WE ALREADY HAVE — and the check afterwards that the
 * right thermostat came back.
 *
 * **IT LIVES HERE BECAUSE THREE SCREENS NEED IT AND THEY ARE THE SAME FLOW** `[owner]`. The list
 * taps a row this browser has not been granted; the bar inside a thermostat has a Connect that
 * cannot re-attach; and the could-not-open dialog is the same dead end reached a third way. All
 * three open the chooser where they stand — sending a person back to the list to press it there is
 * moving them off the screen they are on to do what the button they already pressed should have done.
 *
 * **EVERY eQ-3 IS CALLED `CC-RT-BLE`**, so the chooser cannot be aimed and a person picking from it
 * is guessing. The app cannot fix that — the browser shows the advertised name and nothing else —
 * but it CAN say afterwards whether the guess was right, because the device reports its own address
 * on connect. Being told beats finding out from the wrong radiator getting warm.
 */
import { useSetAtom } from 'jotai'

import { connect, grantedDevices, offerKey, refreshGranted, settledRow } from '@/device/link'
import { openIdAtom } from '@/state/atoms'
import { log } from '@/state/log'
import type { Thermostat } from '@/state/registry'

export function useChooseFor() {
  const openId = useSetAtom(openIdAtom)

  return (want: Thermostat) => {
    // **THE ROW'S KEY HAS TO BE OFFERED, BECAUSE A RE-GRANT MINTS A NEW DEVICE ID** `[manually
    // verified]`. The key is stored on the row and found by handle, so the moment the browser hands
    // back a handle it has never used before, the lookup misses and the link falls to the PIN-gated
    // channel — which raises the platform's pairing prompt on a thermostat that had a perfectly good
    // key. Measured on a phone whose permission was not being kept: the chooser succeeded, the
    // introduction died with "GATT Server is disconnected", and the list sat there saying nothing.
    //
    // The offer is the same mechanism Add uses, for the same reason: it describes ONE connection to
    // a device this browser cannot yet name, and `identify` spends it and re-files the row against
    // the new handle. It never overwrites a stored key — this IS the stored key.
    offerKey(want.key ?? null)
    return connect()
      .then(async (opened) => {
        // **THE HANDLE THE CHOOSER ACTUALLY OPENED, not "the" connection** (`W30`). Several
        // thermostats can be connected at once now, and this one is not on screen yet — the
        // navigation below is what puts it there — so asking the app which device is open would
        // read whichever was, and file this pick's row against it.
        const got = await settledRow(opened)
        if (got && got.id !== want.id) {
          log(`that is ${got.name}, not ${want.name} — every thermostat is called CC-RT-BLE in the chooser`)
        }
        // WHATEVER WAS ACTUALLY GRANTED IS WHAT OPENS, right or wrong. Opening the page for the row
        // that was tapped would show one thermostat's name over another's connection. Called even
        // when it is the row we are already on: navigating to where you are costs nothing, and the
        // alternative is this function knowing which screen invoked it.
        if (got) return openId(got.id)
        // CONNECTED AND UNIDENTIFIED — a silent dead end unless it is said out loud. A row is filed
        // from the address the thermostat reports on connect, so one that does not answer that
        // command leaves the chooser looking like it did nothing at all.
        log(
          `connected, but that thermostat did not report its address, so it cannot be matched to ` +
            `${want.name} — a stock one cannot, and ours cannot when its answers are not getting through`,
        )
      })
      .catch(async (e: unknown) => {
        // **A CANCELLED CHOOSER IS OFTEN THE WHOLE FIX, so closing it must not end here** `[manually
        // verified]`. Chrome does not answer `getDevices()` in a freshly loaded page until a chooser
        // has been opened in it — the grant is still there, it is simply not served — so merely
        // opening and dismissing the list makes the thermostat reachable. Measured on a phone: 0
        // devices before, 1 after a Cancel, with the row going live in the same second. Reporting
        // that as "you cancelled" would ask somebody to do again, properly, what they had just done
        // enough of.
        //
        // Only when the handle we already hold is what came back. A cancel proves nothing about a
        // row this browser has never been granted, and a Chrome that has been RESTARTED really has
        // lost the grant — measured, 0 before and 0 after the same Cancel — which is the case the
        // banner's flag advice is for.
        await refreshGranted()
        if (want.deviceId && (await grantedDevices()).some((d) => d.id === want.deviceId)) {
          return openId(want.id)
        }
        // NOT PROCEEDING, SO THE OFFER IS WITHDRAWN. It described one connection to one thermostat;
        // left standing it would be applied to whichever one is opened next.
        offerKey(null)
        log(String(e instanceof Error ? e.message : e))
      })
  }
}
