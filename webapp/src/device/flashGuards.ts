import { atom, getDefaultStore } from 'jotai'
import { useEffect } from 'react'

/**
 * Everything that has to STOP HAPPENING while firmware is being written.
 *
 * ================================================================================================
 * A FLASH IS THE ONE THING THIS APP DOES THAT A STRAY TAP CAN RUIN
 * ================================================================================================
 * Every other action is a write that either lands or does not. This one is thousands of writes over
 * minutes, against a chip with no reset line, and the failure mode of an interruption is a device
 * left half-written rather than an action that did not happen. So while it runs the app takes away
 * the ordinary ways of interrupting it — and says that it has, rather than silently swallowing taps.
 *
 * Four guards, and each covers a different way a phone ends a flash:
 *
 *   - **the screen going to sleep.** Chrome throttles a backgrounded or blanked tab hard, and a
 *     throttled flash is a stalled one, mid-image. A Screen Wake Lock keeps the display up.
 *   - **the tab being closed or reloaded.** `beforeunload` puts the browser's own "leave site?"
 *     prompt in the way, which is the only interruption the page is allowed to argue with.
 *   - **the back button, and any other history move.** A `popstate` is pushed straight back, so the
 *     address cannot change under a running transfer.
 *   - **the app's own tab bar**, which is a route change by another name. `flashBusyAtom` is what it
 *     reads to disable itself; it is an atom rather than a prop because the nav is nowhere near this.
 *
 * **WHAT NONE OF THIS CAN DO is stop a person switching apps**, and no web page can. That is why the
 * screen says to stay put in words as well: the guards cover what they can and the sentence covers
 * the rest.
 *
 * **THE WAKE LOCK IS RE-TAKEN ON `visibilitychange`, and that is not belt-and-braces** `[external]`:
 * the platform releases it whenever the page is hidden, so one taken at the start is gone the first
 * time anything covers the tab — a notification shade, a call — and would not come back on its own.
 */

/** True while a flash is running. The tab bar reads it; nothing else should need to. */
export const flashBusyAtom = atom(false)

const jotai = getDefaultStore()

export const setFlashBusy = (busy: boolean) => jotai.set(flashBusyAtom, busy)

/** The message the guards exist to enforce, said once so the modal and the progress screen agree. */
export const STAY_PUT =
  'Stay next to the thermostat, keep this page in front, and do not switch apps or lock the phone.'

/**
 * Hold every guard for as long as `active` is true, and drop them all when it goes false.
 *
 * Written as a hook with one effect so there is no way to acquire and forget: the cleanup runs on
 * the same condition that acquired, including when the component unmounts mid-flash.
 */
export function useFlashGuards(active: boolean) {
  useEffect(() => {
    if (!active) return
    let lock: WakeLockSentinel | null = null
    let dropped = false

    const take = async () => {
      try {
        // Absent on any browser without it, and on http. Its absence is not a reason to refuse a
        // flash — it is one guard of four, and the sentence on screen covers the same ground.
        lock = (await navigator.wakeLock?.request('screen')) ?? null
      } catch {
        lock = null
      }
    }
    void take()

    // Re-taken whenever the page comes back: the platform drops it on hide, silently.
    const onVisible = () => {
      if (!dropped && document.visibilityState === 'visible' && !lock) void take()
    }
    document.addEventListener('visibilitychange', onVisible)

    const onUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = '' // required by older browsers to raise the prompt at all
    }
    window.addEventListener('beforeunload', onUnload)

    // A history entry of our own to absorb the first Back, then push it back on every popstate.
    history.pushState(history.state, '', location.href)
    const onPop = () => history.pushState(history.state, '', location.href)
    window.addEventListener('popstate', onPop)

    setFlashBusy(true)

    return () => {
      dropped = true
      setFlashBusy(false)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('beforeunload', onUnload)
      window.removeEventListener('popstate', onPop)
      void lock?.release().catch(() => {})
    }
  }, [active])
}
