import { Bluetooth, Loader2 } from 'lucide-react'

import type { LinkState } from '@/device/link'
import { GOOD_TINT, MID_TINT } from '@/lib/tint'

import { Button } from './ui/button'

/**
 * CONNECT / SEARCHING / CONNECTING / DISCONNECT — the one control that says what a link is doing.
 *
 * **ONE COMPONENT, NOT TWO THAT MATCH** `[owner]`. It is on every row of the list and in the bar
 * above a thermostat, and the list is the front door to the screen the bar is on, so the two are
 * seen one after the other: two buttons meant to be the same button is two places to change and a
 * difference a person has to work out.
 *
 * **IT IS PURELY THE PICTURE.** What a press DOES belongs to the screen: the list acts on that row's
 * thermostat, the bar on the open one, and the bar has a chooser path for a thermostat this browser
 * was never granted. Only `state` and `onClick` cross this boundary.
 *
 * **THE COLOUR IS THE APP'S OWN THREE STOPS** (`lib/tint.ts`), so the green here is the green of a
 * strong signal on the same row rather than a second palette. Border and text rather than a fill,
 * which is what the key button beside it already does: the control stays a control and the colour is
 * what changed.
 *
 * **DISCONNECTED IS NOT RED, and that is the decision worth writing down.** Red is that ramp's
 * "something is wrong", and not being connected is not wrong: the list is the app's no-connection
 * view, every row shows live readings without a link, and most rows are meant to sit like that. Red
 * would be eight faults that are not there.
 */
export function LinkButton({ state, onClick }: { state: LinkState; onClick: () => void }) {
  const busy = state === 'waiting' || state === 'connecting'
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={onClick}
      className="shrink-0 gap-1"
      style={
        state === 'connected'
          ? { borderColor: GOOD_TINT, color: GOOD_TINT }
          : busy
            ? { borderColor: MID_TINT, color: MID_TINT }
            : undefined
      }
    >
      {busy && <Loader2 className="animate-spin" />}
      {/* **IT NEVER SAYS "Connect" WHILE AN ATTEMPT IS IN FLIGHT** `[owner]`, and the fix is the
          WORD rather than a disabled control: pressing it then is how the attempt is stopped. See
          `ConnectBar` for what `waiting` is. */}
      {state === 'connected' ? (
        <>
          <Bluetooth /> Disconnect
        </>
      ) : state === 'waiting' ? (
        'Searching…'
      ) : state === 'connecting' ? (
        'Connecting…'
      ) : (
        <>
          <Bluetooth /> Connect
        </>
      )}
    </Button>
  )
}
