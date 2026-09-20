import { useAtomValue } from 'jotai'
import { Clock, Sun } from 'lucide-react'
import { useState } from 'react'

import { sendClock } from '@/device/link'
import { log } from '@/state/log'
import { statusAtom } from '@/state/atoms'

import { Button } from './ui/button'

/**
 * The thermostat's clock, and what it does with it in spring and autumn.
 *
 * THE TWO BELONG TOGETHER because summer time is only a fact about the clock — and one of them can
 * be changed from here and the other cannot, which is the thing worth saying on the same screen.
 *
 * The connection sends the clock and this button re-sends it (`device/link.ts`, `introduce`).
 * `cmd 0x03`'s reply is a status, which is the only status this app gets.
 *
 * Nothing retries `[owner]` — the button IS the retry.
 */
export function TimeSettings() {
  const status = useAtomValue(statusAtom)
  const [sending, setSending] = useState(false)

  const send = () => {
    setSending(true)
    void sendClock()
      .then((s) => log(s ? 'clock sent' : 'the thermostat did not answer — try again'))
      .finally(() => setSending(false))
  }

  return (
    <ul className="divide-y overflow-hidden rounded-xl border bg-card">
      <li className="flex items-center gap-3 px-4 py-3">
        <Clock className="size-5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">Clock</span>
          <span className="block text-xs text-muted-foreground">
            sent automatically when you connect; press to send it again. Also starts the valve
            adaptation if called after booting.
          </span>
        </span>
        {/* NO `!connected` HERE: the Settings tab's `Gate need="link"` already makes this row inert
            without one, and a second copy of that decision is one that can disagree. */}
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          disabled={sending}
          onClick={send}
        >
          {sending ? 'Sending…' : 'Send now'}
        </Button>
      </li>

      {/* READ-ONLY: the flag is in every status reply, but no command sets it — the thermostat's own
          menu page is its only writer `[binary]`. Shown anyway, because "the app does not offer
          this" and "the thermostat is not doing this" look identical when a setting is absent. */}
      <li className="flex items-center gap-3 px-4 py-3">
        <Sun className="size-5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">Summer time</span>
          {/* Both names, because an owner may be standing at either firmware: this one scrolls the
              whole word, eQ-3's shows the three-letter code. */}
          <span className="block text-xs text-muted-foreground">
            {status === null
              ? 'not reported yet — send the clock to ask for it'
              : status.dst
                ? 'the thermostat moves its own clock in spring and autumn'
                : 'its clock stays on winter time all year'}
            . Change it on the thermostat under <strong>dAyLIGHt SAVInGS</strong> (
            <strong>dSt</strong> on stock) — there is no command to set it
          </span>
        </span>
        <span className="shrink-0 text-sm font-medium">
          {status === null ? <span className="text-muted-foreground">—</span> : status.dst ? 'on' : 'off'}
        </span>
      </li>
    </ul>
  )
}
