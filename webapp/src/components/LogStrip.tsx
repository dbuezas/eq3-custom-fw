import { useAtomValue } from 'jotai'
import { ChevronRight } from 'lucide-react'
import { useState } from 'react'

import { ActivityLog } from '@/components/ActivityLog'
import { Sheet } from '@/components/Sheet'
import { logAtom } from '@/state/atoms'

/**
 * THE LAST THING THE APP SAID, at the top of every screen — and the whole log one tap away.
 *
 * **IT IS THE ONLY READER OF THE LOG, on the list and inside a thermostat alike** `[owner]`. Most
 * of what goes wrong goes wrong INSIDE a thermostat — a command that is not answered, a link that
 * drops mid-install, a key that does not fit — while the failures that happen on the LIST are
 * silent Web Bluetooth ones. A log per screen reports each of those somewhere the person is not
 * standing, or at the foot of the page instead of under the button that provoked it. One strip, one
 * place, one thing to learn.
 *
 * **IT SHOWS THE NEWEST LINE AND NOTHING IS STORED TO DO IT.** `logAtom` is newest-first, so the
 * line is `lines[0]` read during render — no copy, no effect filling one in, nothing to go stale
 * while somebody is looking at it. The sheet renders `ActivityLog`, which is the whole log, so
 * there is one renderer of each and not two that can drift.
 *
 * **THE CLOCK IS WHAT MAKES IT READABLE AT ALL** `[owner]`, and it is the reason this is not simply
 * a status line: without a time, a line that has been sitting there for ten minutes looks exactly
 * like one that just arrived, so the app appears to be saying something about NOW when it is not.
 * Same format as the sheet's, because this line is one of the lines in the sheet it opens.
 *
 * **AND IT IS NOT SCOPED TO THIS VISIT.** A "since you came in" boundary is a stored value derived
 * from a route change, which is the shape this app does not keep; newest-first ordering already
 * puts what just happened at the top. The lines from just BEFORE arriving are often the ones that
 * explain why the thermostat is behaving like this, so cutting them loses the answer being asked
 * for.
 */
export function LogStrip() {
  const lines = useAtomValue(logAtom)
  // Ephemeral and owned by nothing else: whether this sheet is open is not derived from any device
  // fact, and no other component asks. An atom here would be state for its own sake.
  const [open, setOpen] = useState(false)
  const latest = lines[0]

  if (!latest) return null

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        // FULL WIDTH AND ONE LINE. It sits under a bar that already holds a name, a state and two
        // numbers; a wrapping line here would push the tabs down every time the app said something
        // long, which is exactly when somebody is trying to read the screen behind it.
        className="flex w-full items-center gap-2 border-t px-3 py-1.5 text-left text-xs text-muted-foreground"
        aria-label="Show what the app has been doing"
      >
        {/* THE SAME CLOCK FORMAT THE FULL LOG USES. A line shown twice in two formats reads as two
            different events, and this line IS one of the lines in the sheet it opens. */}
        <time className="shrink-0 tabular-nums" dateTime={new Date(latest.at).toISOString()}>
          {new Date(latest.at).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          })}
        </time>
        <span className="min-w-0 flex-1 truncate">{latest.text}</span>
        {/* THE ONLY THING SAYING THIS IS A CONTROL. It is a one-line strip of muted text under a
            bar full of muted text, with nothing else about it that looks pressable. */}
        <ChevronRight className="size-3 shrink-0" />
      </button>
      {open && (
        <Sheet title="What the app has been doing" onClose={() => setOpen(false)}>
          <ActivityLog />
        </Sheet>
      )}
    </>
  )
}
