import { useAtomValue } from 'jotai'
import {
  CalendarDays,
  ChevronRight,
  Flame,
  MonitorCog,
  Radio,
  Ruler,
  SunDim,
  ThermometerSun,
  Waves,
  Wind,
  type LucideIcon,
} from 'lucide-react'
import { useCallback, useEffect, useId, useState } from 'react'

import { log } from '@/state/log'
import { Gate } from '@/components/Gate'
import { ScheduleSheet } from '@/components/ScheduleSheet'
import { TimeSettings } from '@/components/TimeSettings'
import { Sheet } from '@/components/Sheet'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Slider as SliderControl } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { TEMP_MAX, TEMP_MIN, TEMP_STEP, tempText } from '@/device/commands'
import {
  ADV_FAST,
  ADV_NORMAL,
  ADV_SLOW,
  DESCALE_4_WEEKS,
  DESCALE_8_WEEKS,
  DESCALE_OFF,
  DESCALE_WEEKLY,
  OFFSET_MAX,
  OFFSET_MIN,
  SCREEN_BAR_VALVE,
  SCREEN_CLOCK,
  SCREEN_ROOM,
  SCREEN_TARGET,
  SCREEN_VALVE,
  WINDOW_MAX_MINUTES,
  WINDOW_STEP_MINUTES,
  setAdvInterval,
  setAutodetect,
  setBoostConfig,
  setContrast,
  setComfortEco,
  setDescale,
  setOffset,
  setScreen,
  setWindowConfig,
  settingAck,
  type Settings as DeviceSettings,
} from '@/device/config'
import { advIntervalAtom, refreshAdvInterval, refreshSettings, request, settingsAtom } from '@/device/link'
import { connectedAtom } from '@/state/atoms'
import { useGate } from '@/state/useGate'

/**
 * THE THINGS SET ONCE AND LEFT ALONE — a list of rows, each opening its own dialog `[owner]`.
 *
 * The tab stays a list rather than becoming a wall of controls, and a row is greyed out with a
 * reason (never hidden) when the connected thermostat's firmware cannot do it.
 *
 * **THE WHOLE PAGE IS ONE ROUND TRIP.** `cmd 0x16` reports every setting at once, in the units of
 * the command that changes each one, so the rows show what the device actually holds rather than
 * what this app last sent — and there is no per-row request to sequence.
 */
export function Settings() {
  const connected = useAtomValue(connectedAtom)
  const mod = useGate('modThermostat')
  // The CONNECTION's, not this tab's — see `settingsAtom`.
  const cfg = useAtomValue(settingsAtom)
  const advInterval = useAtomValue(advIntervalAtom)
  const [open, setOpen] = useState<
    | null
    | 'boost'
    | 'screen'
    | 'contrast'
    | 'schedule'
    | 'comfort'
    | 'offset'
    | 'window'
    | 'descale'
    | 'advInterval'
  >(null)

  const load = useCallback(() => {
    if (!connected || !mod.ok) return
    // `log` is a module function, not a hook's setter, so it is not a dependency.
    void refreshSettings().then((ok) => {
      if (!ok) log('could not read this thermostat’s settings')
    })
    void refreshAdvInterval().then((ok) => {
      if (!ok) log('could not read the advertising interval')
    })
  }, [connected, mod.ok])

  // RE-READ WHENEVER THIS OPENS. NOT a poll: these change only when somebody changes them — the
  // thermostat's own wheel included — and a timer would be a second write producer on the queue.
  useEffect(load, [load])

  /**
   * Send a setting, then re-read them all — the device is the authority on what it stored.
   *
   * `settingAck` rather than the command's own tag: stock's setters answer with the status frame and
   * ours answer with their tag, and getting that wrong cost six seconds and a false "did not answer"
   * on three of these sheets. Its own comment has the detail.
   */
  const send = (bytes: number[], what: string) =>
    request(bytes, settingAck(bytes[0]!)).then((r) => {
      if (!r) log(`${what}: the thermostat did not answer`)
      load()
    })

  /** Send it and close the sheet — what the Send button does. */
  const apply: ApplyFn = (bytes, what) => send(bytes, what).then(() => setOpen(null))

  /**
   * Send it and STAY OPEN.
   *
   * For a slider whose effect is only judgeable by looking at the thermostat — the display's
   * contrast. Previewing and committing are different acts `[owner]`: sending through `apply` would
   * close the dialog as the slider is let go, taking away the comparison the live change is for.
   */
  const preview: ApplyFn = (bytes, what) => send(bytes, what)

  return (
    <div className="space-y-4">
      <Gate need="modThermostat" className="space-y-3">
        <ul className="divide-y overflow-hidden rounded-xl border bg-card">
          <Row
            icon={Flame}
            title="Boost"
            value={cfg ? `${cfg.boostMinutes} min · ${cfg.boostPercent}% open` : '…'}
            onClick={() => setOpen('boost')}
          />
          <Row
            icon={MonitorCog}
            title="Idle screen"
            value={cfg ? screenSummary(cfg) : '…'}
            onClick={() => setOpen('screen')}
          />
          <Row
            icon={SunDim}
            title="Display contrast"
            value={cfg ? `${cfg.contrast} of 8` : '…'}
            onClick={() => setOpen('contrast')}
          />
          <Row
            icon={Waves}
            title="Descaling"
            value={cfg ? descaleSummary(cfg) : '…'}
            onClick={() => setOpen('descale')}
          />
          <Row
            icon={Radio}
            title="Advertising interval"
            value={advInterval ? advIntervalSummary(advInterval) : '…'}
            onClick={() => setOpen('advInterval')}
          />
        </ul>
      </Gate>

      {/* GATED ON THE LINK, NOT ON OUR FIRMWARE: every command in this block is STOCK and works on
          any thermostat, which is what makes these the app's floor rather than its extras. Only
          READING them back needs the mod, which is why a value may be missing while the row
          works. */}
      <Gate need="link" className="space-y-4">
        <ul className="divide-y overflow-hidden rounded-xl border bg-card">
          <Row
            icon={CalendarDays}
            title="Weekly programme"
            value="the seven days, read from the thermostat"
            onClick={() => setOpen('schedule')}
          />
          <Row
            icon={ThermometerSun}
            title="Comfort and eco temperatures"
            value={cfg ? `${cfg.comfort}° · ${cfg.eco}°` : unread}
            onClick={() => setOpen('comfort')}
          />
          <Row
            icon={Ruler}
            title="Temperature correction"
            value={
              cfg
                ? cfg.offset === 0
                  ? 'none'
                  : `${cfg.offset > 0 ? '+' : ''}${cfg.offset}° on what it reads`
                : unread
            }
            onClick={() => setOpen('offset')}
          />
          <Row
            icon={Wind}
            title="Open window"
            value={
              cfg
                ? `${cfg.windowTemp}° for ${cfg.windowMinutes === 0 ? 'as long as it stays open' : `${cfg.windowMinutes} min`}`
                : unread
            }
            onClick={() => setOpen('window')}
          />
        </ul>

        {/* The clock, and the one setting the app can READ but not write — see `TimeSettings`. */}
        <TimeSettings />
      </Gate>

      {/* The one row here that IS ours: stock's handler for this id is reclaimed.

          `settings` RATHER THAN `modThermostat`, because it is the stronger of the two and says
          more: only our firmware answers `cmd 0x16`, so a report that has arrived already proves
          the firmware — and until it has, this switch has no state to draw. */}
      <Gate need="settings">
        <ul className="divide-y overflow-hidden rounded-xl border bg-card">
          <li className="flex items-center gap-3 px-4 py-3">
            <Wind className="size-5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">Spot an open window by itself</span>
              <span className="block text-xs text-muted-foreground">
                the thermostat watches for a sudden drop in temperature
              </span>
            </span>
            <Switch
              checked={cfg?.windowAutoDetect ?? false}
              onCheckedChange={(next) => void apply(setAutodetect(next), 'window detection')}
              aria-label="Spot an open window by itself"
            />
          </li>
        </ul>
      </Gate>

      {open === 'boost' && cfg && (
        <BoostSheet cfg={cfg} onClose={() => setOpen(null)} onApply={apply} />
      )}
      {open === 'screen' && cfg && (
        <ScreenSheet cfg={cfg} onClose={() => setOpen(null)} onApply={apply} />
      )}
      {open === 'contrast' && cfg && (
        <ContrastSheet
          cfg={cfg}
          onClose={() => setOpen(null)}
          onApply={apply}
          onPreview={preview}
        />
      )}
      {open === 'schedule' && <ScheduleSheet onClose={() => setOpen(null)} />}
      {open === 'comfort' && (
        <ComfortSheet cfg={cfg} onClose={() => setOpen(null)} onApply={apply} />
      )}
      {open === 'offset' && (
        <OffsetSheet cfg={cfg} onClose={() => setOpen(null)} onApply={apply} />
      )}
      {open === 'window' && (
        <WindowSheet cfg={cfg} onClose={() => setOpen(null)} onApply={apply} />
      )}
      {open === 'descale' && cfg && (
        <DescaleSheet cfg={cfg} onClose={() => setOpen(null)} onApply={apply} />
      )}
      {open === 'advInterval' && advInterval !== null && (
        <AdvIntervalSheet interval={advInterval} onClose={() => setOpen(null)} onApply={apply} />
      )}
    </div>
  )
}

function screenSummary(c: DeviceSettings): string {
  const on = [
    c.screenMask & SCREEN_TARGET && 'target',
    c.screenMask & SCREEN_ROOM && 'current',
    c.screenMask & SCREEN_CLOCK && 'clock',
    c.screenMask & SCREEN_VALVE && 'valve',
  ].filter(Boolean) as string[]
  const bar = c.screenMask & SCREEN_BAR_VALVE ? 'valve bar' : 'schedule bar'
  return `${on.length ? on.join(', ') : 'target only'} · ${bar}`
}

function Row({
  icon: Icon,
  title,
  value,
  onClick,
}: {
  icon: LucideIcon
  title: string
  value: string
  onClick: () => void
}) {
  return (
    <li>
      <Button variant="ghost" size="row" onClick={onClick}>
        <Icon className="shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{title}</span>
          <span className="block truncate text-xs text-muted-foreground">{value}</span>
        </span>
        <ChevronRight className="shrink-0 text-muted-foreground" />
      </Button>
    </li>
  )
}

type ApplyFn = (bytes: number[], what: string) => Promise<unknown>

/** Duration AND valve opening — one setting in two halves, and neither is much use alone. */
function BoostSheet({
  cfg,
  onClose,
  onApply,
}: {
  cfg: DeviceSettings
  onClose: () => void
  onApply: ApplyFn
}) {
  const [min, setMin] = useState(cfg.boostMinutes)
  const [pct, setPct] = useState(cfg.boostPercent)
  return (
    <Sheet title="Boost" onClose={onClose}>
      <div className="space-y-6">
        <Slider
          label="How long it runs"
          value={min}
          min={1}
          max={240}
          step={1}
          format={(v) => (v >= 60 ? `${Math.floor(v / 60)} h ${v % 60} min` : `${v} min`)}
          onChange={setMin}
        />
        <Slider
          label="How far the valve opens"
          hint="this is the one that changes how warm the room actually gets"
          value={pct}
          min={0}
          max={100}
          step={5}
          format={(v) => `${v}%`}
          onChange={setPct}
        />
        <Apply onClick={() => onApply(setBoostConfig(min, pct), 'boost settings')} />
      </div>
    </Sheet>
  )
}

/**
 * Which screens the thermostat rotates through, how fast, and what the top bar shows.
 *
 * THE MASK IS EDITED, NEVER REBUILT. Bit 4 is not a screen — it selects the top bar's content — so
 * a dialog that assembled the byte from its four checkboxes would silently switch the valve bar off
 * every time anybody touched this page. It is a checkbox here for the same reason.
 */
function ScreenSheet({
  cfg,
  onClose,
  onApply,
}: {
  cfg: DeviceSettings
  onClose: () => void
  onApply: ApplyFn
}) {
  const [mask, setMask] = useState(cfg.screenMask)
  const [secs, setSecs] = useState(cfg.screenSeconds)
  const bit = (b: number) => (mask & b) !== 0
  const toggle = (b: number) => setMask((m) => m ^ b)

  return (
    <Sheet title="Idle screen" onClose={onClose}>
      <div className="space-y-6">
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">What it shows when left alone</legend>
          <p className="text-xs text-muted-foreground">
            Tick several and it rotates between them. Tick none and it shows the target, as it always
            has.
          </p>
          <Check label="Target temperature" on={bit(SCREEN_TARGET)} onChange={() => toggle(SCREEN_TARGET)} />
          {/* The thermostat's own menu calls this screen `cUr` and marks the reading with a `c`. */}
          <Check label="Current temperature" on={bit(SCREEN_ROOM)} onChange={() => toggle(SCREEN_ROOM)} />
          <Check label="Clock" on={bit(SCREEN_CLOCK)} onChange={() => toggle(SCREEN_CLOCK)} />
          <Check label="Valve position" on={bit(SCREEN_VALVE)} onChange={() => toggle(SCREEN_VALVE)} />
        </fieldset>

        <Slider
          label="Seconds between screens"
          value={secs}
          min={1}
          max={9}
          step={1}
          format={(v) => `${v} s`}
          onChange={setSecs}
        />

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">The bar across the top</legend>
          <Check
            label="Show the valve position instead of the day’s programme"
            on={bit(SCREEN_BAR_VALVE)}
            onChange={() => toggle(SCREEN_BAR_VALVE)}
          />
        </fieldset>

        <Apply onClick={() => onApply(setScreen(mask, secs), 'idle screen')} />
      </div>
    </Sheet>
  )
}

/**
 * How often the thermostat drives the valve pin its full travel — and what turning it off costs.
 *
 * THE WARNING IS MECHANICAL AND IT BELONGS TO ONE ARM ONLY `[owner]`. A pin that sits unmoved
 * through a summer can stick with limescale, and this stroke is what prevents it; that is what an
 * owner choosing "off" is trading away. It is deliberately NOT said beside the other three, where it
 * would read as a reason to avoid them.
 *
 * And each arm says what it BUYS, because the warning alone makes every arm look like a loss: the
 * stroke takes the thermostat off the air for about a minute each time it runs.
 *
 * DO NOT WARN THAT THE THERMOSTAT STOPS ADAPTING. It does not — ordinary valve movement keeps every
 * value the regulation loop reads up to date, and only two cells that feed the stroke measurement
 * itself go stale. `stm8/reference/decomp_1.48/descale.asm`'s header has the cell-by-cell reason.
 *
 * THE BATTERY SWITCH SAVES MORE THAN CHARGE `[owner]`: the run drives the pin to both end stops, so
 * a pack that dies part-way through can leave the valve wherever the motor stopped — including fully
 * open, with the radiator on. That is the reason worth giving, and the charge is the lesser half.
 */
function DescaleSheet({
  cfg,
  onClose,
  onApply,
}: {
  cfg: DeviceSettings
  onClose: () => void
  onApply: ApplyFn
}) {
  const [every, setEvery] = useState(cfg.descale)
  const [skip, setSkip] = useState(cfg.descaleBatterySkip)
  const off = every === DESCALE_OFF

  return (
    <Sheet title="Descaling" onClose={onClose}>
      <div className="space-y-6">
        <p className="text-xs text-muted-foreground">
          <strong>Saturday at 12:00 noon</strong>, the thermostat drives the valve pin its full
          travel so limescale cannot seize it. It shows <span className="font-mono">CAL</span> while
          it does, and it answers nothing — not this page, not Home Assistant — for about a minute.
          The interval below chooses which Saturdays; the day and the time are the thermostat's own
          and cannot be changed.
        </p>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">How often</legend>
          {DESCALE_CHOICES.map((c) => (
            <Choice
              key={c.value}
              label={c.label}
              note={c.note}
              on={every === c.value}
              onChange={() => setEvery(c.value)}
            />
          ))}
        </fieldset>

        {off && (
          <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
            A valve pin that sits unmoved through a summer can stick with limescale, and the
            descaling run is what stops that. Turning it off is a trade, not a saving.
          </p>
        )}

        {/* Only asked when the stroke can happen, matching the thermostat's own menu: with it off
            there is nothing for a flat battery to hold back. The VALUE is still sent either way —
            the command carries both bytes — so switching the stroke back on restores the answer the
            owner last gave rather than silently clearing it. */}
        {!off && (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">When the batteries are low</legend>
            <Check
              label="Do not do the descaling procedure until the batteries are changed"
              on={skip}
              onChange={() => setSkip((s) => !s)}
            />
            <p className="text-xs text-muted-foreground">
              As well as saving the charge, this avoids the batteries dying part-way through the
              procedure — which can leave the radiator stuck fully open.
            </p>
          </fieldset>
        )}

        <Apply onClick={() => onApply(setDescale(every, skip), 'descaling')} />
      </div>
    </Sheet>
  )
}

/**
 * The four intervals, and what each one is worth.
 *
 * WEEKS, NOT DAYS. The thermostat's own glass says `7 dAyS` / `28 dAyS` / `56 dAyS` because its
 * font has no letter `w`; a browser has no such excuse, and weeks are how a person thinks about it.
 * The two are the same numbers.
 */
const DESCALE_CHOICES = [
  { value: DESCALE_WEEKLY, label: 'Every week', note: 'what the thermostat has always done' },
  { value: DESCALE_4_WEEKS, label: 'Every 4 weeks', note: 'thirteen runs a year instead of fifty-two' },
  { value: DESCALE_8_WEEKS, label: 'Every 8 weeks', note: 'six a year' },
  { value: DESCALE_OFF, label: 'Never', note: 'the thermostat never moves the pin on its own' },
]

function descaleSummary(c: DeviceSettings): string {
  const how = DESCALE_CHOICES.find((x) => x.value === c.descale)?.label ?? `setting ${c.descale}`
  if (c.descale === DESCALE_OFF) return how.toLowerCase()
  return c.descaleBatterySkip ? `${how.toLowerCase()} · not on a low battery` : how.toLowerCase()
}

/** A radio-style row: the same shape as `Check`, for a list where exactly one is chosen. */
function Choice({
  label,
  note,
  on,
  onChange,
}: {
  label: string
  note: string
  on: boolean
  onChange: () => void
}) {
  const id = useId()
  return (
    <div className="flex min-h-11 items-center gap-3">
      <Checkbox id={id} checked={on} onCheckedChange={onChange} />
      <Label htmlFor={id} className="text-sm font-normal">
        {label}
        <span className="block text-xs text-muted-foreground">{note}</span>
      </Label>
    </div>
  )
}

/**
 * How often the thermostat announces itself over Bluetooth — `cmd 0x22`.
 *
 * `interval` rather than `cfg`: it does not live in `Settings`, `cmd 0x16` does not report it
 * (`device/config.ts`'s header says why), so this sheet is the one row on the page that reads a
 * value of its own instead of a field off the shared settings object.
 */
function AdvIntervalSheet({
  interval,
  onClose,
  onApply,
}: {
  interval: number
  onClose: () => void
  onApply: ApplyFn
}) {
  const [choice, setChoice] = useState(interval)
  return (
    <Sheet title="Advertising interval" onClose={onClose}>
      <div className="space-y-6">
        <p className="text-xs text-muted-foreground">
          How often the thermostat's Bluetooth radio announces itself. A faster interval means
          you connect faster, at a cost to battery life; a slower one saves battery and takes
          longer to connect. The same three choices are on the thermostat's own Bluetooth menu
          page.
        </p>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">How often</legend>
          {ADV_CHOICES.map((c) => (
            <Choice
              key={c.value}
              label={c.label}
              note={c.note}
              on={choice === c.value}
              onChange={() => setChoice(c.value)}
            />
          ))}
        </fieldset>

        <Apply onClick={() => onApply(setAdvInterval(choice), 'advertising interval')} />
      </div>
    </Sheet>
  )
}

/**
 * The three intervals, and what each one is worth. Numbers from `../eq3-custom-fw/PROTOCOL.md`'s
 * `cmd 0x22` table — approximate, since they are calculated from a measured model rather than a
 * thermostat that has run a year — and stated as waiting rather than as a ratio, since that is what
 * a person watching this page or a phone actually experiences.
 */
const ADV_CHOICES = [
  {
    value: ADV_FAST,
    label: 'Fast — 0.5 s',
    note: 'roughly 29% shorter battery life · connects in half the time',
  },
  {
    value: ADV_NORMAL,
    label: 'Normal — 1.0 s (the default)',
    note: 'as the thermostat ships',
  },
  {
    value: ADV_SLOW,
    label: 'Slow — 2.0 s',
    note: 'roughly 30% longer battery life · takes twice as long to connect',
  },
]

function advIntervalSummary(v: number): string {
  return ADV_CHOICES.find((c) => c.value === v)?.label ?? `setting ${v}`
}

/** The two temperatures the thermostat's own comfort/eco button switches between. */
function ComfortSheet({
  cfg,
  onClose,
  onApply,
}: {
  cfg: DeviceSettings | null
  onClose: () => void
  onApply: ApplyFn
}) {
  const [comfort, setComfort] = useState(cfg?.comfort ?? 21)
  const [eco, setEco] = useState(cfg?.eco ?? 17)
  return (
    <Sheet title="Comfort and eco" onClose={onClose}>
      <div className="space-y-6">
        {!cfg && <Unread />}
        <Slider label="Comfort" value={comfort} min={TEMP_MIN} max={TEMP_MAX} step={TEMP_STEP}
          format={tempText} onChange={setComfort} />
        <Slider label="Eco" value={eco} min={TEMP_MIN} max={TEMP_MAX} step={TEMP_STEP}
          format={tempText} onChange={setEco} />
        <p className="text-xs text-muted-foreground">
          The thermostat&rsquo;s own third button switches between these two.
        </p>
        <Apply onClick={() => onApply(setComfortEco(comfort, eco), 'comfort and eco')} />
      </div>
    </Sheet>
  )
}

/**
 * Calibration: what to add to the temperature the thermostat reads.
 *
 * A valve sits on a hot pipe, so it usually reads warmer than the room. This is the correction the
 * device's own menu offers, over the same range.
 */
function OffsetSheet({
  cfg,
  onClose,
  onApply,
}: {
  cfg: DeviceSettings | null
  onClose: () => void
  onApply: ApplyFn
}) {
  const [offset, setOffset_] = useState(cfg?.offset ?? 0)
  return (
    <Sheet title="Temperature correction" onClose={onClose}>
      <div className="space-y-6">
        {!cfg && <Unread />}
        <Slider
          label="Add to what the thermostat reads"
          hint="a valve sits on a hot pipe, so it usually reads warmer than the room"
          value={offset}
          min={OFFSET_MIN}
          max={OFFSET_MAX}
          step={0.5}
          format={(v) => (v === 0 ? 'none' : `${v > 0 ? '+' : ''}${v.toFixed(1)}°`)}
          onChange={setOffset_}
        />
        <Apply onClick={() => onApply(setOffset(offset), 'temperature correction')} />
      </div>
    </Sheet>
  )
}

/** What the thermostat does while it believes a window is open. */
function WindowSheet({
  cfg,
  onClose,
  onApply,
}: {
  cfg: DeviceSettings | null
  onClose: () => void
  onApply: ApplyFn
}) {
  const [temp, setTemp] = useState(cfg?.windowTemp ?? 12)
  const [mins, setMins] = useState(cfg?.windowMinutes ?? 15)
  return (
    <Sheet title="Open window" onClose={onClose}>
      <div className="space-y-6">
        {!cfg && <Unread />}
        <Slider label="Turn down to" value={temp} min={TEMP_MIN} max={TEMP_MAX} step={TEMP_STEP}
          format={tempText} onChange={setTemp} />
        <Slider
          label="For how long"
          value={mins}
          min={0}
          max={WINDOW_MAX_MINUTES}
          step={WINDOW_STEP_MINUTES}
          // ZERO IS NOT "OFF", IT IS "UNTIL I SAY" -- measured. It also switches the thermostat's
          // own detection off, which is why it is spelled out rather than shown as "0 min".
          format={(v) => (v === 0 ? 'until the window is closed' : `${v} min`)}
          onChange={setMins}
        />
        {mins === 0 && (
          <p className="text-xs text-muted-foreground">
            At zero the thermostat also stops watching for a window on its own, and a window stays
            open until something closes it.
          </p>
        )}
        <Apply onClick={() => onApply(setWindowConfig(temp, mins), 'open window')} />
      </div>
    </Sheet>
  )
}

/**
 * What a row shows when the thermostat cannot report the value.
 *
 * NOT a zero and not a default: the device may hold anything, and a made-up number in a settings
 * row is one somebody will believe.
 */
const unread = 'not readable on this firmware'

/** Said once, wherever a row could not read what the device holds. */
function Unread() {
  return (
    <p className="text-sm text-muted-foreground">
      This thermostat cannot report its current setting — the original firmware has no command for
      it. What you send here replaces whatever is stored.
    </p>
  )
}

/**
 * **CONTRAST, NOT BRIGHTNESS** `[owner]`. The panel has no backlight — nothing about it is bright or
 * dim. What this drives is the LCD's drive strength, which changes how DARK a lit segment is against
 * the glass, and "brightness" sent people looking for a lamp that does not exist.
 */
function ContrastSheet({
  cfg,
  onClose,
  onApply,
  onPreview,
}: {
  cfg: DeviceSettings
  onClose: () => void
  onApply: ApplyFn
  /** Sends WITHOUT closing — this is the one setting you have to see to choose. */
  onPreview: ApplyFn
}) {
  const [pon, setPon] = useState(cfg.contrast)
  return (
    <Sheet title="Display contrast" onClose={onClose}>
      <div className="space-y-6">
        <Slider
          label="Contrast"
          hint="the thermostat changes as you let go, so you can see what you are choosing"
          value={pon}
          min={1}
          max={8}
          step={1}
          format={(v) => `${v} of 8`}
          onChange={setPon}
          // Applied on release rather than on every drag step: each is a write, and the queue is
          // one write in flight by design -- a slider that fired per pixel would fill it. Through
          // `onPreview`, so the dialog stays open -- see `preview` in this file.
          onCommit={(v) => void onPreview(setContrast(v), 'display contrast')}
        />
        <Apply onClick={() => onApply(setContrast(pon), 'display contrast')} />
      </div>
    </Sheet>
  )
}

function Slider({
  label,
  hint,
  value,
  min,
  max,
  step,
  format,
  onChange,
  onCommit,
}: {
  label: string
  hint?: string
  value: number
  min: number
  max: number
  step: number
  format: (v: number) => string
  onChange: (v: number) => void
  onCommit?: (v: number) => void
}) {
  return (
    <div className="block space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-sm tabular-nums text-muted-foreground">{format(value)}</span>
      </div>
      {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
      {/* `onValueCommit` IS THE POINT of using the primitive here: it fires when the thumb is
          released, keyboard included, which is what "send this to the thermostat" must wait for.
          The raw range input had no such event, so this was a pointerup/keyup pair that a keyboard
          drag or a cancelled touch could each miss. */}
      <SliderControl
        min={min}
        max={max}
        step={step}
        value={[value]}
        onValueChange={([v]) => onChange(v!)}
        onValueCommit={([v]) => onCommit?.(v!)}
        aria-label={label}
        className="py-4"
      />
    </div>
  )
}

function Check({
  label,
  on,
  onChange,
}: {
  label: string
  on: boolean
  onChange: () => void
}) {
  const id = useId()
  return (
    <div className="flex min-h-11 items-center gap-3">
      <Checkbox id={id} checked={on} onCheckedChange={onChange} />
      <Label htmlFor={id} className="text-sm font-normal">
        {label}
      </Label>
    </div>
  )
}

function Apply({ onClick }: { onClick: () => void }) {
  return (
    <Button size="lg" className="w-full" onClick={onClick}>
      Send to the thermostat
    </Button>
  )
}
