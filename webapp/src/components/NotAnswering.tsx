import { useAtomValue } from 'jotai'

import { PairInvite } from '@/components/PairInvite'
import { MAC_NOTIFY_HINT, isMac } from '@/device/caps'
import { connectedAtom, repliesAtom } from '@/state/atoms'

/**
 * Connected, and the thermostat is answering nothing — said on EVERY tab `[owner]`.
 *
 * The condition is about the whole connection rather than any one tab, so it belongs BESIDE the
 * tabs: inside one, a person on Settings or Display sees controls that do nothing with the reason a
 * tab away and nothing pointing at it.
 *
 * **TWO CAUSES, ONE OF WHICH A MAC CANNOT FIX.** On a Mac it is almost always the stock radio's
 * notify descriptor, which our firmware fixes and which no PIN will help with; anywhere else the
 * thermostat wants to be paired with, and `PairInvite` is the way through. The two messages are
 * mutually exclusive on purpose: offering a Mac a pairing button it cannot use would be the worse
 * failure.
 */
export function NotAnswering() {
  const connected = useAtomValue(connectedAtom)
  const replies = useAtomValue(repliesAtom)
  if (!connected || replies) return null
  return isMac() ? (
    <p className="rounded-xl border border-warn/40 bg-warn/10 p-3 text-sm">{MAC_NOTIFY_HINT}</p>
  ) : (
    <PairInvite />
  )
}
