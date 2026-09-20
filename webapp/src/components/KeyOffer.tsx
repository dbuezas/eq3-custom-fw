import { atom, getDefaultStore, useAtomValue, useSetAtom } from 'jotai'
import { useEffect, useState } from 'react'

import { Sheet } from '@/components/Sheet'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { KEY_CHARS, cleanKey } from '@/device/access'
import { installKeyAsker } from '@/device/link'
import { cn } from '@/lib/utils'

/**
 * "This thermostat has a key" — asked of the few who need it, never of everybody.
 *
 * **THE THERMOSTAT IS ASKED FIRST, AND IT ANSWERS DEFINITIVELY.** The connection probes the
 * encrypted door — the device replies to it if and only if it holds a key, and that door is not
 * covered by the PIN gate — so this sheet appears only when there is genuinely a key to supply,
 * rather than a key field put to every device for a feature most of them do not have.
 * `device/link.ts`, `installKeyAsker`, is the mechanism and why it is safe.
 *
 * **"Use the paired channel" is a real answer, not a cancel.** Somebody who does not hold the key can
 * only pair, and somebody who does may still want the paired door — a phone already bonded, a key
 * being diagnosed. Choosing it is what lets the platform's pairing prompt appear, which is the
 * correct thing to happen at that point rather than a failure.
 *
 * By the time this shows, the link is already open: the answer decides which door the rest of the
 * connection uses, not whether there is one.
 */
const askAtom = atom<{ name: string; resolve: (key: string | null) => void } | null>(null)

const store = getDefaultStore()

export function KeyOffer() {
  const ask = useAtomValue(askAtom)
  const setAsk = useSetAtom(askAtom)

  // INSTALLED FROM REACT so it goes away with the tree, and re-installed rather than guarded on
  // StrictMode's second mount — the remover makes that idempotent. With none installed the probe's
  // answer is simply unused.
  useEffect(
    () =>
      installKeyAsker(
        (d) =>
          new Promise<string | null>((resolve) => {
            store.set(askAtom, { name: d.name ?? 'This thermostat', resolve })
          }),
      ),
    [],
  )

  if (!ask) return null
  return <KeyOfferSheet ask={ask} onDone={() => setAsk(null)} />
}

/**
 * Split out so the field's state is CREATED WITH THE SHEET and dies with it. A `useState` in the
 * component above would have to be cleared by hand on every open, and a key left over from a
 * previous thermostat is the one value that must never be reused.
 */
function KeyOfferSheet({
  ask,
  onDone,
}: {
  ask: { name: string; resolve: (key: string | null) => void }
  onDone: () => void
}) {
  const [key, setKey] = useState('')
  const whole = key.length === KEY_CHARS
  const answer = (k: string | null) => {
    ask.resolve(k)
    onDone()
  }
  return (
    // NOT DISMISSABLE INTO NOTHING: closing it is the same as choosing the paired door, because a
    // connection is waiting on this answer and a promise that never settles would hang the
    // introduction — the link would be open and the app would never finish opening it.
    <Sheet
      title={`${ask.name} has an encryption key`}
      onClose={() => answer(null)}
      autoFocus={false}
    >
      <div className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          It is asking for one, so this browser can talk to it without pairing. Put the key in, or use
          the paired channel instead — that asks your phone to pair with the thermostat.
        </p>
        <div className="flex items-baseline justify-between">
          <Label htmlFor="offer-key" className="text-xs text-muted-foreground">
            Key
          </Label>
          <span className={cn('text-xs tabular-nums', whole ? 'text-ok' : 'text-muted-foreground')}>
            {key.length} / {KEY_CHARS}
          </span>
        </div>
        <Input
          id="offer-key"
          value={key}
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          maxLength={KEY_CHARS}
          onChange={(e) => setKey(cleanKey(e.target.value))}
          className="font-mono tracking-wider"
        />
        <div className="flex flex-wrap gap-2 pt-1">
          <Button disabled={!whole} onClick={() => answer(key)}>
            Use this key
          </Button>
          <Button variant="outline" onClick={() => answer(null)}>
            Use the paired channel
          </Button>
        </div>
      </div>
    </Sheet>
  )
}
