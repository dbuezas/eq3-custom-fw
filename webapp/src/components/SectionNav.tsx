import { useAtom, useAtomValue } from 'jotai'
import { Activity, LayoutGrid, SlidersHorizontal, Upload } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { cn } from '@/lib/utils'
import { flashBusyAtom } from '@/device/flashGuards'
import { sectionAtom, type Section } from '@/state/atoms'

import { Button } from './ui/button'

/**
 * What each tab holds, and why it is that one, is stated once in `App.tsx`'s header.
 *
 * **EVERY TAB IS ALWAYS REACHABLE** `[owner]`, connected or not. A tab is a place, and a place a
 * person cannot walk into tells them nothing about why — where the same person, standing in it,
 * reads "connect to the thermostat to use this" on the very control they wanted. The greying-out
 * belongs to the CONTENT, one level down, which is where `Gate` already puts it and where the
 * reason can be specific: needing a link and needing our firmware are different answers, and a
 * disabled tab cannot tell them apart. It is also what makes an address like
 * `/thermostat/<id>/settings` open, which is the point of having addresses at all.
 */
const TABS: { id: Section; label: string; icon: LucideIcon }[] = [
  { id: 'status', label: 'Status', icon: Activity },
  { id: 'settings', label: 'Settings', icon: SlidersHorizontal },
  { id: 'display', label: 'Display', icon: LayoutGrid },
  { id: 'install', label: 'Install', icon: Upload },
]

export function SectionNav() {
  const [section, setSection] = useAtom(sectionAtom)
  /**
   * **THE ONE EXCEPTION to "every tab is always reachable", and it is not a gating decision.**
   * While firmware is being written, leaving this screen is blocked everywhere else too — the back
   * button, a reload, the address — because an interrupted flash leaves a device half-written rather
   * than an action undone. A tab bar that still moved would be the one hole left in that, and it is
   * the one a thumb finds by accident, since it sits exactly where the thumb rests.
   */
  const flashing = useAtomValue(flashBusyAtom)

  return (
    // Pinned to the bottom because this is used standing at a radiator, one-handed: the reachable
    // part of a phone is the bottom third, and a top tab bar puts every control where the thumb is
    // not. The safe-area inset keeps it clear of the home indicator.
    <nav
      className="fixed inset-x-0 bottom-0 z-10 border-t bg-background/95 backdrop-blur"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <ul className="mx-auto flex max-w-2xl">
        {TABS.map(({ id, label, icon: Icon }) => (
          <li key={id} className="flex-1">
            <Button
              variant="ghost"
              onClick={() => setSection(id)}
              disabled={flashing && section !== id}
              title={flashing ? 'firmware is being written — this cannot be left now' : undefined}
              aria-current={section === id ? 'page' : undefined}
              className={cn(
                'h-auto w-full flex-col gap-1 py-2 text-xs',
                section === id ? 'text-primary' : 'text-muted-foreground',
              )}
            >
              <Icon className="size-5" />
              {label}
            </Button>
          </li>
        ))}
      </ul>
    </nav>
  )
}
