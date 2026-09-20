/**
 * A short buzz, where the platform has one.
 *
 * IT LIVES IN ITS OWN FILE BECAUSE `navigator` IS RESTRICTED: the lint rule exists so that device
 * access goes through `device/link.ts`, the only place with the one-write-in-flight queue. This is
 * the haptics API, not Bluetooth, so it is exempted HERE, once, rather than at each call site.
 *
 * **It is absent on iOS**, which is why every use of it is accompanied by something visible: on a
 * phone where nothing buzzes, a buzz is not feedback.
 */

// oxlint-disable-next-line no-restricted-globals
const nav = () => (typeof navigator === 'undefined' ? null : navigator)

/** `10` says "registered"; a longer one says "let go now and it is a long press". */
export function buzz(ms: number) {
  nav()?.vibrate?.(ms)
}
