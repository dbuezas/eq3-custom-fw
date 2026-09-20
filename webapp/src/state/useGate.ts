import { useAtomValue } from 'jotai'

import { gate, type Need, type Verdict } from '@/device/caps'
import { capsAtom } from '@/state/atoms'

/**
 * "Can this control be used, and if not, why?" — asked once, answered the same way everywhere.
 *
 * Every control goes through this rather than testing a version itself, which is what keeps a stock
 * thermostat showing a working app with greyed-out extras instead of one control saying "needs the
 * mod", another silently doing nothing and a third throwing. `components/Gate.tsx` is the wrapper
 * that draws the disabled state; this is the answer behind it.
 *
 * It lives apart from that component on purpose: a module that exports both a component and a hook
 * defeats React's fast refresh, which is a development papercut with no upside.
 */
export function useGate(need: Need): Verdict {
  return gate(need, useAtomValue(capsAtom))
}
