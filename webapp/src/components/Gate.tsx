import type { ReactNode } from 'react'

import type { Need } from '@/device/caps'
import { cn } from '@/lib/utils'
import { useGate } from '@/state/useGate'

/**
 * Wrap a control that a given thermostat may not be able to use.
 *
 * DISABLED WITH A REASON, NEVER HIDDEN. The reason is shown, not merely put in a tooltip: on a
 * phone there is no hover, so a tooltip is the same as saying nothing. Pointer events are turned
 * off over the children so a disabled section cannot be operated by reaching past the styling.
 */
export function Gate({
  need,
  children,
  className,
}: {
  need: Need
  children: ReactNode
  className?: string
}) {
  const { ok, reason } = useGate(need)
  return (
    <div>
      {/* `className` GOES ON THE ELEMENT THAT HOLDS THE CHILDREN, not on the wrapper outside it.
          Every caller passes a `space-y-*`, and spacing only reaches the elements it is the direct
          parent of — on the outer div it governed this inner one and the reason paragraph, which
          are not what anybody meant. The symptom is quiet and easy to misread as a missing margin
          on one component: five screens were laying their groups out with no gap at all. */}
      <div
        aria-disabled={!ok}
        className={cn(className, !ok && 'pointer-events-none select-none opacity-40')}
        inert={!ok || undefined}
      >
        {children}
      </div>
      {!ok && reason && <p className="mt-2 text-xs text-muted-foreground">{reason}</p>}
    </div>
  )
}
