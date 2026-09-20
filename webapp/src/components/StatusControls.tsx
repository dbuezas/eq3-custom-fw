import { useAtomValue } from 'jotai'
import { Flame, Lock, LockOpen, Minus, Moon, Plus, Sun, Wind } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import {
  TEMP_MAX,
  TEMP_MIN,
  TEMP_STEP,
  selectComfort,
  selectEco,
  setBoost,
  setLock,
  setMode,
  setTemperature,
  setWindow,
  tempText,
} from '@/device/commands'
import { log } from '@/state/log'
import { request, send, sendClock } from '@/device/link'
import { isStatus } from '@/device/status'
import { cn } from '@/lib/utils'
import { advertAtom, statusAtom } from '@/state/atoms'

import { Gate } from './Gate'
import { Button } from './ui/button'
import { Card } from './ui/card'
import { Slider } from './ui/slider'
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group'

/** How long the target has to sit still before it is sent. Long enough to hold a run of presses
 *  together, short enough that letting go feels like it acted. */
const SETTLE_MS = 500

/**
 * The controls somebody actually uses: the target, the mode, boost, the lock and the window.
 *
 * ================================================================================================
 * EVERY COMMAND HERE ANSWERS WITH THE WHOLE STATUS, so nothing polls
 * ================================================================================================
 * `link.ts` decodes that reply wherever it arrives, which means pressing a button updates the page
 * from the device's own answer rather than from what the button hoped. There is no refresh timer to
 * race the write queue — the shape that made a poll timer, a retry and a button press three
 * producers pointed at one characteristic.
 *
 * ================================================================================================
 * THE TARGET IS THE ONE CONTROL THAT RUNS AHEAD OF THE DEVICE
 * ================================================================================================
 * Every other control here does one thing per press, so it can wait for the answer. The target does
 * not: a person adjusting it presses `+` four times in a row, or drags the slider across the whole
 * range, and each of those is one intention rather than four or forty. So this control keeps the
 * value the thumb is aiming at, shows it at once, and sends it once the presses stop
 * (`SETTLE_MS`) — the device is told the destination, not the journey.
 *
 * **An optimistic value that can get stuck is worse than no optimism**, so the pretence ends the
 * moment the send settles, whatever the outcome: the number goes back to being the device's, and a
 * thermostat that did not answer says so in the log rather than leaving a number on the screen that
 * nothing on the wall agrees with.
 *
 * Nothing here throttles for the radio's sake; `link.ts`'s queue is what keeps one write in flight,
 * which is the rule that protects the radio — so callers may
 * fire whenever they like. The wait is for the PERSON — it is what makes four presses one command.
 *
 * **THE TARGET AND THE CURRENT TEMPERATURE COME FROM DIFFERENT PLACES, and that is the device's
 * doing.** The status reply carries the TARGET; the measured temperature is not in it at all and
 * reaches a client only through the BThome broadcast. So the big number here is what you asked for,
 * and the small one under it is what the thermostat actually reads — which is also why that one can
 * be missing on a thermostat whose broadcast this browser cannot decode.
 *
 * It is labelled **current**, which is the thermostat's own word: its menu page spells this screen
 * `cUr` and the idle panel marks the reading with a lowercase `c` `[owner]`.
 */
export function StatusControls() {
  const status = useAtomValue(statusAtom)
  const adv = useAtomValue(advertAtom)
  const [busy, setBusy] = useState(false)

  /** Send, and let the reply speak. A refusal is logged, not swallowed and not guessed at. */
  const ask = (bytes: number[], what: string) => {
    setBusy(true)
    void request(bytes, isStatus)
      .then((r) => {
        if (!r) log(`${what}: the thermostat did not answer`)
      })
      .finally(() => setBusy(false))
  }

  /**
   * For the one command that answers NOTHING. Waiting on `cmd 0x30` would burn every attempt's
   * timeout and then call a command that worked a failure — the device's own ~1 Hz push is what
   * shows it landed, within about a second.
   */
  const tell = (bytes: number[]) => {
    setBusy(true)
    void send(bytes).finally(() => setBusy(false))
  }

  /**
   * THE TARGET COMES FROM WHICHEVER SOURCE SPOKE MOST RECENTLY. Preferring the status reply freezes
   * the number while connected: the reply is refreshed only when a command answers or the device
   * pushes one, while the broadcast keeps arriving every second — so a target changed on the glass,
   * or by the weekly programme, shows the value from whenever the link was opened.
   *
   * Both carry the moment they arrived, so the rule is simply "newest wins". Straight after a
   * command the reply is newest and the control answers instantly; a second later the broadcast
   * takes over and keeps it honest.
   *
   * **PER VALUE, NOT PER BROADCAST.** The two object sets alternate, so the set carrying the target
   * comes round only every other advert — dating it by "when the last broadcast arrived" makes a
   * two-second-old target look newer than the reply that just changed it, and the number visibly
   * goes back to the old one for about a second. `adv.valuesAt` is when each value itself last
   * arrived, which is the question being asked here.
   */
  const freshEnough = (k: string) => !status || (adv.valuesAt[k] ?? 0) > status.at
  const advTarget =
    typeof adv.values['temperature #2'] === 'number' && freshEnough('temperature #2')
      ? (adv.values['temperature #2'] as number)
      : null
  const target = status && advTarget === null ? status.setpoint : advTarget

  /**
   * THE SAME RULE FOR THE FLAGS: the broadcast's second object set carries the window, the child
   * lock and boost, so without it a lock turned on at the thermostat goes unnoticed for as long as
   * the link stays open. `null` where the broadcast has not said — the two object sets alternate,
   * so one of them is legitimately missing for the first second.
   */
  const advFlag = (k: string) =>
    freshEnough(k) && typeof adv.values[k] === 'boolean' ? (adv.values[k] as boolean) : null
  const boost = advFlag('boost/generic') ?? !!status?.boost
  const lock = advFlag('lock') ?? !!status?.lock
  const window = advFlag('window') ?? !!status?.window
  const room = typeof adv.values.temperature === 'number' ? (adv.values.temperature as number) : null

  /**
   * THE TARGET THE THUMB IS AIMING AT — `null` whenever the device's own value is the truth.
   *
   * It is held in a ref beside the state because both the timer and the send read it after the
   * render that set it: the state is what the screen shows, the ref is what the send means.
   */
  const [wanted, setWanted] = useState<number | null>(null)
  const wantedRef = useRef<number | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const shown = wanted ?? target

  function flush() {
    timer.current = null
    const c = wantedRef.current
    if (c === null) return
    void request(setTemperature(c), isStatus)
      .then((r) => {
        if (!r) log('temperature: the thermostat did not answer')
      })
      .finally(() => {
        // Only stop pretending if this is still the value being aimed at. If it moved again while
        // this was in flight a later timer is already armed, and clearing here would flash the
        // device's old number in between.
        if (wantedRef.current !== c) return
        wantedRef.current = null
        setWanted(null)
      })
  }

  /** Aim at a temperature: shown immediately, sent once the presses stop. */
  function aim(c: number) {
    const v = Math.min(TEMP_MAX, Math.max(TEMP_MIN, c))
    wantedRef.current = v
    setWanted(v)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(flush, SETTLE_MS)
  }

  // LEAVING THE TAB MID-ADJUSTMENT STILL SENDS IT. Switching section unmounts this control, and an
  // adjustment dropped on the way out is the one failure a person cannot see.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
      if (wantedRef.current !== null) void request(setTemperature(wantedRef.current), isStatus)
    },
    [],
  )

  /**
   * A NUDGE, FROM WHEREVER THE THERMOSTAT ACTUALLY IS — asking it first if we do not know.
   *
   * ==============================================================================================
   * NOT KNOWING IS NOT A REASON TO TAKE THE CONTROLS AWAY `[owner]`
   * ==============================================================================================
   * A person can set a temperature without having read the current one, and the frame that would
   * have told us may never come: a status arrives only when a command asks for one or the
   * thermostat's own periodic path pushes one, and that path does not run until the device is past
   * date entry and out of any fault screen (`device/status.ts`). So a connected thermostat that is
   * merely sitting there has told us nothing, and these three controls work anyway.
   *
   * **THE FIRST PRESS ASKS, AND NOTHING ASKS BEFORE THEN** `[owner]`. The only frame that answers
   * with a status and is not itself a change is `cmd 0x03`, which sets the thermostat's CLOCK — a
   * side effect, and not one to spend on every connection just in case. A press is the moment it is
   * worth spending: somebody has said which way they want the temperature to go, so the clock write
   * buys the number that makes their press mean what they meant. (The app has no read-only way to
   * ask: `cmd 0x00` answers the version and serial, `cmd 0x16` the settings and not the target, and
   * every other status-answering command moves something. That gap is a firmware command we have
   * not built.)
   *
   * ONE CLOCK, NOT ONE PER PRESS: a second press while the first is still in flight waits on the
   * same answer. And a thermostat that does not answer that either still gets the press — from
   * `TEMP_MIN`, the bottom of its own range, rather than a temperature this app made up.
   */
  const asking = useRef<ReturnType<typeof sendClock> | null>(null)

  async function nudge(step: number) {
    let from = shown
    if (from === null) {
      asking.current ??= sendClock()
      const answered = await asking.current
      asking.current = null
      from = answered?.setpoint ?? TEMP_MIN
    }
    aim(from + step)
  }

  return (
    <Gate need="link" className="space-y-4">
      <Card className="p-4">
        <div className="flex items-center gap-4">
          {/* NOT DISABLED WHILE A SEND RUNS, unlike everything else on this card. These two and the
              slider are the controls a person uses repeatedly, and a button that goes dead under a
              thumb loses the press instead of counting it. `link.ts`'s queue is what keeps the
              radio safe, so there is nothing for a disabled button to protect. */}
          {/* DISABLED ONLY AT A LIMIT WE ACTUALLY KNOW. With no reading yet the button must still
              work — `nudge` is what goes and finds the number. */}
          <StepButton icon={Minus} label="Cooler" disabled={shown !== null && shown <= TEMP_MIN} onClick={() => void nudge(-TEMP_STEP)} />
          <div className="min-w-0 flex-1 text-center">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">Target</div>
            {/* GREYED WHILE IT IS STILL OURS. The number goes back to full strength the moment the
                thermostat's own answer carries it, so "this is what I asked for" and "this is what
                the wall says" never look the same. A send that is refused greys, reverts and logs —
                which is the same signal, arriving the other way. */}
            <div
              className={cn(
                'text-4xl font-semibold tabular-nums transition-colors',
                wanted !== null && 'text-muted-foreground',
              )}
            >
              {shown === null ? <span className="text-muted-foreground">—</span> : tempText(shown)}
            </div>
            <div className="mt-1 text-xs text-muted-foreground tabular-nums">
              {room !== null ? `current ${room.toFixed(1)}°` : 'current —'}
            </div>
            {/* ALWAYS ONE LINE, whatever it says, so the mode changing does not move everything
                under it. What it says in AUTO is measured and would otherwise look like the app
                failing to set a temperature: the weekly programme takes the target back at its next
                switch point — seen on the device, 22.0 set by hand became 17.0 when auto
                resumed. */}
            <div className="mt-1 text-xs text-muted-foreground">
              {status?.mode === 'auto'
                ? 'until the programme’s next change'
                : status?.mode === 'manual'
                  ? 'held until you change it'
                  : ' '}
            </div>
          </div>
          <StepButton icon={Plus} label="Warmer" disabled={shown !== null && shown >= TEMP_MAX} onClick={() => void nudge(TEMP_STEP)} />
        </div>

        {/* THE WHOLE RANGE UNDER ONE THUMB, the same control the programme editor uses for the same
            quantity. The buttons are for a nudge; this is for going somewhere. Both feed `aim`, so
            a drag across the range is still one command when it stops. */}
        <div className="mt-2 flex items-center gap-3">
          <span className="w-9 shrink-0 text-xs text-muted-foreground tabular-nums">{tempText(TEMP_MIN)}</span>
          {/* THE SLIDER NEEDS NO STARTING POINT, unlike the two buttons: a drag names the
              temperature outright, and the reply to that command carries the status anyway. So it
              never writes the clock. It rests at the bottom of the range while nothing is known,
              which the `—` above it says plainly enough. */}
          <Slider
            min={TEMP_MIN}
            max={TEMP_MAX}
            step={TEMP_STEP}
            value={[shown ?? TEMP_MIN]}
            onValueChange={([v]) => aim(v!)}
            aria-label="Target temperature"
            className="min-w-0 flex-1 py-3"
          />
          <span className="w-9 shrink-0 text-right text-xs text-muted-foreground tabular-nums">{tempText(TEMP_MAX)}</span>
        </div>

        {/* THE THERMOSTAT'S OWN COMFORT BUTTON, which the app had no equivalent of. It is what
            makes the two saved temperatures in the Settings tab worth setting: without a way to
            select them they are a pair of numbers nothing reaches. Here rather than in Settings
            because they set the TARGET — the same thing the two buttons either side of it do. */}
        <div className="mt-3 flex gap-2 border-t pt-3">
          <Button
            variant="outline"
            className="flex-1"
            disabled={busy}
            onClick={() => ask(selectComfort(), 'comfort temperature')}
          >
            <Sun /> Comfort
          </Button>
          <Button
            variant="outline"
            className="flex-1"
            disabled={busy}
            onClick={() => ask(selectEco(), 'eco temperature')}
          >
            <Moon /> Eco
          </Button>
        </div>
      </Card>

      <section className="grid grid-cols-2 gap-3">
        <Toggle
          icon={Flame}
          label="Boost"
          on={boost}
          disabled={busy}
          onClick={() => ask(setBoost(!boost), 'boost')}
        />
        <Toggle
          icon={lock ? Lock : LockOpen}
          label={lock ? 'Buttons locked' : 'Buttons unlocked'}
          on={lock}
          disabled={busy}
          onClick={() => ask(setLock(!lock), 'child lock')}
        />
        <Toggle
          icon={Wind}
          label={window ? 'Window open' : 'Window closed'}
          on={window}
          disabled={busy}
          onClick={() => tell(setWindow(!window))}
          // The thermostat may close this on its own — the owner's own `Win` duration decides, and
          // a zero duration holds it until told otherwise. So it is not a switch that stays put.
          // The line is always there, blank when there is nothing to say, so the tile keeps its
          // height and the grid does not shift when a window opens.
          hint={window ? 'the thermostat may close this itself' : ' '}
        />
        <ModePicker
          mode={status?.mode ?? null}
          disabled={busy}
          onPick={(m) => ask(setMode(m), 'mode')}
        />
      </section>
    </Gate>
  )
}

function StepButton({
  icon: Icon,
  label,
  disabled,
  title,
  onClick,
}: {
  icon: LucideIcon
  label: string
  disabled: boolean
  /** Why it cannot be pressed, from `caps.ts`. Null when it can. */
  title?: string | null
  onClick: () => void
}) {
  return (
    <Button
      variant="outline"
      size="icon-lg"
      aria-label={label}
      disabled={disabled}
      title={title ?? undefined}
      onClick={onClick}
      className="shrink-0 rounded-full"
    >
      <Icon className="size-6" />
    </Button>
  )
}

function Toggle({
  icon: Icon,
  label,
  on,
  disabled,
  onClick,
  hint,
}: {
  icon: LucideIcon
  label: string
  on: boolean
  disabled: boolean
  onClick: () => void
  hint?: string
}) {
  return (
    <Button
      variant="outline"
      aria-pressed={on}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'h-auto min-h-16 flex-col items-start justify-center gap-1 p-3 text-left font-normal whitespace-normal',
        on ? 'border-primary/40 bg-primary/10' : 'bg-card',
      )}
    >
      <Icon className={on ? 'text-primary' : 'text-muted-foreground'} />
      <span className="text-sm font-medium">{label}</span>
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </Button>
  )
}

/**
 * Auto or manual, and vacation shown but never set.
 *
 * Vacation's command carries an end date and time; a mode that silently ends at a moment the app
 * did not state is worse than no control. Showing it is different — it is a fact about the device,
 * and a person who sees "vacation" understands why the programme is not running.
 */
function ModePicker({
  mode,
  disabled,
  onPick,
}: {
  mode: 'auto' | 'manual' | 'vacation' | null
  disabled: boolean
  onPick: (m: 'auto' | 'manual') => void
}) {
  return (
    // THE PICKER IS ALWAYS THE PICKER, in every mode: holiday is a caption below the same two
    // buttons with neither selected, which is exactly true, rather than text REPLACING the control
    // and taking it out from under a thumb whenever the thermostat happens to be in that mode.
    <div className="flex min-h-16 flex-col justify-center gap-1 rounded-xl border bg-card p-3">
      <ToggleGroup
        type="single"
        variant="outline"
        value={mode === 'vacation' ? '' : (mode ?? '')}
        disabled={disabled}
        // EMPTY IS REFUSED. Radix clears a single-select group when its active item is pressed
        // again, and there is no "no mode" on this thermostat — that press must do nothing.
        onValueChange={(m) => m && onPick(m as 'auto' | 'manual')}
        className="w-full"
      >
        {(['auto', 'manual'] as const).map((m) => (
          <ToggleGroupItem key={m} value={m} aria-label={m} className="flex-1 capitalize">
            {m}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <span className="text-xs text-muted-foreground">
        {mode === 'vacation' ? 'holiday mode — set on the thermostat; it ends by itself' : ' '}
      </span>
    </div>
  )
}
