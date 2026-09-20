import { useAtomValue, useSetAtom } from 'jotai'
import { Download } from 'lucide-react'
import { useState } from 'react'

import { RUNNING_INSTALLED, installOfferAtom } from '@/state/install'

import { Sheet } from './Sheet'
import { Button } from './ui/button'
import { Card } from './ui/card'

/**
 * Install this app onto the home screen — always offered, never waiting to be volunteered.
 *
 * **INSTALLED IS WHAT MAKES THIS APP WORK IN A CELLAR** `[owner]`. A thermostat is reached over
 * Bluetooth and needs no network at all, but a page in a browser tab does — so the one place the
 * app is most useful is the one place a tab cannot be loaded. `UpdatePrompt` already says "ready to
 * work with no network" once the service worker has its copy; this is the step that makes that copy
 * reachable without typing an address.
 *
 * ================================================================================================
 * THE ROW IS ALWAYS THERE, AND ONLY THE BUTTON'S BEHAVIOUR CHANGES `[owner]`
 * ================================================================================================
 * With `beforeinstallprompt` in hand the button installs in one tap. Without it the button explains
 * where the browser's own command is. It is NOT hidden in the second case, because that case is
 * common and looks identical from the outside: the browser suppresses its offer for a period after
 * the app has been uninstalled, so the person most likely to be looking for this — somebody who had
 * it, removed it and wants it back — is exactly the person the automatic offer will not reach
 * `[manually verified]`. `state/install.ts` has why we cannot simply ask for the event.
 *
 * It IS hidden once the app is running installed, where there is nothing left to do.
 */
export function InstallHint() {
  const offer = useAtomValue(installOfferAtom)
  const setOffer = useSetAtom(installOfferAtom)
  const [how, setHow] = useState(false)

  if (RUNNING_INSTALLED) return null

  return (
    <>
      <Card className="flex-row items-center gap-3 p-4">
        <Download className="size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">Install this app</div>
          <div className="text-xs text-muted-foreground">
            It then opens from your home screen and works with no network — a thermostat is reached
            over Bluetooth, and that needs none.
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={() => {
            // The offer is spent by one call, so it goes as soon as it is used, whatever is chosen
            // in the browser's own dialog. Leaving the button on the one-tap path afterwards would
            // leave a button that quietly does nothing.
            if (!offer) return setHow(true)
            setOffer(null)
            void offer.prompt()
          }}
        >
          Install
        </Button>
      </Card>

      {how && (
        <Sheet title="Install this app" onClose={() => setHow(false)}>
          <div className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              This browser has not offered it by itself, so it is done from the browser&rsquo;s own
              menu. It is the same app either way.
            </p>
            <dl className="space-y-2">
              <dt className="font-medium">On a phone</dt>
              <dd className="text-muted-foreground">
                Open the browser menu and choose <b>Add to Home screen</b> (Chrome may call it{' '}
                <b>Install app</b>).
              </dd>
              <dt className="font-medium">On a computer</dt>
              <dd className="text-muted-foreground">
                Chrome and Edge put an install icon at the right-hand end of the address bar.
                Otherwise the browser menu has <b>Install page as app</b>.
              </dd>
            </dl>
            {/* SAID PLAINLY, BECAUSE THE PERSON READING THIS HAS PROBABLY JUST TRIED. The browser
                will not explain its own silence, and without this line a missing offer reads as an
                app that is broken. */}
            <p className="text-xs text-muted-foreground">
              A browser decides for itself whether to offer this, and Chrome stops offering for a
              while after an app has been removed. Its menu still installs it.
            </p>
          </div>
        </Sheet>
      )}
    </>
  )
}
