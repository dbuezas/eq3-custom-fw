import { useAtomValue, useSetAtom } from 'jotai'
import { TriangleAlert } from 'lucide-react'

import { ConnectBar } from '@/components/ConnectBar'
import { FirmwareInstall } from '@/components/FirmwareInstall'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { connectedAtom } from '@/state/atoms'
import { leaveAtom } from '@/state/route'

/**
 * A thermostat this app is CONNECTED to and cannot name — `/connected`.
 *
 * ================================================================================================
 * WHAT IT IS FOR, AND WHY IT CANNOT BE A NORMAL THERMOSTAT SCREEN
 * ================================================================================================
 * Every other screen is reached by a saved row, and a row exists because the thermostat said who it
 * is — its serial (stock answers that) or its MAC (ours does). **A device whose STM8 is sitting in
 * its updater after an interrupted install says neither** `[owner]`, so no row can be made for it.
 * **It can still be reflashed** — the radio is running and the firmware installer is what rescues
 * it — so the one thing this screen has to do is reach that installer.
 *
 * ================================================================================================
 * THE INSTALLER IS THE WHOLE SCREEN, AND THE OTHER TABS ARE ABSENT RATHER THAN EMPTY
 * ================================================================================================
 * Status, Settings and Display all read values this device does not answer, so four tabs would be
 * three dead ones and the reason somebody came here. `FirmwareInstall` needs no row — it reads the
 * two version atoms and the link, and it already draws an unknown version as `—`, which is exactly
 * what this device reports.
 *
 * **NOTHING IS SAVED FROM HERE, and that is not an omission.** A row is keyed on what the device
 * says about itself; there is nothing to key one on. Once a working image is installed it answers
 * again, and can then be added from the list like anything else.
 *
 * ================================================================================================
 * AND IT DOES NOT SURVIVE A RELOAD, WHICH IS THE TRUTH RATHER THAN A LIMITATION
 * ================================================================================================
 * The address means "whatever is on the other end right now". A reload drops the link and there is
 * no identifier to re-attach by, so this says so and sends the person back to the list instead of
 * showing an installer aimed at nothing.
 */
export function UnsavedDevice() {
  const connected = useAtomValue(connectedAtom)
  const leave = useSetAtom(leaveAtom)

  if (!connected) {
    return (
      <div className="mx-auto flex min-h-dvh max-w-2xl flex-col gap-4 p-4">
        <Alert variant="warn">
          <AlertDescription className="space-y-3">
            <p>
              <strong>That connection is gone.</strong> This screen is for a thermostat that cannot
              say which one it is, so there is nothing to re-open it by — the way back is the list,
              and Add.
            </p>
            <Button variant="outline" size="sm" onClick={() => leave()}>
              Go to the list
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    )
  }

  return (
    <div className="mx-auto flex min-h-dvh max-w-2xl flex-col">
      {/* THE SAME BAR AS EVERY OTHER SCREEN `[owner]` — this is the screen where the link is the
          whole story, so it is the last one that may leave the link state unsaid. `ConnectBar` needs
          no row (it falls back to the name the device advertises) and its Connect branch is
          unreachable here, because the panel above replaces this screen the moment the link
          drops. */}
      <ConnectBar />

      <main className="flex-1 space-y-4 px-4 pb-10 pt-2">
        <Alert variant="warn">
          <AlertDescription>
            <strong>This thermostat has not said which one it is</strong>, so it cannot be saved to
            your list. That is what one does when a firmware install was interrupted — and it can
            still be reinstalled from here. Once it runs a working firmware it answers again, and
            you can add it from the list as usual.
          </AlertDescription>
        </Alert>

        {/* THE ONE THING THAT CAN WORK — see the header. */}
        <FirmwareInstall />

        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>
            Leaving this screen, or reloading the page, ends the connection and there is no way back
            to it except Add — the browser needs something to re-open, and this thermostat has given
            it nothing.
          </span>
        </p>
      </main>
    </div>
  )
}
