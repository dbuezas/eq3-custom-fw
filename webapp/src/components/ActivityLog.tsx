import { useAtomValue } from 'jotai'

import { logAtom } from '@/state/atoms'

/**
 * What the app did, newest first.
 *
 * It is the first thing built because a Web Bluetooth failure is usually SILENT — a page with no
 * `navigator.bluetooth`, a chooser dismissed, a device that stopped answering — and without a line
 * saying so the screen just looks idle.
 */
export function ActivityLog() {
  const lines = useAtomValue(logAtom)

  if (lines.length === 0) {
    return (
      <p className="py-10 text-center text-sm text-muted-foreground">
        Nothing yet. Connect to begin.
      </p>
    )
  }

  return (
    <ol className="divide-y rounded-xl border">
      {lines.map((l) => (
        <li key={l.id} className="flex gap-3 px-3 py-2 text-sm">
          <time
            className="shrink-0 tabular-nums text-muted-foreground"
            dateTime={new Date(l.at).toISOString()}
          >
            {new Date(l.at).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
            })}
          </time>
          <span className="min-w-0 break-words">{l.text}</span>
        </li>
      ))}
    </ol>
  )
}
