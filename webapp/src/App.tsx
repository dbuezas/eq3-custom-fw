import { useAtomValue } from 'jotai'

import { ConnectBar } from '@/components/ConnectBar'
import { DeviceList } from '@/components/DeviceList'
import { NotAnswering } from '@/components/NotAnswering'
import { KeyOffer } from '@/components/KeyOffer'
import { OpenFailed } from '@/components/OpenFailed'
import { SectionNav } from '@/components/SectionNav'
import { TestBanner } from '@/components/TestBanner'
import { UnsavedDevice } from '@/components/UnsavedDevice'
import { UpdatePrompt } from '@/components/UpdatePrompt'
import { Display } from '@/sections/Display'
import { Install } from '@/sections/Install'
import { Settings } from '@/sections/Settings'
import { Status } from '@/sections/Status'
import { useLinkBridge } from '@/device/useLink'
import { useRouteLink } from '@/device/useRouteLink'
import { TEST_MODE } from '@/device/testMode'
import { openDeviceAtom, sectionAtom, unsavedAtom } from '@/state/atoms'

/**
 * THE SHELL, AND THE ONLY PLACE THE APP'S SHAPE IS DECIDED — a list, then four tabs `[owner]`.
 *
 * **THE SAVED-THERMOSTAT LIST IS THE FRONT DOOR, and it covers everything until a thermostat is
 * picked** `[owner]`. Not a tab and not a menu behind the device name: the app opens on the list,
 * the tabs exist only once there is a device to apply them to, and leaving a device returns to it.
 * It draws the registry (`state/registry.ts`) and it is the app's no-connection view: each row shows
 * what that thermostat is broadcasting right now, which needs no link.
 *
 * **THAT LAST SENTENCE IS CONDITIONAL, and the condition is a Chrome flag.** Watching a broadcast
 * needs a `BluetoothDevice`, and a page can only get one from `requestDevice()` (a user gesture) or
 * `getDevices()` (the permissions flag). Without the flag there is nothing to watch at page load,
 * so the rows are names with no readings until a connection hands the page a device — see
 * `device/link.ts`, `REOPEN_HINT`, which is what the list says instead of showing blanks.
 *
 * Everything else is a detail inside one of the four, so a feature's home is settled here rather
 * than argued per feature:
 *
 * - **Status** — everyday use: what the room is, what it is asked to be, boost, the child lock, the
 *   window, and playing a sound to find which radiator this is. The readings come from the
 *   broadcast and survive the link dropping; the controls do not.
 * - **Settings** — the things set once and left: the weekly programme, boost duration AND valve
 *   opening, comfort/eco, the offset, open-window detection, contrast, the idle screen. **Each is a
 *   row that opens a dialog**, so the tab stays a list rather than a wall of controls.
 * - **Display** — the LCD as it actually is, and the buttons and wheel that drive it.
 * - **Install** — setup rather than settings: the firmware itself (in a dialog that runs to the
 *   end) and both chips' versions, the pairing PIN, the encryption key and the radio switches.
 *   These ARE settings; they live here because they belong to taking a thermostat over, not to
 *   running it.
 *
 * **The top bar carries the link STATE, not the version numbers** — a version is a PAIR and needs
 * room to say which chip is which, which the Install tab has and a one-line bar does not.
 *
 * **Unavailable means greyed out with a reason, never hidden** — a missing tab or row reads as an
 * app that cannot do the thing, rather than a device that cannot or a link that is not open yet.
 * That rule is about a device or a link, NOT about the list above it: the tabs are absent before a
 * thermostat is picked because there is nothing for them to act on.
 */
export default function App() {
  return (
    <>
      {/* ABOVE ALL THREE SCREENS, which is why it is here and not inside one — see
          `device/testMode.ts`. */}
      {TEST_MODE && <TestBanner />}
      <Screens />
    </>
  )
}

function Screens() {
  useLinkBridge()
  useRouteLink()
  const section = useAtomValue(sectionAtom)
  const open = useAtomValue(openDeviceAtom)
  const unsaved = useAtomValue(unsavedAtom)

  // A LIVE LINK WITH NO ROW BEHIND IT — a thermostat that cannot say which one it is, which is what
  // an interrupted firmware install leaves. It has its own screen because it can do exactly one
  // thing: be reinstalled. `components/UnsavedDevice.tsx` says why the other tabs are absent rather
  // than empty. Checked before the list, since there is no row for the test below to find.
  if (unsaved)
    return (
      <>
        <UnsavedDevice />
        <KeyOffer />
        <UpdatePrompt />
      </>
    )

  if (!open)
    return (
      <>
        <DeviceList />
        <KeyOffer />
        <UpdatePrompt />
      </>
    )

  return (
    // Mobile first: one column, the nav pinned where a thumb reaches. `max-w-2xl` keeps a phone
    // layout from being stretched across a monitor.
    <div className="mx-auto flex min-h-dvh max-w-2xl flex-col">
      <ConnectBar />
      <main className="flex-1 px-4 pb-28 pt-2">
        {/* ABOVE WHICHEVER TAB IS OPEN, because a thermostat that answers nothing is a fact about the
            CONNECTION and not about one tab `[owner]` — see `NotAnswering`. */}
        <div className="mb-4">
          <NotAnswering />
        </div>
        {section === 'status' && <Status />}
        {section === 'settings' && <Settings />}
        {section === 'display' && <Display />}
        {section === 'install' && <Install />}
      </main>
      <SectionNav />
      {/* Only on a thermostat's screen: it is about the one in the address bar, and it offers Try
          again for exactly that one. */}
      <OpenFailed />
      {/* ON BOTH SCREENS, because a thermostat with a key can be met from either: the list is where
          one is added, and a deep link lands on one whose key this browser has never been given,
          which the next Connect then asks for. It renders nothing until a connection asks. */}
      <KeyOffer />
      <UpdatePrompt />
    </div>
  )
}
