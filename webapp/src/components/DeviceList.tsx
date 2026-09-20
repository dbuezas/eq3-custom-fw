import { useAtomValue, useSetAtom, useStore } from 'jotai'
import {
  Bluetooth,
  Download,
  Info,
  KeyRound,
  Loader2,
  Plus,
  Radio,
  Trash2,
  TriangleAlert,
  Upload,
} from 'lucide-react'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'

import { log } from '@/state/log'
import { AdvertDiagnostics } from '@/components/AdvertDiagnostics'
import { LinkButton } from '@/components/LinkButton'
import { LogStrip } from '@/components/LogStrip'
import { HintCard } from '@/components/HintCard'
import { InstallHint } from '@/components/InstallHint'
import { ENABLE_HINT, SUPPORTED, resetDevice } from '@/device/advert'
import { KEY_CHARS, cleanKey, spellsClear } from '@/device/access'
import {
  REOPEN_HINT,
  connect,
  connectTo,
  disconnect,
  settledRow,
  unsavedLinkAtom,
} from '@/device/link'
import { useChooseFor } from '@/device/useChooseFor'
import { TEST_MODE } from '@/device/testMode'
import { describeValues } from '@/device/readings'
import { ageTint, signalTint } from '@/lib/tint'
import { cn } from '@/lib/utils'
import {
  advertFor,
  grantedAtom,
  grantedSettledAtom,
  linkFor,
  openIdAtom,
  openUnsavedAtom,
  registryAtom,
} from '@/state/atoms'
import { registry, type Thermostat } from '@/state/registry'

import { Sheet } from './Sheet'
import { Alert, AlertDescription } from './ui/alert'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Card, CardContent } from './ui/card'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { Skeleton } from './ui/skeleton'
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group'

/**
 * THE FRONT DOOR — every saved thermostat, and nothing else on the screen `[owner]`.
 *
 * It covers the app until one is picked, and it is the ONLY view that works with no connection at
 * all: each row is that thermostat's own broadcast, aired about once a second whether or not
 * anybody is linked. So a person reads every radiator in the flat without connecting to any of
 * them, which is the whole reason this is the first screen rather than a menu.
 *
 * **A row that has stopped updating is STALE, never "offline".** Out of range, switched off, and a
 * browser that has stopped delivering adverts because the tab lost focus are indistinguishable from
 * here — so the row says how long ago it last spoke and leaves the conclusion to the person.
 */
export function DeviceList() {
  const devices = useAtomValue(registryAtom)
  const granted = useAtomValue(grantedAtom)
  const grantedSettled = useAtomValue(grantedSettledAtom)
  const openId = useSetAtom(openIdAtom)
  // The chooser flow is shared with the bar inside a thermostat and with the could-not-open dialog
  // — see `device/useChooseFor.ts` for why all three are the same thing.
  const chooseFor = useChooseFor()
  const openUnsaved = useSetAtom(openUnsavedAtom)
  // **A LIVE LINK WITH NO ROW, which is precisely the Add that connected and could not be saved.**
  // Not "is the SCREEN's thermostat linked" — on the list there is no such thermostat, so that
  // question would hide the way in to a device sitting in its updater exactly when it is needed.
  const linkUp = useAtomValue(unsavedLinkAtom) !== null
  // Read inside a press, never during a render — see `link` below for what it is for.
  const store = useStore()
  const file = useRef<HTMLInputElement>(null)
  // WHICH ROW IS BEING EDITED, and how — one at a time, which is why it is here rather than in each
  // row: a row's own menu opens its key or its forget confirmation, and two open at once is a state
  // that should not exist.
  const [edit, setEdit] = useState<RowEdit>(null)
  /** A thermostat is being added: the chooser is open, or the connection that follows it is running. */
  const [adding, setAdding] = useState(false)
  /**
   * Why the last Add did not work, or null. **It outlives the attempt on purpose**: the attempt
   * ending is exactly the moment the row would otherwise vanish — see `PendingRow`.
   */
  const [addFailed, setAddFailed] = useState<string | null>(null)
  /** The thermostat whose grant is being explained, before the browser's chooser opens for it. */
  const [granting, setGranting] = useState<Thermostat | null>(null)
  // The rows carry an AGE, and an age that only updates when something else re-renders is a lie
  // that reads as a frozen list.
  //
  // ONE SECOND, because the interval has to be finer than the fastest thing it draws — and that is
  // the tint, which turns red at five seconds, not the coarsest unit of the text beside it.
  //
  // IT IS THE CLOCK ITSELF IN STATE, not a counter that forces a re-render while each row reads
  // `Date.now()` during it. A render that reads the clock gives a different answer depending on
  // when React happened to run it; passing the tick down means every row on one pass agrees about
  // what time it is, which is also what makes the colours across the list comparable.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  /**
   * Open a saved thermostat. **The tap NAVIGATES; connecting is `useRouteLink`'s job** — and it must
   * not try as well: the arrival retries patiently for half a minute, so a tap that connected too
   * raced it and won, putting a list of identical `CC-RT-BLE` names in front of somebody who had
   * already picked one `[manually verified]` `[owner]`.
   *
   * **AND THE BROWSER'S DEVICE CHOOSER NEVER OPENS BY ITSELF** `[owner]`. It is unavoidable for a
   * thermostat this browser has never been given — `requestDevice()` is the only call that can grant
   * one, and it cannot be asked for by address — but it arrives with no context, listing every
   * thermostat in range under the same name including ones that were never added. So it is preceded
   * by a sheet that says why it is about to appear and what to do with it.
   *
   * So the granted count is consulted only once it has SETTLED. The browser's first answer about
   * which devices it will hand back is unreliable — which is why `refreshGranted` is retried at boot
   * and twice after it — so a raw count cannot tell "never granted" from "not answered yet"; a count
   * the boot ask has stopped chasing can, and zero there means this browser will hand nothing back
   * however long anyone waits. `grantedSettledAtom` is where that is defined.
   */
  const open = (d: Thermostat) => {
    // TWO REASONS THE CHOOSER IS THE ONLY ROUTE, and both are knowable NOW rather than after a
    // doomed retry window: this row has no handle, or this browser is handing back nothing.
    //
    // **THE SECOND ASKS WHETHER THE COUNT HAS SETTLED, not merely what it is.** Testing for the
    // METHOD is not enough: measured on a phone with only the experimental-features flag on,
    // `getDevices` is a function and returns an empty list after every relaunch, so the tap
    // navigated into a long wait that could not succeed `[manually verified]`.
    if (!d.deviceId || (grantedSettled && granted === 0)) return setGranting(d)
    openId(d.id)
  }

  /**
   * Connect this row's thermostat, or hang up on it — WITHOUT LEAVING THE LIST `[owner]`.
   *
   * **It deliberately does not navigate.** Tapping the row opens the thermostat and that still
   * connects; this is the same thing on its own, so several radiators can be brought up and left up
   * while a person walks between them. Nothing hangs a link up except this button, the device and
   * closing the page.
   *
   * The state is read from the store rather than passed down, because it belongs to the ROW — the
   * row subscribes to it and repaints alone, which is the render granularity the family bought.
   * Reading it inside a press is not a render read, so it cannot go stale.
   *
   * **ANYTHING THAT IS NOT `disconnected` HANGS UP**, `waiting` included: a row that says
   * "Searching…" has to be stoppable, and `disconnect` cancels the attempt as well as the link.
   *
   * It tests the same two chooser-only reasons the tap does — see `open`.
   */
  const link = (d: Thermostat) => {
    if (store.get(linkFor(d.id)) !== 'disconnected') return disconnect(d.deviceId ?? d.id)
    // A BROWSER HANDLE IS WHAT TEST MODE DOES NOT NEED, and the usual machine for it has never been
    // granted one — the same exemption the arrival makes, or `?test=1` could not reach this button.
    if (!TEST_MODE && (!d.deviceId || (grantedSettled && granted === 0))) return setGranting(d)
    void connectTo(d.deviceId ?? d.id)
  }

  /**
   * Add a thermostat: one chooser click, and NOTHING ELSE TO ANSWER `[owner]`.
   *
   * The device names itself, so there is nothing to type about identity — `identify` asks it who it
   * is on connect and files the row; asking a person for a MAC or a serial would be asking for a
   * value they have no reason to know `[owner]`. The key is not asked for here either: the
   * connection probes the encrypted door, and only a thermostat that answers gets a key asked
   * about, by `components/KeyOffer.tsx`, from inside `open()`.
   *
   * **AND IT OPENS WHAT IT ADDED** `[owner]`. The chooser has been answered and the connection is
   * already up, so stopping on the list leaves somebody looking at a row they have to tap again to
   * use, one second after asking for exactly that thermostat. It is the same ending `chooseFor` has
   * for the same reason, and it is what puts the key question in front of the person who just added
   * the device rather than at some later visit.
   *
   * Called straight from the Add button, which is the user gesture `requestDevice()` needs.
   */
  const add = () => {
    setAdding(true)
    setAddFailed(null)
    return connect()
      .then(async (opened) => {
        // THE HANDLE THE CHOOSER JUST OPENED. Several thermostats can be connected at once, and
        // this one is not on screen yet, so "the open device" is the wrong question here.
        const row = await settledRow(opened)
        if (row) return openId(row.id)
        // CONNECTED, AND STILL NO ROW — the other way Add can look like it did nothing. A row is
        // filed from what the thermostat says about itself on connect (`link.ts`, `identify`): its
        // serial, which stock answers too, or its MAC. **A device that gives NEITHER is not a fault
        // and is not rare** — an STM8 sitting in its updater after an interrupted install answers
        // nothing at all, and is exactly the device somebody needs to reach, because the installer
        // can still rescue it. There is nothing to file it under, so it gets no row.
        fail(
          'It connected, but never said which thermostat it is, so there is nothing to save. That ' +
            'is what a thermostat does when its firmware install was interrupted — it can still be ' +
            'reinstalled, and it is also what ours does when its replies are not getting through.',
        )
      })
      .catch((e: unknown) => {
        const why = String(e instanceof Error ? e.message : e)
        // **CLOSING THE CHOOSER IS NOT A FAILURE, and must not leave a red row behind** — it is
        // somebody changing their mind, and the answer to it is the list they already have. Matched
        // on the message rather than on `NotFoundError`, which Chrome also throws when the chooser
        // genuinely found nothing; if the wording ever changes, this stops matching and the cancel
        // shows as an error row, which is the harmless direction to be wrong in.
        if (/cancel/i.test(why)) return log(why)
        fail(why)
      })
      .finally(() => setAdding(false))
  }

  /**
   * Report an Add that did not work WHERE THE PERSON IS LOOKING `[owner]` — the pending row holds
   * the reason, and stays (see `PendingRow`). The log line is kept as well: the log is the history,
   * the row is only the latest one.
   */
  const fail = (why: string) => {
    log(why)
    setAddFailed(why)
  }

  const exportFile = () => {
    // THE FILE CARRIES THE KEYS AND THE PINs, deliberately [owner] — a backup without them restores
    // a registry that can decrypt nothing. The threat model is the neighbour, not an attacker.
    const url = URL.createObjectURL(
      new Blob([registry.exportJson()], { type: 'application/json' }),
    )
    const a = document.createElement('a')
    a.href = url
    a.download = 'thermostats.json'
    a.click()
    URL.revokeObjectURL(url)
    log(`exported ${devices.length} thermostat${devices.length === 1 ? '' : 's'}`)
  }

  const importFile = async (f: File) => {
    try {
      log(`imported ${registry.importJson(await f.text())} thermostats`)
    } catch (e) {
      log(`that file could not be read: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return (
    <div className="mx-auto flex min-h-dvh max-w-2xl flex-col gap-4 px-4 py-5">
      <header className="flex items-baseline justify-between gap-3">
        <h1 className="text-xl font-semibold">Thermostats</h1>
        {/* THIS BUTTON IS THE GESTURE `requestDevice()` NEEDS, so it opens the browser's own list
            with nothing in between `[owner]`. A dialog here would spend the gesture and then have to
            ask for a second one, to say what the list is about to show anyway. */}
        <Button onClick={() => void add()}>
          <Plus /> Add
        </Button>
      </header>

      {/* WHAT THE APP LAST DID, DIRECTLY UNDER THE HEADER `[owner]`. It has to be on this screen at
          all because a Web Bluetooth failure is silent — no navigator.bluetooth, a chooser
          dismissed, a device that never answers — and this is the screen those happen on.

          **THE SAME STRIP AS INSIDE A THERMOSTAT, not a second reader of the same log** `[owner]`.
          Two renderers of one log is two places to change and two things a person has to learn, and
          the foot of the page is where a message goes to be missed — the app answers at the top,
          where the thing that provoked it is. */}
      <LogStrip />

      {!SUPPORTED && <HintCard hint={ENABLE_HINT} />}

      {/* THE ONE THING THAT MAKES A SAVED LIST WORTH HAVING, and the condition is the RESULT rather
          than the method. Chrome offers `getDevices()` with the permissions flag off and returns an
          empty list, so testing for the method reported "available" on a browser that could never
          hand the page a device — measured on a phone `[manually verified]`. Zero granted is the
          state to report. Only shown once something is saved: before that, the chooser is the right
          answer anyway.

          NO BUTTON OF ITS OWN — it names `Add`, which is in the header above it. The hint's own
          comment in `link.ts` says why. */}
      {devices.length > 0 && granted === 0 && <HintCard hint={REOPEN_HINT} />}

      {devices.length === 0 && !adding && !addFailed ? (
        // NO BUTTON HERE `[owner]`. "Add" is in the header, two centimetres above, and a second
        // one that does the same thing is a choice the reader has to make for no reason.
        <Card className="border-dashed p-6 text-center">
          <CardContent className="px-0">
            <Bluetooth className="mx-auto size-7 text-muted-foreground" />
            <h2 className="mt-3 text-base font-medium">No thermostats yet</h2>
            <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
              Add one with the button above and it stays here: its readings show on this screen
              without connecting, and opening it later takes one tap instead of a Bluetooth search.
            </p>
            <p className="mt-4 text-xs text-muted-foreground">
              Moved from another phone or address? Import the file you exported there.
            </p>
          </CardContent>
        </Card>
      ) : (
        <ul className="space-y-3">
          {/* THE ROW APPEARS THE MOMENT ADDING STARTS `[owner]`. Adding takes the chooser, then a
              connection, then a command that asks the thermostat its own address — several seconds
              during which the page showed nothing at all and the empty state was still on screen,
              so it read as a button that had done nothing. It sits FIRST because a new thermostat
              has no name to sort by yet. */}
          {(adding || addFailed) && (
            <PendingRow
              error={adding ? null : addFailed}
              onRetry={() => void add()}
              onDismiss={() => setAddFailed(null)}
              // THE LINK IS THE CONDITION, not the kind of failure: whatever went wrong, if there is
              // still a thermostat on the other end then the installer can reach it.
              onOpenAnyway={
                linkUp
                  ? () => {
                      setAddFailed(null)
                      openUnsaved()
                    }
                  : undefined
              }
            />
          )}
          {devices.map((d) => (
            <DeviceRow
              key={d.id}
              device={d}
              now={now}
              edit={edit?.id === d.id ? edit.kind : null}
              setEdit={(kind) => setEdit(kind ? { id: d.id, kind } : null)}
              onOpen={() => open(d)}
              onLink={() => link(d)}
            />
          ))}
        </ul>
      )}

      {/* NOT GATED ON HAVING A THERMOSTAT. A browser that can never hand this page a device is
          exactly the case to diagnose BEFORE the first one is added, and at a fresh address the
          list is empty by definition. (Import is ungated for the same reason: it IS the way a
          second address, a second phone or a reinstalled browser gets its thermostats back.
          Per-origin isolation is accepted rather than worked around `[owner]`.) */}
      <AdvertDiagnostics />

      {/* BELOW THE THERMOSTATS, not above them `[owner]`. Installing is worth offering, but it is
          not what somebody opened the page to do. It is always here — see the component, which says
          why waiting for the browser to volunteer is not good enough — and it goes only once the
          app is running installed. */}
      <InstallHint />

      {granting && (
        <GrantExplain
          device={granting}
          // Unsettled counts as remembering: it is the ordinary case, it lasts a few seconds, and
          // the alternative is telling somebody their browser forgets while it is still answering.
          remembers={granted !== 0 || !grantedSettled}
          onClose={() => setGranting(null)}
          onGo={() => {
            const d = granting
            setGranting(null)
            void chooseFor(d)
          }}
        />
      )}

      <div className="mt-auto flex gap-2 pt-4">
        <Button
          variant="outline"
          className="flex-1 text-muted-foreground"
          onClick={() => file.current?.click()}
        >
          <Upload /> Import
        </Button>
        <Button
          variant="outline"
          className="flex-1 text-muted-foreground"
          onClick={exportFile}
          disabled={devices.length === 0}
        >
          <Download /> Export
        </Button>
        {/* THE ONE RAW INPUT LEFT IN THE APP, and deliberately: a file picker can only be opened
            by clicking a real `<input type="file">`, so it is hidden and the visible Import button
            clicks it. Styling it would be pointless — it is never seen. */}
        <input
          ref={file}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            e.target.value = '' // so choosing the SAME file twice fires the change event again
            if (f) void importFile(f)
          }}
        />
      </div>
    </div>
  )
}

/**
 * The row a thermostat gets before it has a name — the same shape it will keep, filled in.
 *
 * It is the SHAPE of the real row rather than a spinner: what is being waited for is a row
 * appearing in this list, so the honest way to say "it is coming" is to show where it will be.
 *
 * **AND IT IS WHERE A FAILED ADD IS REPORTED, because it is where the person is looking** `[owner]`.
 * It stays put on failure and holds the reason: a row that vanished answered "did that work?" with a
 * thermostat that had been there a second ago and was now gone, which made every different failure
 * look identical — a button that did nothing.
 *
 * Try again and Dismiss, and no third option: the only two things to do about it are to have another
 * go or to stop. Try again re-opens the browser's chooser, which is why it must be a BUTTON — a
 * retry on a timer could not, since `requestDevice()` needs a live user gesture.
 */
function PendingRow({
  error,
  onRetry,
  onDismiss,
  onOpenAnyway,
}: {
  error: string | null
  onRetry: () => void
  onDismiss: () => void
  /** Absent unless a link is still open — see the button. */
  onOpenAnyway?: () => void
}) {
  return (
    <li>
      <Card className={cn('gap-0 overflow-hidden p-0', error && 'border-warn/50')}>
        <div className="flex items-center gap-2 px-4 pt-3">
          {error ? (
            <TriangleAlert className="size-4 shrink-0 text-warn" />
          ) : (
            <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
          )}
          <span className="text-sm font-medium">
            {error ? 'That thermostat was not added' : 'Adding a thermostat…'}
          </span>
        </div>
        {/* THE SKELETON GOES WHEN THE WAITING DOES. It stands for a row that is on its way, and
            leaving it under a failure promises one that is not coming. */}
        {!error && (
          <div className="space-y-2 px-4 py-3">
            <Skeleton className="h-8 w-20" />
            <div className="flex gap-1">
              <Skeleton className="h-5 w-24" />
              <Skeleton className="h-5 w-20" />
              <Skeleton className="h-5 w-16" />
            </div>
          </div>
        )}
        {error ? (
          <div className="space-y-3 border-t px-4 py-3">
            <p className="text-xs text-muted-foreground">{error}</p>
            {/* TRY AGAIN IS THE WHOLE CHOOSER AGAIN, not a reconnect: `requestDevice()` needs a
                live user gesture, and this press is one. */}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={onRetry}>
                Try again
              </Button>
              {/* **ONLY WHEN THE LINK IS ACTUALLY UP** — which is the failure worth a door rather
                  than a retry: it connected and said nothing, so retrying gets the same silence.
                  That is what an interrupted firmware install leaves, and the installer is what
                  rescues it. Absent otherwise, because there would be nothing on the other side. */}
              {onOpenAnyway && (
                <Button size="sm" variant="outline" onClick={onOpenAnyway}>
                  Open it anyway
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={onDismiss}>
                Dismiss
              </Button>
            </div>
          </div>
        ) : (
          <p className="border-t px-4 py-2 text-xs text-muted-foreground">
            Pick it in the Bluetooth list, then wait — it is asked for its own address, which is what
            names the row.
          </p>
        )}
      </Card>
    </li>
  )
}

/**
 * How long ago, in the coarsest unit that is still true. `now` is passed in rather than read here —
 * see the list's ticking clock.
 */
function ago(at: number, now: number): string {
  const s = Math.round((now - at) / 1000)
  if (s < 90) return `${s}s ago`
  const m = Math.round(s / 60)
  return m < 90 ? `${m} min ago` : `${Math.round(m / 60)} h ago`
}

/** Which of a row's three sheets is open, and on which thermostat. One at a time, list-wide. */
type RowEdit = { id: string; kind: 'key' | 'forget' | 'info' } | null

function DeviceRow({
  device,
  now,
  edit,
  setEdit,
  onOpen,
  onLink,
}: {
  device: Thermostat
  /** The list's ticking clock, so every row on one render pass agrees what time it is. */
  now: number
  edit: 'key' | 'forget' | 'info' | null
  setEdit: (kind: 'key' | 'forget' | 'info' | null) => void
  onOpen: () => void
  /** Connect this row's thermostat, or hang up on it. See the button at the foot of the row. */
  onLink: () => void
}) {
  // THIS ROW'S OWN LINK AND ITS OWN BROADCAST, both keyed by row `id` — never by an address: an
  // `id` is the thermostat's serial when it reports one and its MAC only when it does not (see
  // `state/registry.ts`). `state/atoms.ts` owns the handle-to-row join both families make, and the
  // reason they are families: the row that is connecting repaints and the others do not.
  const state = useAtomValue(linkFor(device.id))
  const report = useAtomValue(advertFor(device.id))
  // EVERYTHING THE BROADCAST CARRIES, AS BADGES, in the broadcast's own order and with nothing
  // lifted out `[owner]` — the target temperature included, beside the current one, so the pair is
  // read together. No reading is repeated anywhere else in the row.
  const readings = describeValues(report.values)

  return (
    <li>
     <Card className="gap-0 overflow-hidden p-0">
      {/* THE ROW IS ALWAYS ITSELF `[owner]`. Both editors are dialogs OVER the page, never a form
          that replaces the row — the same shape whether they change a key or destroy the row. An
          editor in the row makes the thing being edited disappear while you edit it, and the list
          jump under your thumb. */}
      <>
          {/* THE NAME IS THE THERMOSTAT'S OWN, so there is nothing to edit here `[owner]` — it is
              set on the Install tab, `Bluetooth name`, and `AccessSettings`'s `NameSheet` says why
              there is only the one. */}
          <div className="flex items-center gap-1 px-2 pt-1">
            <Button
              variant="ghost"
              onClick={onOpen}
              className="h-auto min-w-0 flex-1 justify-start gap-2 px-2 py-1.5 text-left"
            >
              {/* ONE STEP UP FROM THE BUTTON'S OWN `text-sm` — the name is what a person is
                  looking for when they scan the list, so it should not be the same size as the
                  labels on the badges under it. `text-base` and no larger, because its line box
                  plus the button's padding then comes to exactly the 36 px of the two controls
                  beside it; anything taller makes every row in the list taller. */}
              <span className="truncate text-base font-medium">{device.name}</span>
            </Button>

            {/* WHICH THERMOSTAT THIS ACTUALLY IS, ONE TAP AWAY `[owner]`. Two of them can be given
                the SAME name, by accident or because somebody renamed the wrong one, so the name
                alone cannot tell them apart — but the serial and the MAC are long strings of
                characters that are read perhaps twice in a thermostat's life, and printed in every
                row they crowd out the readings, which are read every time. So they live behind
                this button instead of in the row.

                It does NOT navigate, unlike the name beside it. */}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Which thermostat ${device.name} is`}
              onClick={() => setEdit('info')}
              className="shrink-0 text-muted-foreground"
            >
              <Info className="size-4" />
            </Button>

            {/* **CONNECTING IS A ROW'S OWN BUTTON, TOP RIGHT** `[owner]`. Links are plural
                and they survive walking back to the list, so this says what that row's link is
                doing and is the one place that ends it — "turn the heating up in two rooms" is two
                links held at once, not two visits.

                IT SITS BESIDE THE NAME, NOT IN THE ACTION BAR BELOW `[owner]`. Whether a thermostat
                is connected is the first thing about it, not a third action after the key and
                Forget — and the bar's own Connect is top right on the screen this row opens, so
                the control is in the same corner on both.

                It does NOT navigate. Tapping the row still opens the thermostat, and opening one
                still connects it; this is the half of that which can be done from here. */}
            <LinkButton state={state} onClick={onLink} />
          </div>

          <Button
            variant="ghost"
            size="row"
            onClick={onOpen}
            className="flex-col items-stretch pt-0"
          >
            <div className="flex items-baseline justify-end gap-3">
              {/* HOW WELL IT IS HEARD, BESIDE HOW LONG AGO `[owner]` — the two halves of the same
                  question. A row that has gone quiet and a row that is merely far away look the
                  same without the signal, and the answer to them is not the same. */}
              <span className="flex shrink-0 items-baseline gap-2 text-xs font-normal text-muted-foreground">
                {/* TINTED, NOT JUST PRINTED `[owner]`. Both numbers answer "is it really there",
                    and a person scanning a list of thermostats reads a colour before they read a
                    figure — the number stays for whoever wants the detail. The ramp and its
                    thresholds are in `lib/tint.ts`; the inline style is because the colour is
                    continuous and a class cannot be. */}
                {report.rssi !== null && (
                  <span className="tabular-nums" style={{ color: signalTint(report.rssi) }}>
                    {report.rssi} dBm
                  </span>
                )}
                {report.lastAt !== null ? (
                  <span
                    className="tabular-nums"
                    style={{ color: ageTint((now - report.lastAt) / 1000) }}
                  >
                    {ago(report.lastAt, now)}
                  </span>
                ) : (
                  <span className="flex items-center gap-1">
                    <Radio className="size-3" /> nothing heard yet
                  </span>
                )}
              </span>
            </div>

            {/* EACH READING IS A BADGE `[owner]`. Run together as text they read as one sentence
                and it is not obvious where one property ends and the next begins — which matters
                most here, where every value is two words long. */}
            <div className="mt-1.5 flex flex-wrap items-center gap-1">
              {readings.map((r) => (
                <Badge key={r.key} variant="secondary" className="gap-1 font-normal">
                  <span className="text-muted-foreground">{r.label}</span>
                  <span className="font-medium tabular-nums">{r.text}</span>
                </Badge>
              ))}
              {/* HEARD, AND SAYING NOTHING — which is a state, not a gap. With the BThome broadcast
                  switched off the thermostat still advertises and is still connectable, it just
                  carries no readings, so the row goes blank while the age beside it keeps counting.
                  Without this line that reads as an app that stopped working. */}
              {report.count > 0 && !report.sensorData && (
                <Badge variant="outline" className="font-normal text-muted-foreground">
                  broadcast off
                </Badge>
              )}
              {/* THE TWO OBJECT SETS ALTERNATE, so half of these are legitimately absent for the
                  first second after a watch starts. Saying so stops a half-filled row reading as a
                  thermostat that only sends half its readings. It is gated on there being a
                  broadcast at all: with none, no second half is coming and the badge above is the
                  true one. */}
              {report.count > 0 && report.sensorData && report.setsSeen < 2 && (
                <Badge variant="outline" className="font-normal text-muted-foreground">
                  waiting for the other half
                </Badge>
              )}
              {/* THREE STATES, AND ONLY TWO OF THEM ARE FAULTS `[owner]`. What matters is whether
                  the BROADCAST is sealed: if it is and we cannot open it, the readings are
                  unreachable and that is worth red. If it is not, "no key" is a plain fact about a
                  thermostat — most have none, the readings arrive in the clear, nothing is wrong. */}
              {report.encrypted && report.needsKey ? (
                <Badge variant="outline" className="border-warn/40 font-normal text-warn">
                  {device.key ? 'wrong key' : 'missing key'}
                </Badge>
              ) : (
                !device.key && (
                  <Badge variant="outline" className="font-normal text-muted-foreground">
                    no key
                  </Badge>
                )
              )}
              {!device.deviceId && (
                <Badge variant="outline" className="font-normal text-muted-foreground">
                  not granted to this page
                </Badge>
              )}
            </div>
          </Button>
      </>

      {edit === 'info' && <IdentitySheet device={device} onDone={() => setEdit(null)} />}

      {edit === 'key' && (
        <KeyForm
          device={device}
          mismatch={report.needsKey && !!device.key}
          onDone={() => setEdit(null)}
        />
      )}

      {edit === 'forget' && <ForgetConfirm device={device} onDone={() => setEdit(null)} />}

      {/* OUTLINED, NOT GHOST. These read as links until you press them, and one of them destroys
          the row — a control that does not look like a control is the defect that put a thermostat
          behind its pairing gate by accident `[owner]`. */}
      <div className="flex items-center gap-2 border-t px-3 py-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setEdit('key')}
          className={cn(report.needsKey && device.key && 'border-warn/40 text-warn')}
        >
          <KeyRound />
          {/* **IT DOES NOT ADD A KEY TO ANYTHING** `[owner]`. It tells THIS BROWSER a key the
              thermostat already holds, so the broadcast can be decrypted; putting a key ON the
              device is the Install tab's row, on the other side of a connection.

              ONE word, not a state: the row's condition is already said twice, by the `wrong key` /
              `missing key` badge above and by this button's warning tint. */}
          Encryption
        </Button>
        {/* THE DANGER VARIANT, because it deletes `[owner]`. A `hover:` style is grey always on a
            phone, and this is the one control on the row that removes a key the thermostat will
            never tell you again. */}
        <Button
          variant="destructive"
          size="sm"
          onClick={() => setEdit('forget')}
          className="ml-auto"
        >
          <Trash2 /> Forget
        </Button>
      </div>
     </Card>
    </li>
  )
}

/** One labelled field with Save and Cancel. `KeyForm` is its only caller. */
function FieldForm({
  title,
  label,
  initial,
  placeholder,
  hint,
  mono,
  clean,
  max,
  autoFocus = true,
  clearable,
  valid,
  invalid,
  extra,
  onSave,
  onCancel,
}: {
  /** The dialog's heading. */
  title: string
  label: string
  initial: string
  placeholder?: string
  hint?: ReactNode
  mono?: boolean
  /** Applied to every keystroke and every paste, so the field can never hold an invalid value. */
  clean?: (raw: string) => string
  /** With `clean`, this also draws a `n / max` counter, which is the whole validation message. */
  max?: number
  /** Whether the keyboard opens on its own. See `KeyForm`, which turns it off and says why. */
  autoFocus?: boolean
  /** Offers a Clear button, which empties the FIELD and nothing else — saving is still a separate act. */
  clearable?: boolean
  /**
   * Whether what is in the field may be saved. Save is disabled when it is not.
   *
   * Preferred to reporting the mistake after the press: the counter beside the field already shows
   * how far off the length is, so a disabled button says "not yet" at the moment it is true rather
   * than an error message saying "not that" a moment later.
   */
  valid?: (v: string) => boolean
  /**
   * Why what is in the field may not be saved, when a disabled button is not enough on its own.
   *
   * The counter says a length is wrong and says it continuously, so most invalidity needs no
   * sentence. A value that is the RIGHT length and still refused has nothing to show for it — the
   * button simply does not work — and an all-zero key is exactly that: 32 of 32, in the ok colour,
   * and rejected. Returns null when there is nothing to say.
   */
  invalid?: (v: string) => string | null
  /**
   * Anything else this form asks about, below the hint and above the buttons.
   *
   * It is the caller's own state, saved by the caller's own `onSave` — this component knows about one
   * field and should not learn about a second. **It is given the field's CURRENT value**, because
   * what else the form may offer can depend on it: the key form's channel choice is not available
   * until a key has been typed, and must become unavailable again the moment one is deleted.
   */
  extra?: (value: string) => ReactNode
  onSave: (v: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState(initial)
  // A stable id per instance, so the label points at THIS row's field and not at another row's.
  const id = useId()
  // THE SHEET IS TOLD TOO, not just the field: the dialog primitive focuses its first tabbable child
  // when it opens, which overrules the field's own `autoFocus={false}` and brings the keyboard up
  // anyway.
  return (
    <Sheet title={title} onClose={onCancel} autoFocus={autoFocus}>
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        onSave(value)
      }}
    >
      <div className="flex items-baseline justify-between">
        <Label htmlFor={id} className="text-xs text-muted-foreground">
          {label}
        </Label>
        {max !== undefined && (
          <span
            className={cn(
              'text-xs tabular-nums',
              value.length === max ? 'text-ok' : 'text-muted-foreground',
            )}
          >
            {value.length} / {max}
          </span>
        )}
      </div>
      <div className="flex gap-2">
        <Input
          id={id}
          value={value}
          autoFocus={autoFocus}
          placeholder={placeholder}
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          maxLength={max}
          onChange={(e) => setValue(clean ? clean(e.target.value) : e.target.value)}
          className={cn('min-w-0 flex-1', mono && 'font-mono tracking-wider')}
        />
      </div>
      {invalid?.(value) && <p className="text-xs text-warn">{invalid(value)}</p>}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {extra?.(value)}
      <div className="flex gap-2 pt-1">
        {/* DISABLED RATHER THAN REFUSING AFTERWARDS — see `valid`. A form whose only submit button is
            disabled also cannot be submitted by pressing Enter in the field, so this is the whole
            gate rather than half of one. */}
        <Button type="submit" disabled={valid ? !valid(value) : false}>
          Save
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        {/* LAST, AND ONLY WHERE IT IS OFFERED. It empties the field; Save is what commits that, which
            is why it does not sit beside Cancel as though it were another way out. */}
        {clearable && (
          <Button
            type="button"
            variant="ghost"
            className="ml-auto"
            disabled={!value}
            onClick={() => setValue('')}
          >
            Clear
          </Button>
        )}
      </div>
    </form>
    </Sheet>
  )
}

/**
 * The thermostat's encryption key, as THIS APP has it.
 *
 * IT IS SHOWN, NOT HIDDEN `[owner]`. It is the person's own key in their own list, and they need to
 * read it back — to type into Home Assistant, or into this app at another address. The device will
 * never reveal its own; the threat model here is the neighbour, not somebody holding the phone.
 *
 * Saving it here tells the APP what a thermostat already uses. It does not write anything to the
 * device — that is `cmd 0x51` (set the key the thermostat itself holds), on the Install tab's
 * `KeySheet`.
 */
function KeyForm({
  device,
  mismatch,
  onDone,
}: {
  device: Thermostat
  /** Sealed broadcasts are arriving and the stored key does not open them. */
  mismatch: boolean
  onDone: () => void
}) {
  // The SAME default `channelFor` uses, so opening this form shows what the app is already doing
  // rather than a third answer. Writing it only on Save is what keeps "not chosen" a real state.
  const [channel, setChannel] = useState<'sealed' | 'plain'>(
    device.channel ?? (device.key ? 'sealed' : 'plain'),
  )
  return (
    <FieldForm
      title={`Encryption key for ${device.name}`}
      label="Key, if this thermostat has one"
      initial={device.key ?? ''}
      // THE ALPHABET, LIKE THE OTHER KEY FIELD — the label above already says a key is optional.
      placeholder="0-9 a-f"
      mono
      // NOT FOCUSED ON OPEN `[owner]`: this form opens by itself when a thermostat is added, and most
      // thermostats have no key — so a keyboard covering half the screen would be the app demanding
      // an answer whose usual answer is nothing.
      autoFocus={false}
      clearable
      // EMPTY OR A WHOLE KEY, and nothing between. A short one is not a key at all: it would be
      // padded into a plausible sixteen bytes and seal every command with the wrong material, which
      // the thermostat drops silently — so it presents as a device that stopped answering.
      //
      // AND NOT ALL ZEROS, which is how "no key" is spelled on the wire (`access.ts`,
      // `spellsClear`). Stored here it would seal every command under sixteen zeros — a key no
      // thermostat holds — with the same silent result. Leaving the field EMPTY is how "it has
      // none" is said, and the hint below says so.
      valid={(k) => k.length === 0 || (k.length === KEY_CHARS && !spellsClear(k))}
      // Only once the field is full: every prefix of an all-zero key is all zeros too, so saying it
      // from the first `0` would be about the eventual value rather than this one.
      invalid={(k) => (k.length === KEY_CHARS && spellsClear(k) ? 'Can’t be all zeroes' : null)}
      hint={
        // A MISMATCH IS STATED, because it is the one fault here a person can fix and it looks
        // identical to silence otherwise.
        //
        // **"NO KEY" IS A REAL ANSWER, AND THE LABEL IS THE ONE PLACE IT IS SAID** `[owner]`. This
        // form opens by itself when a thermostat is added, so it reads as a step that must be
        // completed — and most thermostats have no key at all. The buttons stay Save and Cancel
        // like every other form here: a cancel dressed up as an answer ("Don't use a key") only
        // reads that way to somebody who already knew what a key was.
        //
        // THE KEY IS ALSO AN ADMISSION TICKET, not only a seal on the readings `[manually verified]`.
        // It opens a second command channel that the pairing PIN does not cover, so a phone holding
        // the key can drive a thermostat it has never paired with — measured, on a connection that
        // never paired (`../../../PROTOCOL.md`, "Sending a command encrypted").
        mismatch
          ? 'This thermostat is broadcasting sealed readings and the key above does not open them. ' +
            'Put in the key it was given.'
          : 'The key encrypts the BThome broadcast and allows a secure pairing-free connection even ' +
            'when a pairing PIN is switched on on the main channel.'
      }
      // FROM THE FIELD, NOT FROM THE STORED ROW: deleting the key has to take the encrypted channel
      // away in the same keystroke, not at the next save.
      extra={(k) => (
        <ChannelChoice value={channel} hasKey={k.length === KEY_CHARS} onChange={setChannel} />
      )}
      clean={cleanKey}
      max={KEY_CHARS}
      onCancel={onDone}
      onSave={(k) => {
        // NOTHING TO VALIDATE HERE: `cleanKey` drops anything a key cannot contain, and `valid`
        // above stops a short one being submitted at all.
        //
        // NO KEY MEANS NO CHOICE TO STORE `[owner]`. The encrypted channel is not selectable without
        // one, so a row that ends up keyless is stored as using the paired channel rather than
        // keeping a preference it cannot act on.
        // ...and ONLY those two fields: spreading the row would republish the name this form
        // captured when it opened, undoing a rename made since. See `registry.upsert`.
        registry.upsert({ id: device.id, key: k || undefined, channel: k ? channel : 'plain' })
        // What was accumulated was decoded with the OLD key, or not at all — drop it so the next
        // broadcast rebuilds the row rather than mixing two vintages with nothing marking which.
        if (device.deviceId) resetDevice(device.deviceId)
        onDone()
      }}
    />
  )
}

/**
 * What the browser's own device list is, said BEFORE it appears `[owner]`.
 *
 * **THE CHOOSER CANNOT BE AVOIDED HERE and it cannot be aimed.** `requestDevice()` is the only call
 * that can grant a page a device — there is no way to ask for one by address — so a thermostat this
 * browser has never been given can be reached no other way. What arrives is a list of every
 * thermostat in range, all advertising the same `CC-RT-BLE`, including ones that were never added to
 * this app. Landing on that with no warning is the complaint this exists to answer: it looked like
 * the app asking to pair, at a moment nothing had asked for anything.
 *
 * So it says the three things a person needs before it opens: why it is happening, that the names
 * will all look the same, and that a wrong pick is recoverable — the thermostat reports its own
 * address on connect, so the app can say afterwards which one was actually picked, and opens that one
 * rather than the page for the row that was tapped.
 *
 * **IT IS ONCE PER THERMOSTAT PER BROWSER**, which is worth saying too: the reason the list is full
 * of rows that never do this is that they have already been granted.
 */
function GrantExplain({
  device,
  remembers,
  onClose,
  onGo,
}: {
  device: Thermostat
  /**
   * Whether a grant made here will still be there after a reload — which decides both halves of the
   * wording below, and is a RESULT rather than a capability. A browser that offers `getDevices()`
   * and answers it with an empty list every time keeps nothing, so the promise "once only" has to be
   * driven by what came back, not by whether the method exists.
   */
  remembers: boolean
  onClose: () => void
  onGo: () => void
}) {
  return (
    <Sheet title={`Let this browser use ${device.name}`} onClose={onClose}>
      <div className="space-y-3 text-sm">
        {/* TWO REASONS LAND HERE and they need different words. One is about this thermostat and is
            over after today; the other is about this BROWSER and happens every single time, which is
            worth saying plainly rather than letting somebody think the app keeps forgetting. */}
        {remembers ? (
          <p>
            This browser has never been given <strong>{device.name}</strong> — it was added on
            another phone, or imported from a file. Bluetooth in a browser has to be handed each
            thermostat once, and it cannot be done by address, so the next step is the
            browser&rsquo;s own list.
          </p>
        ) : (
          <p>
            This browser cannot hand a saved thermostat back to a page, so{' '}
            <strong>{device.name}</strong> has to be picked from its own list every time. The
            banner above the list says which setting changes that.
          </p>
        )}
        <Alert>
          <AlertDescription>
            <strong>Every thermostat is called CC-RT-BLE there</strong>, including any nearby that are
            not in this app — so there is nothing to tell them apart by. Pick one; if it turns out to
            be a different thermostat, this app says so and opens the one you actually picked, and you
            can come back and try another.
          </AlertDescription>
        </Alert>
        {/* AND THE PROMISE HAS TO MATCH THE REASON. "Once only" is true where the browser keeps the
            permission and a lie where it does not — which is exactly the browser that would meet
            this sheet most often. */}
        <p className="text-muted-foreground">
          {remembers
            ? `Once only. After this, ${device.name} opens straight from the list.`
            : `This will happen every time until that setting is on.`}
        </p>
        <div className="flex gap-2 pt-1">
          <Button onClick={onGo}>Show the list</Button>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Sheet>
  )
}

/**
 * Which of the thermostat's two command channels this app should use.
 *
 * **BOTH DOORS ARE OPEN ON OUR FIRMWARE, so this is a CHOICE and not a consequence** `[owner]`. The
 * app picks a sensible default — encrypted when a key is stored, the paired one otherwise — and this
 * overrides it in either direction, including the combination the default will never produce: a key
 * stored and the paired door used anyway. That is the case worth having, because when something is
 * wrong the two are not interchangeable, and the reasons to prefer one are things the app cannot see.
 * A key the thermostat does not actually hold looks exactly like a thermostat that stopped answering.
 *
 * **WITHOUT A KEY THERE IS NOTHING TO CHOOSE, so the encrypted option is not offered** `[owner]`.
 * Nothing could arm anyway, so the choice would sit on the row describing something the app cannot
 * do — and a button that silently does nothing when pressed is worse than one plainly unavailable.
 */
function ChannelChoice({
  value,
  hasKey,
  onChange,
}: {
  value: 'sealed' | 'plain'
  /** A COMPLETE key is in the field. Half a key is no key, so this stays shut until it is whole. */
  hasKey: boolean
  onChange: (v: 'sealed' | 'plain') => void
}) {
  // The effective answer, which without a key is the paired channel whatever the row remembers.
  const shown = hasKey ? value : 'plain'
  return (
    <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
      <p className="text-sm font-medium">Channel used for active connection</p>
      <ToggleGroup
        type="single"
        value={shown}
        // A toggle group can be cleared by re-pressing the active button; there is no "neither" here,
        // so an empty value is ignored rather than stored.
        onValueChange={(v: string) => (v === 'sealed' || v === 'plain' ? onChange(v) : undefined)}
        className="w-full"
      >
        <ToggleGroupItem value="sealed" disabled={!hasKey} className="flex-1">
          Encrypted
        </ToggleGroupItem>
        <ToggleGroupItem value="plain" className="flex-1">
          Paired
        </ToggleGroupItem>
      </ToggleGroup>
      {/* NOTHING IS SAID WHEN THERE IS NO KEY `[owner]`. The greyed-out button already says
          Encrypted needs one, and the line below would be worse than nothing on a keyless row,
          because "even though a key is set" is not true of it. */}
      {hasKey && (
        <p className="text-xs text-muted-foreground">
          {/* **THE EXCEPTION IS FLASHING, AND IT IS THE ONLY ONE** `[manually verified]`. Checked
              against the radio's own pass-list: everything this app sends goes sealed, the LCD
              mirror's `cmd 0x18` included. What a key cannot open is either firmware install —
              the thermostat's runs over the plain command characteristic, because a 16-byte chunk
              does not fit beside a sealed header, and the radio's over its own update attributes.
              The PIN gates both. (`0x52`/`0x53`/`0x54` are forced plaintext too, but they are the
              host-side recovery oracle and this app never sends them.) */}
          {shown === 'sealed'
            ? 'Commands go out encrypted with the key above, and no pairing is needed — except to install firmware.'
            : 'Use the paired channel even if an encryption key is set.'}
        </p>
      )}
    </div>
  )
}

/**
 * Forgetting removes a name, a key and a PIN that cannot be recovered from the thermostat — it only
 * ever takes those in — so it asks first, and says what actually goes.
 */
/**
 * The two identifiers that say which physical thermostat a row is.
 *
 * THE SERIAL IS THE ONE PRINTED ON THE DEVICE, so it is what a person standing at a radiator can
 * match; the MAC is what the host tools and the Home Assistant integration take. Both are labelled,
 * because one bare string of characters does not say which of the two it is.
 *
 * A DASH WHERE THE THERMOSTAT HAS NOT GIVEN ONE OF THEM. A row is keyed on whichever it did give
 * (`state/registry.ts`), so holding only one of the pair is a fact about that device rather than a
 * hole in this sheet.
 */
function IdentitySheet({ device, onDone }: { device: Thermostat; onDone: () => void }) {
  return (
    <Sheet title={device.name} description="Which thermostat this row is" onClose={onDone}>
      <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-2 text-sm">
        <dt className="text-muted-foreground">serial</dt>
        <dd className="font-mono break-all">{device.serial ?? '—'}</dd>
        <dt className="text-muted-foreground">mac</dt>
        <dd className="font-mono break-all">{device.mac ?? '—'}</dd>
      </dl>
    </Sheet>
  )
}

function ForgetConfirm({ device, onDone }: { device: Thermostat; onDone: () => void }) {
  const loses = device.key || device.pin
  return (
    <Sheet title={`Forget ${device.name}?`} onClose={onDone}>
      <div className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          {loses
            ? 'Its name and its key are removed from this browser, and the thermostat will not tell you them again.'
            : 'Its name is removed from this browser. The thermostat itself is untouched.'}
        </p>
        {loses && (
          <Alert variant="warn">
            <AlertDescription>
              Export first if you have no backup — the key cannot be read back off the thermostat.
            </AlertDescription>
          </Alert>
        )}
        <div className="flex gap-2 pt-1">
          <Button
            variant="destructive"
            onClick={() => {
              registry.forget(device.id)
              onDone()
            }}
          >
            Forget
          </Button>
          <Button variant="outline" onClick={onDone}>
            Cancel
          </Button>
        </div>
      </div>
    </Sheet>
  )
}
