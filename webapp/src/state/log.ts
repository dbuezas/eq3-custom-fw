/**
 * What the app did, newest first — and the one piece of state the DEVICE layer writes to.
 *
 * It is its own file so that `device/link.ts` can say "connected to X" without importing
 * `state/atoms.ts`, which imports it back. Everything else in `state/` may depend on the device
 * modules; this one depends on nothing, which is what makes it safe in both directions.
 *
 * IT EXISTS BECAUSE A WEB BLUETOOTH FAILURE IS SILENT. No `navigator.bluetooth` at all, a chooser
 * dismissed, a device that never answers: without a line saying so, the screen just looks idle.
 */
import { atom, getDefaultStore } from 'jotai'

/**
 * **THE ID IS A COUNTER, NOT THE TIMESTAMP.** Two identical lines can be logged inside the same
 * millisecond — a link that drops and is retried logs "disconnected" twice — and a list keyed on
 * time-plus-text then has two children with one key, which React may duplicate or omit. Seen in
 * the browser console, on exactly that message.
 */
export type LogLine = { id: number; at: number; text: string }

export const logAtom = atom<LogLine[]>([])

const MAX_LINES = 200

let seq = 0

/** Append a line. Callable from anywhere, React or not — it writes the same atom either way. */
export function log(text: string) {
  const store = getDefaultStore()
  store.set(logAtom, [{ id: ++seq, at: Date.now(), text }, ...store.get(logAtom)].slice(0, MAX_LINES))
}
