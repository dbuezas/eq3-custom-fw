import { Volume2 } from 'lucide-react'
import { useState } from 'react'

import { log } from '@/state/log'
import { JINGLES, playJingle } from '@/device/config'
import { request } from '@/device/link'
import { byTag } from '@/device/protocol'

import { Gate } from './Gate'
import { Button } from './ui/button'
import { Card } from './ui/card'

/**
 * Make the thermostat play a sound — the answer to "which radiator am I connected to?".
 *
 * It is a Status control rather than a setting `[owner]`: nothing is stored and nothing is
 * configured, it is a thing you do once, standing in a flat with four identical valves.
 *
 * **THE REPLY FOLLOWS THE SOUND, NOT THE COMMAND** `[binary]`. The tone masks interrupts, so the
 * device answers nothing at all while it plays. Measured on the device: the trill answered after
 * **1.05 s**, against a per-attempt timeout of 1.5 s — so the longest tune sits close enough to
 * that ceiling that a single attempt would be a coin toss. `request`'s retries cover it and the
 * button stays busy meanwhile; the retry is what makes this safe, not the timeout.
 */
export function SoundButton() {
  const [playing, setPlaying] = useState<number | null>(null)

  const play = (id: number, name: string) => {
    setPlaying(id)
    void request(playJingle(id), byTag(0x1b))
      .then((r) => log(r ? `played ${name}` : `${name}: no answer — the motor may have been busy`))
      .finally(() => setPlaying(null))
  }

  return (
    <Gate need="modThermostat">
      <Card className="p-4">
        <div className="flex items-center gap-3">
          <Volume2 className="size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">Make a sound</div>
            <div className="text-xs text-muted-foreground">
              to tell which radiator this is. It plays on the valve motor, so it is quiet.
            </div>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {JINGLES.map((j) => (
            <Button
              key={j.id}
              variant="outline"
              title={j.hint}
              disabled={playing !== null}
              onClick={() => play(j.id, j.name)}
            >
              {playing === j.id ? 'Playing…' : j.name}
            </Button>
          ))}
        </div>
      </Card>
    </Gate>
  )
}
