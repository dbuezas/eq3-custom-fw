/**
 * Whether the browser has offered to install this app, and the handle that does it.
 *
 * ================================================================================================
 * THE LISTENER IS REGISTERED AT IMPORT, NOT IN A COMPONENT — that is the whole reason this file
 * exists
 * ================================================================================================
 * `beforeinstallprompt` fires as soon as the browser has judged the page installable, which is
 * around load and well before React has mounted anything. An `addEventListener` inside a component
 * effect therefore misses it on exactly the machines where it would have fired, and the card never
 * appears on a browser that is perfectly able to install the app `[manually verified]`. The event
 * is not replayed and there is no way to ask for it again, so the listener has to already be there.
 *
 * It writes an atom rather than a module variable so that a card mounted later still repaints when
 * the offer arrives — the same shape `state/log.ts` uses, and for the same reason.
 *
 * **THE HANDLE IS SPENT WHEN USED.** `prompt()` works once; after that the browser owns the
 * conversation. So the atom is cleared as soon as it is used, and a card reading it disappears
 * instead of offering a button that quietly does nothing.
 *
 * ================================================================================================
 * THE OFFER IS OFTEN ABSENT ON A BROWSER THAT CAN INSTALL PERFECTLY WELL
 * ================================================================================================
 * The browser decides when to fire it and cannot be asked. Chrome suppresses it for a period after
 * the app has been UNINSTALLED, and it has its own engagement rules besides `[manually verified]` —
 * so "the install icon is in the address bar and this event never came" is an ordinary state, not a
 * fault. That is why `InstallHint` is always present and only *upgrades* to a one-tap install when
 * the offer happens to be here: a control that exists only when the browser volunteers is a control
 * a person cannot find when they want it.
 *
 * **IT IS A CHROME-FAMILY EVENT.** Safari never fires it — installing there is Share → Add to Home
 * Screen, with no API at all — which is accepted rather than worked around `[owner]`: this app
 * needs Web Bluetooth and no Safari has it, so an iPhone cannot run it installed or not.
 */
import { atom, getDefaultStore } from 'jotai'

/** What Chrome hands us. It is not in the DOM types, and only `prompt` is used. */
export type InstallEvent = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

export const installOfferAtom = atom<InstallEvent | null>(null)

/**
 * Is the app ALREADY running installed? Then there is nothing to offer and the row is hidden.
 *
 * Read once, at module load: a page opened in a tab does not become a standalone window without
 * being loaded again. `navigator.standalone` is the older iOS spelling, kept because it costs one
 * clause and answers on browsers that never learned the media query.
 */
export const RUNNING_INSTALLED =
  typeof window !== 'undefined' &&
  (window.matchMedia?.('(display-mode: standalone)').matches ||
    (navigator as { standalone?: boolean }).standalone === true)

// `typeof window` because this module is imported by tests that run with no DOM at all.
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    // Without this Chrome shows its own bar, which is fine but arrives wherever it likes. Taking
    // the event is what puts the offer inside the page, in the rest of the app's language.
    e.preventDefault()
    getDefaultStore().set(installOfferAtom, e as InstallEvent)
  })
  // Installed from here or from the browser's own menu. Either way there is nothing left to offer,
  // and the event will not fire again.
  window.addEventListener('appinstalled', () => getDefaultStore().set(installOfferAtom, null))
}
