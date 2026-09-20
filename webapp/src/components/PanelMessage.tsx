import { MessageSquare } from 'lucide-react'
import { useState } from 'react'

import { log } from '@/state/log'
import { request } from '@/device/link'
import { CELLS } from '@/device/lcd_tables'
import {
  HOLD_FOREVER,
  MESSAGE_MAX,
  clearText,
  isTextReply,
  showText,
  toGlyphs,
} from '@/device/panel'

import { Gate } from './Gate'
import { Button } from './ui/button'
import { Card } from './ui/card'
import { Input } from './ui/input'

/**
 * Write a few characters onto the thermostat's own screen.
 *
 * It is a Status control rather than a setting `[owner]`, for the same reason `SoundButton` is:
 * nothing is stored and nothing is configured. It is a thing you do once — to label which radiator
 * you are standing at, or to leave a word for whoever walks past it.
 *
 * **THE MESSAGE STAYS UNTIL IT IS CLEARED, and that is the whole rule** `[owner]`. The command can
 * hold for a count of half-seconds instead, but a duration is a second control to design and a
 * number a person has to choose before they can see anything; the firmware already ends a message
 * as soon as a button is pressed or the wheel is turned, so a forgotten one is undone by using the
 * thermostat. Clear is beside Show for the case where nobody is standing there.
 *
 * **AN ACK MEANS "STORED", NOT "VISIBLE"** — `showText` in `device/panel.ts` says which screens own
 * the glass and win. So this reports that it was sent, and never claims it is on the glass.
 */
export function PanelMessage() {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)

  const { glyphs, bad } = toGlyphs(text)
  const scrolls = text.length > CELLS

  const paint = (bytes: number[], what: string) => {
    setBusy(true)
    void request(bytes, isTextReply)
      .then((r) => log(r ? what : `${what}: the thermostat did not answer`))
      .finally(() => setBusy(false))
  }

  return (
    <Gate need="modThermostat">
      <Card className="p-4">
        <div className="flex items-center gap-3">
          <MessageSquare className="size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">Write on the screen</div>
            <div className="text-xs text-muted-foreground">
              It stays until you clear it, or until someone presses a button on the thermostat.
            </div>
          </div>
        </div>

        <div className="mt-3 flex gap-2">
          <Input
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={MESSAGE_MAX}
            placeholder="HELLO"
            aria-label="Message for the thermostat's screen"
            className="flex-1"
          />
          <Button
            variant="outline"
            disabled={busy || glyphs.length === 0 || bad.length > 0}
            onClick={() => paint(showText(glyphs, HOLD_FOREVER), `wrote “${text}” to the screen`)}
          >
            Show
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => paint(clearText(), 'cleared the screen')}
          >
            Clear
          </Button>
        </div>

        {/* WHAT THE GLASS CANNOT DO, SAID BEFORE IT IS SENT. Seven segments cannot draw an `m`, an
            `M`, an `X` or a `W` on a stock radio, so a message with one in it would go out drawn
            wrong rather than refused — see `toGlyphs`. The scroll line is here for the same reason:
            four cells is what the panel has, and a longer message walks across them. */}
        {bad.length > 0 ? (
          <p className="mt-2 text-xs text-warn">
            The screen cannot draw {bad.map((c) => `“${c}”`).join(', ')}. Seven segments have no
            shape for it.
          </p>
        ) : (
          scrolls && (
            <p className="mt-2 text-xs text-muted-foreground">
              Longer than the four cells the screen has, so it will scroll and repeat.
            </p>
          )
        )}
      </Card>
    </Gate>
  )
}
