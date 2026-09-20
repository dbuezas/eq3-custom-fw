import { KeyRound, Loader2 } from 'lucide-react'
import { useState } from 'react'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { isMac } from '@/device/caps'
import { provokePairing } from '@/device/link'

/**
 * `W25` — the way out of the one dead end this app has: a thermostat that wants its PIN.
 *
 * ================================================================================================
 * ONE PANEL FOR THREE CAUSES, BECAUSE THE APP CANNOT TELL THEM APART
 * ================================================================================================
 * All this panel actually knows is that the link is UP and a protected attribute refuses. Asking
 * why needs the very channel that is refused. Three land here:
 *
 *   - **ours with the `PIn` row on** — the gate covers the command characteristic and the whole
 *     update service, deliberately, because a gate with an unsigned reflash beside it protects
 *     nothing;
 *   - **an original 1.48 thermostat**, where the passkey is mandatory and there is no row to turn
 *     off. That is the device somebody installs FROM, so it is the case that matters most — and the
 *     one where advice about a `PIn` row would be advice about a menu they do not have;
 *   - **a pairing this phone still holds for a radio image that has been REPLACED** — after a radio
 *     update, which this app itself performs. The phone believes it is paired, so no prompt appears
 *     and nothing happens at all `[manually verified]`.
 *
 * **SO IT MUST NOT NAME A CAUSE IT HAS NOT MEASURED** `[owner]`. "This thermostat is asking for a
 * PIN" is a claim about something the app cannot see, and it is FALSE for the third case — a radio
 * with no passkey at all, where it sends somebody hunting for a code that does not exist while the
 * fix is in their phone's Bluetooth settings. It states what it observes, and offers the action
 * that serves all three.
 *
 * **THE STALE PAIRING IS NAMED WHEN THE ATTEMPT FAILS, not before.** A prompt that never appears is
 * its signature — and that is precisely the outcome the button reports, since a phone that thinks it
 * is paired has nothing to ask. Saying it up front would put a Bluetooth-settings errand in front of
 * everybody, including the many for whom entering a code is all that is needed.
 *
 * **AND IT IS NOT DECIDED FROM STORED HISTORY** `[owner]`. Remembering which radio version this app
 * last saw would answer it exactly when the answer is least needed and fail where it matters: a
 * different phone, a reinstalled app, cleared site data, or a radio somebody else flashed. The
 * symptom is present-tense and so is the advice.
 *
 * **THE BUTTON DOES NOT "PAIR".** There is no such call in Web Bluetooth; pairing is provoked by
 * touching something the thermostat protects, and `provokePairing` explains exactly what it touches
 * and why it is not the update characteristic.
 *
 * **AND IT CANNOT REPORT A PROMPT THAT NEVER APPEARED**, because nothing tells a page that. So a
 * failure says "still not answering" rather than guessing at a cause — and on a Mac, where no prompt
 * can be answered at all, the panel says so instead of offering a button that cannot work.
 */
export function PairInvite() {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  if (isMac()) {
    return (
      <Alert>
        <KeyRound />
        <AlertDescription className="space-y-2">
          <p>
            <strong>This thermostat is connected but not answering, and a Mac cannot pair with
            it.</strong> macOS gives a web page no way to answer a pairing request. Use a phone, or
            turn the PIN off from the thermostat’s own Bluetooth page.
          </p>
          {/* THE ONE THING A MAC CAN DO ABOUT IT, and it is the same stale pairing a phone hits —
              worth saying here precisely because the rest of this panel is a dead end on a Mac. */}
          <p>
            If this Mac has paired with it before and the thermostat’s radio has been updated since,
            the old pairing is what is in the way: remove it under Bluetooth in System Settings, then
            connect again.
          </p>
        </AlertDescription>
      </Alert>
    )
  }

  return (
    <Alert>
      <KeyRound />
      <AlertDescription className="space-y-3">
        <p>
          <strong>This thermostat is connected but not answering.</strong> It has to be paired with
          first. Tap below — if your phone asks for a six-digit code, hold the thermostat&rsquo;s{' '}
          <strong>BOOST</strong> button for about three seconds and it will show one.
        </p>
        {failed && (
          <p>
            <strong>Still not answering, and that usually means your phone thinks it is already
            paired</strong> — most often because the thermostat&rsquo;s radio firmware has been
            replaced since, which leaves the old pairing behind. Open your phone&rsquo;s Bluetooth
            settings, find this thermostat, choose <strong>Forget</strong>, then connect again here.
            If a code box did appear and the code was rejected, hold BOOST again for a fresh one.
          </p>
        )}
        <Button
          size="sm"
          disabled={busy}
          onClick={() => {
            setBusy(true)
            setFailed(false)
            void provokePairing()
              .then((ok) => setFailed(!ok))
              .finally(() => setBusy(false))
          }}
        >
          {busy && <Loader2 className="animate-spin" />}
          {busy ? 'Asking…' : 'Pair with this thermostat'}
        </Button>
      </AlertDescription>
    </Alert>
  )
}
