/**
 * WHAT THE ADDRESS BAR DOES TO THE CONNECTION — exactly one thing: open.
 *
 * A Web Bluetooth connection cannot survive a page load, and now that the app has addresses, a page
 * load is something a person can cause by accident: a reload, a deep link, a swipe that goes one
 * screen too far.
 *
 * 1. **WALKING INTO A THERMOSTAT OPENS IT**, with no chooser, through the same granted path a saved
 *    row already uses.
 *
 *    **A PAGE LOAD IS NOT WALKING IN, AND NEVER CONNECTS** `[owner]`. A reload, a restored tab, a
 *    deep link and a dev-server rebuild all come up on a thermostat's address with nobody having
 *    asked for a radio. So the address the page LOADED on is left alone, with its Connect button and
 *    its greyed tabs; a connection starts only once the address bar has moved, which only a person
 *    does.
 *
 *    **NONE OF THE WAITING IS HERE.** `connectTo` is one operation — keep trying until a deadline —
 *    and it reports `waiting` while it does, so the screen cannot show "disconnected" with a Connect
 *    button during an attempt that is already running. This hook knows only what it can know: which
 *    thermostat the address bar is on, when to start, and what to say when it fails.
 *
 *    **AND IF IT NEVER OPENS, THE PERSON STAYS WHERE THEY ARE** `[owner]`. Giving up quickly and
 *    sending them to the list is the worst of both: it fires OFTEN, because the settle being waited
 *    for takes longer than four seconds, and being moved off the screen you were on is a bigger
 *    interruption than a link that is not up yet. A failure raises a dialog on the screen you are
 *    already on, with a button to try again; the tabs behind it are greyed with their own reason.
 *
 * 2. **AND WHERE THE GRANT ITSELF WOULD NOT SURVIVE, THE BROWSER ASKS BEFORE THE PAGE GOES.** The
 *    test is whether this browser hands granted devices back at all — without the permissions
 *    backend it does not, so a reload costs not only the links but the ability to open them again
 *    without the chooser. Where the grant DOES survive, a reload costs the links and nothing else,
 *    and they are one tap from being back; a prompt on every reload is a prompt people learn to
 *    dismiss. **Whether the prompt appears in an INSTALLED app in standalone mode is not known and
 *    cannot be settled from here** — the browser decides, and it needs trying on the phone.
 *
 * ================================================================================================
 * LEAVING A THERMOSTAT DOES NOT DROP ITS LINK `[owner]`
 * ================================================================================================
 * The device layer holds several connections at once and the list has a Connect button on every row,
 * so walking back to the list and into another radiator keeps both up — which is the point of having
 * them. **The only things that end a link are the Disconnect button, the thermostat, and closing the
 * page**, and no change of address may be added to that list.
 *
 * That is also what keeps a whole class of trap out: a cleanup that hung up on a cancelled arrival
 * would have to know that a cancel is not always a departure, because StrictMode cancels one arrival
 * and immediately starts another for the same thermostat. With nothing hanging up on a cancel, there
 * is nothing for the two to disagree about.
 */
import { atom, getDefaultStore, useAtomValue, useSetAtom } from 'jotai'
import { useEffect, useRef } from 'react'

import { connectTo, grantedAtom, linkIdsAtom } from '@/device/link'
import { TEST_MODE } from '@/device/testMode'
import { log } from '@/state/log'
import { registry } from '@/state/registry'
import { leaveAtom, openIdAtom } from '@/state/route'

/** Read outside React, to ask where the app IS at the moment an attempt finishes. */
const store = getDefaultStore()


/**
 * The name of the thermostat that could not be opened, or `null` while opening or open.
 *
 * A STRING RATHER THAN A BOOLEAN because it is what the dialog says, and the dialog is rendered
 * from `App` — by then the registry row is a lookup away and the name is the only part of it that
 * matters. `components/OpenFailed.tsx` is the dialog.
 */
export const openFailedAtom = atom<string | null>(null)

/**
 * Bumped by a PERSON asking for a connection — the bar's Connect and the failure dialog's Try again
 * — which is the whole of how they re-enter the arrival effect. It is also what arms an effect that
 * a page load left disarmed, so a reload never costs the button.
 *
 * It is an atom rather than a callback passed down because the dialog and the effect have no
 * relationship in the tree: one is rendered by `App`, the other runs inside a hook `App` calls.
 */
const retryAtom = atom(0)

/** What the bar's Connect and the failure dialog's Try again both call. */
export const useRetryOpen = () => {
  const bump = useSetAtom(retryAtom)
  return () => bump((n) => n + 1)
}

export function useRouteLink() {
  const openId = useAtomValue(openIdAtom)
  const live = useAtomValue(linkIdsAtom)
  const granted = useAtomValue(grantedAtom)
  const leave = useSetAtom(leaveAtom)

  const retry = useAtomValue(retryAtom)
  const setFailed = useSetAtom(openFailedAtom)

  /**
   * The address this page load came up on, and whether the address bar has moved since.
   *
   * REFS, so this is per mounted app rather than per module: module state leaks from one test into
   * the next and cannot be reset. They survive StrictMode's double invoke, which remounts the SAME
   * component and keeps its refs.
   *
   * `undefined` is "the first effect has not run", which is why it is not simply `null`: `null` is a
   * real address, the list.
   */
  const loadedOn = useRef<string | null | undefined>(undefined)
  const armed = useRef(false)

  // 1. Arrival.
  //
  // It needs no cleanup: `connectTo` joins an attempt already in flight, so StrictMode's second
  // invoke observes the first one's result rather than starting a second connect.
  useEffect(() => {
    // Whatever went wrong belonged to the thermostat being left, and this runs on every change of
    // address including the one back to the list.
    setFailed(null)
    const at = openId
    // WHERE THE PAGE CAME UP IS THE FIRST EFFECT'S ADDRESS, not one read at import: import order is
    // not something this can depend on. Arming compares that address rather than counting runs,
    // because StrictMode invokes a mount twice and the second invoke must not read as a navigation.
    const first = loadedOn.current === undefined
    if (first) loadedOn.current = at
    if (at !== loadedOn.current) armed.current = true
    // **A PRESS ARMS IT, AND THAT IS THE WHOLE POINT OF THE RULE** `[owner]`. What a page load must
    // not do is connect BY ITSELF; a person asking for a connection is the opposite of that, and
    // `retryAtom` is bumped by nothing else — the bar's Connect and the failure dialog's Try again
    // are both somebody pressing a button. Without this the rule reaches the button as well and a
    // reload leaves a Connect that does nothing at all.
    if (retry > 0) armed.current = true
    if (!at) return
    const row = registry.get(at)
    // A BROWSER HANDLE IS WHAT TEST MODE DOES NOT NEED, and the usual machine for it has never been
    // granted one. The row itself still has to exist: it is what the tabs act on.
    //
    // **TESTED BEFORE THE PAGE-LOAD RULE BELOW, because it is about the ADDRESS and not about the
    // radio.** A load onto an address with no row behind it has nothing to show whether or not
    // anybody wants a connection, so it goes to the list either way.
    if (!row || (!row.deviceId && !TEST_MODE)) {
      // A row this browser has never been granted, or no row at all. Either way there is nothing
      // here to open, and the list is the only screen that can do anything about it.
      log(`${at}: not a thermostat this browser has been given — opening the list`)
      leave()
      return
    }
    if (!armed.current) return
    void connectTo(row.deviceId ?? at).then((ok) => {
      // **ONLY IF THE PERSON IS STILL LOOKING AT THIS ONE.** The attempt outlives the screen now —
      // nothing cancels it, because a link that comes up after somebody has walked on is a link
      // they can use from the list — so a dialog raised on the strength of the result alone would
      // land over whatever they moved to. `link.ts` has already logged WHY it failed.
      if (!ok && store.get(openIdAtom) === at) setFailed(row.name)
    })
  }, [openId, retry, leave, setFailed])

  // 2. The prompt, only where re-attaching cannot work.
  //
  // ANY LIVE LINK, not the open one: leaving a thermostat keeps its connection, so the page can be
  // holding several while the list is on screen, and reloading costs every one of them.
  useEffect(() => {
    if (!live.length || (granted ?? 0) > 0) return
    const ask = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', ask)
    return () => window.removeEventListener('beforeunload', ask)
  }, [live, granted])
}
