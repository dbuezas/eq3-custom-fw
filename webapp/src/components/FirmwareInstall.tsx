import { useAtomValue } from 'jotai'
import { AlertTriangle, HardDriveDownload } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Sheet } from '@/components/Sheet'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  VERIFY_DROP_MEANS,
  catalogueUrl,
  checkImage,
  imageUrl,
  parseChunks,
  unhexPayload,
  type Chip,
} from '@/device/flash'
import { STAY_PUT, useFlashGuards } from '@/device/flashGuards'
import {
  radioFlashableAtom,
  chipVersionAtom,
  flashRadio,
  flashThermostat,
  fwVersionAtom,
  prepareForFlash,
  request,
} from '@/device/link'
import { BAD_TINT, GOOD_TINT, MID_TINT } from '@/lib/tint'
import { useGate } from '@/state/useGate'
import {
  GET_INFO,
  chipIs,
  chipNumber,
  isInfo,
  relText,
  releaseText,
  type ChipVersion,
} from '@/device/protocol'
import { log } from '@/state/log'
import { fwText } from '@/device/protocol'

/**
 * `W14` — pick a version, and take BOTH chips there in one connection.
 *
 * ================================================================================================
 * THIS IS THE ONE SCREEN THAT CAN DAMAGE SOMETHING, AND IT IS BUILT TO SAY SO
 * ================================================================================================
 * Every other control in this app writes a setting. This writes firmware to a radio chip that has no
 * reset line, so the honesty rules are stricter here than anywhere else:
 *
 * - **it never claims a duration it has not measured.** Progress is bytes done out of bytes total;
 *   every time it quotes comes from `BYTES_PER_SEC`, which is a measurement, and once a leg is
 *   under way from what that leg is actually achieving. The wording stays approximate because the
 *   measurement is one run per chip;
 * - **it never reports success it has not seen.** The radio's flash ends with the link dropping,
 *   which is what a successful flash AND a silent non-take both look like. The verdict is
 *   "reconnect and read the version", never "done";
 * - **it stops between the two chips if the first did not take.** Half-way is a safe state; pressing
 *   on is not.
 *
 * **THE ORDER IS `FLASH_ORDER`'s, not this component's** — the thermostat, then the radio, in both
 * directions. It lives there with its reasoning and a test rather than as a comment here, because
 * getting it wrong is the mistake that strands a device.
 */

/**
 * One chip's image. `E` is what that chip must REPORT once it has taken it, and the two chips answer
 * differently — the thermostat a number in hundredths (`200`), the radio its own `major.minor`
 * string (`"5.0"`). Typing them apart rather than as `number | string` is what lets the radio's be
 * formatted and compared without a cast at every use.
 */
type Half<E> = { file: string; bytes: number; sha256: string; expect: E }
type Release = {
  version: string
  mod: boolean
  stm8: Half<number>
  radio: Half<string>
  /**
   * One owner-facing sentence about this version, written by `tools/stage_firmware.py`. Empty for a
   * release it has nothing to say about, which the picker treats as "say nothing" rather than
   * leaving a gap. It is NOT the changelog — that lives in the repo and is written for a reader with
   * a disassembler.
   */
  note?: string
}

/**
 * How long a transfer takes, per byte, read off THIS APP installing onto a bench unit from a phone
 * `[manually verified]`.
 *
 *   thermostat   34816 B in about 90 s   -> 387 B/s
 *   radio        27280 B in about 60 s   -> 455 B/s
 *
 * **SIZED FOR THE SLOWEST READING, ON PURPOSE.** An estimate that is too low reads as a broken
 * promise; one that is too high is merely a pleasant surprise. The radio leg has also read 585 B/s
 * on a smaller image, so its runs span 455-585 and this takes the lower.
 *
 * **THE PER-PACKET ARITHMETIC IN `link.ts` DOES NOT PREDICT THIS, AND THE MEASUREMENT WINS**
 * `[manually verified]`. That note reads the connection interval as one round trip per 16-byte
 * packet: 2588 packets at the ~77 ms implied on an Android phone is about 200 s, more than twice
 * what this transfer takes. A host-tool run on macOS says the same thing from the other side --
 * 23.5 ms a packet against a measured 52 ms interval. **So the interval bounds the pace rather than
 * setting it**, and a figure here has to come from a transfer rather than from that arithmetic.
 *
 * The two legs keep their own numbers because they take different paths: the radio's update service
 * asks for fast connection parameters and Android grants them, while the thermostat's ordinary
 * command characteristic does not ask, and pays an acknowledged write per 16-byte packet.
 *
 * **ONE RUN EACH.** Good enough to say "about 90 seconds" rather than "a few minutes", which is what
 * an owner actually needs to decide whether to begin. It is not good enough to quote to the second,
 * and `roughly` keeps the wording approximate on purpose. Once a leg is a few seconds and a couple of
 * kilobytes in, `rateOf` stops using this and uses what the run is actually achieving.
 */
const BYTES_PER_SEC = { stm8: 387, radio: 455 } as const

/**
 * How long to wait for a firmware image to download before calling it a failure.
 *
 * The images are tens of kilobytes and are usually served by the same origin the app was loaded
 * from, often out of the service worker's cache. Generous enough for a bad connection, finite
 * because of what the sheet is doing while it waits — see the call site.
 */
const FETCH_MS = 30_000

function seconds(rel: Release): number {
  return rel.stm8.bytes / BYTES_PER_SEC.stm8 + rel.radio.bytes / BYTES_PER_SEC.radio
}

/**
 * The rate to use for one leg RIGHT NOW — measured on this run once there is enough of it.
 *
 * **PER CHIP, NEVER BLENDED** `[owner]`. The two legs go through different services at different
 * rates, so a single figure would be wrong for whichever half is running and the estimate would
 * lurch when the run crossed over. Each leg carries its own start, and the leg that has not begun
 * has nothing to measure and keeps the figure above.
 *
 * **THE THRESHOLD IS THE POINT, not caution.** Early on, `done / elapsed` is dominated by the
 * bootloader handshake and the first chunk, and it produces numbers like "about 40 minutes" that
 * correct themselves seconds later — which reads as a broken estimate rather than a settling one. It
 * waits for a few seconds and a couple of kilobytes, by which time the rate is the transfer's own.
 */
function rateOf(leg: { done: number; total: number; startedAt?: number }, chip: Chip): number {
  if (!leg.startedAt) return BYTES_PER_SEC[chip]
  const secs = (Date.now() - leg.startedAt) / 1000
  if (secs < 5 || leg.done < 2048) return BYTES_PER_SEC[chip]
  return leg.done / secs
}

/** "about 6 minutes", "about 90 seconds" — never a false precision. */
function roughly(s: number): string {
  if (s < 120) return `about ${Math.round(s / 15) * 15} seconds`
  return `about ${Math.round(s / 60)} minutes`
}

/**
 * ONE MODAL OWNS THE WHOLE INSTALL, from the explanation to the outcome `[owner]`.
 *
 * The phases are states of one dialog and none of them closes it, so the pairing prompt arrives over
 * the explanation that asked for it and a failure is reported where the run was being watched.
 * `error` and `done` are terminal and both stay on screen until the person dismisses them; `error`
 * keeps the release, so Retry needs no re-picking.
 */
type Phase = 'confirm' | 'pairing' | 'running' | 'done' | 'error'

type Run = {
  rel: Release
  phase: Phase
  /**
   * Whether the confirm step lets the version be changed — true when this began as "install any
   * version", false for an upgrade, which already knows which one it is.
   *
   * It lives on the run rather than beside it because it survives everything the run does: an error
   * keeps the release so Retry needs no re-picking, and it should keep the picker for the same
   * reason — the version is the thing somebody may want to change after a failure.
   */
  pick?: boolean
  /** `startedAt` is stamped when the leg's first byte moves, and is what makes the estimate learn. */
  stm8: { done: number; total: number; startedAt?: number }
  radio: { done: number; total: number; startedAt?: number }
  note: string
  error?: string
}

export function FirmwareInstall() {
  const fw = useAtomValue(fwVersionAtom)
  const chip = useAtomValue(chipVersionAtom)
  const [releases, setReleases] = useState<Release[] | null>(null)
  const [job, setJob] = useState<Run | null>(null)

  /**
   * The catalogue is FETCHED, never compiled in — `tools/stage_firmware.py` writes it from what it
   * actually staged, so a menu can never offer an image that is not there.
   *
   * **THE LEADING SLASH IS LOAD-BEARING** `[manually verified]`. This app's URL is
   * `/thermostat/<id>/install`, so a RELATIVE path resolves to
   * `/thermostat/<id>/firmware/catalogue.json` — and the dev server's SPA fallback answers that with
   * `index.html` and **status 200**, so `r.ok` is true and the failure only surfaces as JSON that
   * will not parse. The symptom was the whole section reporting that no firmware was staged, on a
   * deploy where seven releases were.
   */
  useEffect(() => {
    fetch(catalogueUrl())
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      // NEWEST FIRST, SORTED HERE RATHER THAN TRUSTED FROM THE FILE `[owner]`. The catalogue lists
      // our build and then the stock ones oldest-first, which put 1.05 above 1.48 -- and the app is
      // shipped separately from whatever catalogue it meets, so a file with any order at all has to
      // come out right. Compared part by part, not as a decimal: 1.10 is above 1.9, not below it.
      .then((c: { releases: Release[] }) =>
        setReleases(
          [...(c.releases ?? [])].sort((a, b) => {
            const pa = a.version.split('.').map(Number)
            const pb = b.version.split('.').map(Number)
            for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
              const d = (pb[i] ?? 0) - (pa[i] ?? 0)
              if (d) return d
            }
            return 0
          }),
        ),
      )
      .catch(() => setReleases([]))
  }, [])

  /**
   * BOTH CHIPS, ONE CONNECTION, in the order `FLASH_ORDER` gives — and the first step is VERIFIED
   * before the second is touched.
   *
   * The thermostat reboots into its own bootloader and back out again, and none of that touches the
   * radio the link is actually terminated on, so the connection survives it. What has to be waited
   * for is the restart: it takes up to about a minute and a half, and the version read afterwards is
   * what decides whether the second half runs at all.
   *
   * **STOPPING BETWEEN THE TWO IS A SAFE PLACE TO STOP** — a half-modified device stays flashable in
   * both directions — so a verify that does not match ends the run and says so, rather than pressing
   * on into the mix that cannot be undone.
   */
  const run = useCallback(async (rel: Release) => {
    setJob({
      rel,
      phase: 'pairing',
      stm8: { done: 0, total: rel.stm8.bytes },
      radio: { done: 0, total: rel.radio.bytes },
      note: 'both update paths are protected, so this has to pair first',
    })
    // THE TRANSFER'S OWN TOTAL WINS. It knows what it is actually sending; the catalogue only knows
    // what was staged, and the two disagreed for the thermostat until `stage_firmware.py` started
    // counting the decoded payload rather than the hex file.
    const at = (chip: Chip, done: number, total?: number, note?: string) =>
      setJob((r) =>
        r
          ? {
              ...r,
              [chip]: {
                done,
                total: total ?? r[chip].total,
                // STAMPED ON THE FIRST BYTE THAT MOVES, not when the leg is set up: fetching the
                // image and entering the bootloader happen before any of it is on the wire, and
                // counting them would make the measured rate slower than the transfer really is.
                startedAt: r[chip].startedAt ?? (done > 0 ? Date.now() : undefined),
              },
              note: note ?? r.note,
            }
          : r,
      )

    // PAIR FIRST, AS ITS OWN STEP. Doing it inside the transfer is what produced a thermostat
    // sitting in its bootloader making no progress while a dialog waited on the phone.
    const ready = await prepareForFlash()
    const fail = (error: string) => setJob((r) => (r ? { ...r, phase: 'error', error } : r))
    if (!ready.paired) {
      return fail(
        'this thermostat wants to be paired with before it will accept an update, and that has not ' +
          'happened yet. Answer the pairing request on your phone — the code is on the thermostat’s ' +
          'own screen, under PAIr — then press Try again.',
      )
    }
    // CHECKED BEFORE A BYTE IS WRITTEN, because a run that cannot finish the radio's half would
    // leave the two chips out of step. Stopping here has cost nothing.
    if (!ready.radioReady) {
      return fail(
        'paired, but this connection still cannot reach the radio’s update service — so only the ' +
          'thermostat half could run, which would leave the two chips on firmware that does not ' +
          'match. Nothing has been written. Disconnect, connect again, and try again; the log says ' +
          'what it could not open.',
      )
    }
    setJob((r) => (r ? { ...r, phase: 'running', note: 'fetching' } : r))

    /**
     * One image, downloaded. BOUNDED, because of where in the flow it sits: by here the sheet has
     * hidden every button, taken the wake lock, blocked the phone's Back and armed the
     * leave-the-page prompt — right for a transfer in flight, wrong for a download that has
     * stalled, and a stall would leave somebody in a modal with no way out but killing the tab. A
     * failure lands in the catch below, which is the dismissible error phase with Try again.
     */
    const image = async (chip: Chip, half: Half<number> | Half<string>) => {
      at(chip, 0, undefined, `fetching the ${chip === 'stm8' ? 'thermostat' : 'radio'} image`)
      const res = await fetch(imageUrl(half.file), { signal: AbortSignal.timeout(FETCH_MS) })
      if (!res.ok) throw new Error(`could not fetch ${half.file}`)
      const bytes = new Uint8Array(await res.arrayBuffer())
      // `res.ok` IS NOT ENOUGH, and `checkImage`'s header says why: a missing file comes back as the
      // app's own page with status 200. Checked here rather than per chip, so neither half can be
      // the one that forgets.
      await checkImage(bytes, half)
      return bytes
    }

    try {
      // ---- 1. the thermostat -------------------------------------------------------------------
      // The payload is hex TEXT, which is the form the eQ-3 updater ships.
      const payload = unhexPayload(new TextDecoder().decode(await image('stm8', rel.stm8)))
      if (!parseChunks(payload).length) throw new Error(`${rel.stm8.file} has no chunks in it`)
      await flashThermostat(payload, (done, total, note) => at('stm8', done, total, note))

      // It restarts on its own and answers nothing until it has. Poll rather than sleep, so a fast
      // restart is not waited out and a slow one is not cut short.
      at('stm8', rel.stm8.bytes, undefined, 'the thermostat is restarting — this takes up to a minute or so')
      let seen: number | null = null
      for (let i = 0; i < 45 && seen !== rel.stm8.expect; i++) {
        await new Promise((r) => setTimeout(r, 2000))
        const info = await request(GET_INFO, isInfo, 1)
        seen = info?.[1] ?? null
      }
      // THE VERIFY THAT DECIDES WHETHER THE RADIO IS TOUCHED AT ALL — see this callback's header.
      if (seen !== rel.stm8.expect) {
        throw new Error(
          `the thermostat came back as ${seen ?? 'nothing'} rather than ${rel.stm8.expect}, so the ` +
            'radio has NOT been touched. It is safe here — try again.',
        )
      }
      at('stm8', rel.stm8.bytes, undefined, 'thermostat confirmed')

      // ---- 2. the radio ------------------------------------------------------------------------
      // LAST, ALWAYS, and it has to be: its verify step ends by dropping the link, which is how it
      // reports success, so anything after it would have no connection to work with.
      await flashRadio(await image('radio', rel.radio), (done, total, note) =>
        at('radio', done, total, note),
      )
      at('radio', rel.radio.bytes)
      setJob((r) => (r ? { ...r, phase: 'done', note: VERIFY_DROP_MEANS } : r))
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      log(`firmware: ${msg}`)
      // NOT A CLOSE, AND NOT A CLEARED PANEL. The failure is the one moment the person most needs
      // what is on screen -- which half ran, how far it got, and what went wrong -- so the bars stay
      // exactly where they stopped and the message joins them.
      setJob((r) => (r ? { ...r, phase: 'error', error: msg } : r))
    }
  }, [])

  /**
   * The newest release of OURS — which is what "upgrade" means here, not merely the highest number.
   *
   * Found rather than named, so nothing has to be edited when the version changes: the list is
   * sorted newest-first above, so the first `mod` entry is it. A catalogue with no mod release at
   * all (a deploy that staged only the stock images) simply has no upgrade to offer, and the picker
   * is then the only button.
   */
  const latest = releases?.find((r) => r.mod) ?? null

  /**
   * Is this thermostat already running that release — BOTH chips?
   *
   * Deliberately false while either version is still unknown: "you are up to date" is a claim, and
   * one made from a version that has not arrived would be a guess about the thing this whole card
   * exists to be sure of.
   */
  const onLatest =
    !!latest && fw !== null && chip !== null && fw === latest.stm8.expect && chipIs(chip, latest.radio.expect)

  /**
   * Does the radio belong with the thermostat — RED when it does not, grey when it does `[owner]`.
   *
   * Answered against the CATALOGUE rather than by comparing the two numbers, because they are not
   * comparable: 2.00 pairs with 5.0 and 1.48 with 4.6, and no arithmetic relates them. So the
   * question is "which release is this thermostat's, and is the radio on that release's image".
   *
   * A thermostat version we do not ship is not a mismatch — it is a device we have nothing to say
   * about, and colouring it red would be an accusation made from ignorance. Nor is a version still
   * being read: both must be known before this claims anything.
   */
  const theirs = releases?.find((r) => fw !== null && r.stm8.expect === fw) ?? null
  const radioMismatch = !!theirs && chip !== null && !chipIs(chip, theirs.radio.expect)

  /** A release, as a job the sheet can run. The one place a `Run` is built. */
  const begin = (r: Release): Run => ({
    rel: r,
    phase: 'confirm',
    stm8: { done: 0, total: r.stm8.bytes },
    radio: { done: 0, total: r.radio.bytes },
    note: '',
  })

  // The guards belong to the TRANSFER, not to the dialog: an explanation on screen is no reason to
  // hold the screen awake or to block the back button.
  const busy = job?.phase === 'running' || job?.phase === 'pairing'
  const radioFlashable = useAtomValue(radioFlashableAtom)
  // Every guard is held for exactly as long as this is true — see `flashGuards.ts`.
  useFlashGuards(busy)
  // **THROUGH THE GATE, NOT THROUGH `connectedAtom` DIRECTLY** `[owner]`. This section deliberately
  // is not wrapped in a `Gate` — what versions exist is worth reading before connecting — so its
  // buttons ask for themselves; but they ask the same question the same way as every other control
  // in the app, and the sentence they show comes from `caps.ts` rather than being written here.
  const link = useGate('link')
  const connected = link.ok

  return (
    /* NOT BEHIND THE CONNECTION `[owner]`. What versions exist is worth reading before connecting —
       gating the whole section made this tab look exactly as unbuilt as the placeholder it replaced.
       Only the buttons need a link, and each says so. */
    <div className="space-y-3">
      <section className="rounded-xl border bg-card p-4">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-base font-medium">Firmware</h2>
          {/* `[v2.00] [radio 5.0]`, AND THE COLOUR IS THE POINT `[owner]`. This is the one place in
              the app with room to show the pair properly, so it is also the place that can say what
              the pair MEANS without a sentence: how far behind the thermostat is, and whether the
              radio belongs with it. `versionTint` and `radioTint` are those two questions. */}
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {connected ? (
              <>
                installed:
                <Badge
                  variant="secondary"
                  className="font-normal tabular-nums"
                  style={fw === null ? undefined : { color: versionTint(fw, latest) }}
                  title={fw === null ? undefined : versionWhy(fw, latest)}
                >
                  {fw === null ? '—' : fwText(fw)}
                </Badge>
                <Badge
                  variant="secondary"
                  className="font-normal tabular-nums"
                  style={radioMismatch ? { color: BAD_TINT } : undefined}
                  title={
                    radioMismatch
                      ? 'this radio firmware does not belong with the thermostat’s — install a ' +
                        'version to put both chips back in step'
                      : undefined
                  }
                >
                  radio {chip ? chipNumber(chip) : '—'}
                </Badge>
              </>
            ) : (
              'connect to see what this thermostat is running'
            )}
          </span>
        </div>

        {releases === null && <p className="mt-3 text-sm text-muted-foreground">Looking…</p>}
        {/* NO BUILD INSTRUCTIONS HERE `[owner]`. A person reading this has a thermostat and a
            browser, not a checkout — naming a script they cannot run tells them nothing they can
            act on. It says what is true (this copy carries no firmware) and stops. */}
        {releases?.length === 0 && (
          <p className="mt-3 text-sm text-muted-foreground">
            This copy of the app was published without any firmware in it, so there is nothing to
            install from here.
          </p>
        )}

        {/* ONE BUTTON, AND WHICH ONE DEPENDS ON WHAT THIS THERMOSTAT IS RUNNING `[owner]`.
            A list of versions with an Install beside each makes picking one the FIRST question, when
            for almost everyone the only question is whether to take the latest. Somebody who
            genuinely wants an older one is a step away, and gets a screen built for choosing rather
            than a row in a list. */}
        {!!releases?.length && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {latest && !onLatest && (
              <Button
                disabled={busy || !link.ok}
                title={link.reason ?? undefined}
                onClick={() => setJob(begin(latest))}
              >
                <HardDriveDownload />
                Upgrade to {relText(latest.version)}
              </Button>
            )}
            {/* OUTLINE ALWAYS, AND ONE WORD `[owner]`. It is the way OUT of the recommended path —
                an older release, a reinstall, a downgrade — so it must not compete with Upgrade for
                the eye, and it must not look like the thing to press on a thermostat that is
                already up to date. The sheet it opens is titled with what it is for; the button
                only has to say which subject it is about. */}
            <Button
              variant="outline"
              disabled={busy || !link.ok}
              title={link.reason ?? undefined}
              onClick={() => releases[0] && setJob({ ...begin(releases[0]), pick: true })}
            >
              Firmware
            </Button>
          </div>
        )}
        {/* SAID ONLY WHEN IT IS TRUE, and it is the reassurance that lets the upgrade button be
            absent without looking like something is missing. */}
        {onLatest && (
          <p className="mt-2 text-xs text-muted-foreground">
            This thermostat is already on{' '}
            {latest ? releaseText(latest.version, latest.radio.expect) : ''}, which is the newest
            here.
          </p>
        )}

      </section>

      {job && (
        <InstallSheet
          job={job}
          radioOk={radioFlashable}
          // Only the confirm step can offer a change of version, and only when this run began as
          // "any version" — an upgrade already knows which one it is.
          releases={job.pick ? (releases ?? []) : []}
          fw={fw}
          chip={chip}
          onChoose={(r) => setJob({ ...begin(r), pick: true })}
          // NO CLOSE WHILE IT RUNS. Everything else may be dismissed; a transfer in flight may not,
          // because the dialog is the only thing saying not to walk away from the radiator.
          onClose={job.phase === 'running' ? undefined : () => setJob(null)}
          onGo={() => void run(job.rel)}
        />
      )}
    </div>
  )
}

/**
 * While it runs — **both bars, always**, shown from the pairing step onwards so the half still to
 * come is visibly empty rather than absent and the order is on screen before anything happens.
 *
 * The byte count leads and the remaining time follows it, derived from it by `rateOf`.
 */
function Bars({ run }: { run: Run }) {
  const bar = (chip: Chip, nth: number) => {
    const { done, total } = run[chip]
    const pct = total ? Math.round((done / total) * 100) : 0
    return (
      <div key={chip}>
        <div className="flex items-baseline justify-between text-sm">
          <span className="font-medium">
            {nth}. {chip === 'stm8' ? 'Thermostat' : 'Radio'}
          </span>
          <span className="tabular-nums text-muted-foreground">{pct}%</span>
        </div>
        <Progress value={pct} className="mt-1" />
        {/* THE REMAINING TIME SITS WITH THE BYTES IT IS DERIVED FROM `[owner]`, per chip, because
            that is the bar a person is actually watching. In SECONDS, not "about a minute": next to
            a byte count that moves, a rounded phrase reads as stuck. It is hidden once the leg is
            finished -- "remaining: 0s" on a full bar is noise. */}
        <p className="mt-1 text-xs tabular-nums text-muted-foreground">
          {done} of {total} bytes
          {done < total && <> · remaining: {Math.round((total - done) / rateOf(run[chip], chip))}s</>}
        </p>
      </div>
    )
  }
  // The same two, in the same order, as the installer runs them — thermostat, then radio.
  return (
    <div className="space-y-4">
      {bar('stm8', 1)}
      {bar('radio', 2)}
    </div>
  )
}

/**
 * The version chooser, which is the TOP OF THE CONFIRM STEP rather than a dialog of its own.
 *
 * **ONE MODAL, BECAUSE THE WARNINGS BELONG TO WHATEVER IS CHOSEN** `[owner]`. A separate picker
 * would have to show them too — the risks are the same for every version — and then show them again
 * on the confirm step behind it, which teaches somebody to scroll past the one paragraph on this
 * screen that matters. Choosing and confirming are one question here: which version, and start now?
 *
 * **NO SIZES AND NO DURATIONS in the list** `[owner]`. They are within a few kilobytes and a few
 * seconds of each other, so as a column they would be seven numbers that never decide anything. The
 * duration is still stated once, below, where the question really is "do I begin this now".
 *
 * **EACH ONE NAMES BOTH CHIPS** — "1.48 (radio 4.6)" — because a version here is a PAIR of images,
 * and the radio's own number is what the top bar shows whenever the two disagree. Somebody comparing
 * what their thermostat reports against this list needs the same two numbers on both sides.
 */
function VersionChoice({
  releases,
  rel,
  fw,
  chip,
  onChoose,
}: {
  releases: Release[]
  rel: Release
  fw: number | null
  chip: ChipVersion | null
  onChoose: (r: Release) => void
}) {
  /** On this exact release — BOTH chips. The same rule the card uses to decide "already up to date". */
  const isCurrent = (r: Release) =>
    fw !== null && chip !== null && fw === r.stm8.expect && chipIs(chip, r.radio.expect)
  return (
    // IN ITS OWN CARD, because what follows it is prose about whatever is chosen — without a border
    // the select and the paragraph below read as one block and the choice stops looking like a
    // control `[owner]`. The two headings are the same weight as "While it runs" below, so the
    // dialog reads as a sequence of labelled blocks rather than a wall.
    <div className="space-y-3 rounded-lg border bg-muted/30 p-3 text-sm">
      <p className="font-medium">Version</p>
      <Select
        value={rel.version}
        onValueChange={(v) => {
          const next = releases.find((r) => r.version === v)
          if (next) onChoose(next)
        }}
      >
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {releases.map((r) => (
            <SelectItem key={r.version} value={r.version}>
              <span className="flex items-center gap-2">
                <span>
                  {releaseText(r.version, r.radio.expect)}
                </span>
                {isCurrent(r) ? (
                  <Badge variant="secondary" className="font-normal">
                    installed
                  </Badge>
                ) : (
                  r.mod && (
                    <Badge variant="secondary" className="font-normal">
                      this project
                    </Badge>
                  )
                )}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {rel.note && (
        <div>
          <p className="font-medium">Changelog</p>
          <p className="mt-1 text-muted-foreground">{rel.note}</p>
        </div>
      )}
    </div>
  )
}

/**
 * How old is this thermostat's firmware, as a colour `[owner]`.
 *
 * Three states, not a scale: it is the newest we ship, or it is old but still one of the versions
 * with the settings people expect, or it is neither. The middle stop is **1.46**, which is where the
 * boost length, the boost valve position and the automatic open-window detection arrive — below that
 * an owner is missing settings this app offers rows for, which is the difference they would actually
 * notice.
 *
 * A catalogue with no release of ours cannot say what "newest" is, so nothing is green: the app is
 * then in no position to call a version out of date.
 */
const NEWISH_FW = 146
function versionTint(fw: number, latest: Release | null): string {
  if (latest && fw === latest.stm8.expect) return GOOD_TINT
  return fw >= NEWISH_FW ? MID_TINT : BAD_TINT
}

/** The same three states in words, for the badge's title. */
function versionWhy(fw: number, latest: Release | null): string {
  if (latest && fw === latest.stm8.expect) return 'this is the newest firmware here'
  return fw >= NEWISH_FW
    ? 'not the newest, but recent enough to have the settings this app shows'
    : 'old firmware — several of the settings this app shows do not exist in it'
}

/** Titles take the release's version BARE and add the `v` here, so no caller has to remember it. */
const TITLES: Record<Phase, (v: string) => string> = {
  confirm: (v) => `Install ${relText(v)}?`,
  pairing: () => 'Pair with the thermostat',
  running: (v) => `Installing ${relText(v)}`,
  done: (v) => `${relText(v)} installed`,
  error: () => 'That did not finish',
}

/**
 * The install dialog, in whichever phase the job is in. It is one component on purpose: the phases
 * share the release, the two bars and the warning, and splitting them is what let the confirm dialog
 * be unmounted the instant the run started.
 */
function InstallSheet({
  job,
  radioOk,
  releases,
  fw,
  chip,
  onChoose,
  onClose,
  onGo,
}: {
  job: Run
  radioOk: boolean
  /** The versions to offer at the confirm step. EMPTY means "not this run's question" — see `pick`. */
  releases: Release[]
  fw: number | null
  chip: ChipVersion | null
  onChoose: (r: Release) => void
  onClose?: () => void
  onGo: () => void
}) {
  // ASKED HERE RATHER THAN PASSED IN. A dialog is a portal, so it is outside every `Gate` on the
  // page and has to ask for itself — and asking is one call, where a prop threaded down from a
  // parent that asked the same question is a second copy of the answer.
  const link = useGate('link')
  const connected = link.ok
  const rel = job.rel
  if (job.phase !== 'confirm') {
    return (
      <Sheet title={TITLES[job.phase](rel.version)} onClose={onClose}>
        <div className="space-y-4">
          {job.phase === 'pairing' && (
            <p className="text-sm">
              Your phone should be asking to pair with the thermostat. <strong>Answer it</strong> —
              the six-digit code is on the thermostat’s own screen, under{' '}
              <code className="rounded bg-muted px-1">PAIr</code>. Updates are the one thing an
              encryption key cannot open, so this step is unavoidable.
            </p>
          )}

          <Bars run={job} />
          {job.note && <p className="text-xs text-muted-foreground">{job.note}</p>}

          {job.phase === 'running' && (
            <Alert variant="destructive">
              <AlertTriangle />
              <AlertDescription>
                <strong>{STAY_PUT}</strong> The screen is being kept awake and leaving this page is
                blocked while it runs — but nothing can stop you switching apps, and a transfer that
                stalls does so half-written. Do not touch the thermostat’s buttons either.
              </AlertDescription>
            </Alert>
          )}

          {job.phase === 'error' && (
            <Alert variant="destructive">
              <AlertTriangle />
              <AlertDescription>{job.error}</AlertDescription>
            </Alert>
          )}

          {job.phase === 'done' && (
            <Alert>
              <AlertDescription>
                <strong>Both chips are on {releaseText(rel.version, rel.radio.expect)}.</strong>{' '}
                {job.note}
              </AlertDescription>
            </Alert>
          )}

          {/* NO BUTTONS AT ALL WHILE IT RUNS, which is the same rule as the missing close: there is
              nothing useful to press, and an enabled control invites a press that would abandon a
              half-written device. */}
          {job.phase !== 'running' && (
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={onClose}>
                Close
              </Button>
              {job.phase === 'error' && (
                <Button className="flex-1" onClick={onGo}>
                  Try again
                </Button>
              )}
            </div>
          )}
        </div>
      </Sheet>
    )
  }
  return (
    <Sheet
      title={releases.length ? 'Install any version' : TITLES.confirm(rel.version)}
      onClose={onClose}
    >
      <div className="space-y-4">
        {/* THE CHOICE LEADS, and everything below it describes whatever is chosen — the warnings and
            the duration re-read correctly on every change because none of them names a version. */}
        {!!releases.length && (
          <VersionChoice
            releases={releases}
            rel={rel}
            fw={fw}
            chip={chip}
            onChoose={onChoose}
          />
        )}
        {/* THE VARIANT QUESTION, ANSWERED WHERE IT IS ASKED `[owner]`. Some units are marked
            CC-RT-M-BLE; their thermostat firmware is byte-identical at every version and their
            radio image differs only in the name it advertises, so there is nothing to choose
            between. It belongs HERE rather than on the tab: the moment the question occurs to
            somebody is the moment they are being asked to pick a version. */}
        <p className="text-xs text-muted-foreground">
          If your thermostat is marked <strong>CC-RT-M-BLE</strong> rather than CC-RT-BLE, it makes
          no difference — the firmware is the same and there is nothing here to pick.
        </p>
        {/* NO PARAGRAPH ABOUT THE TWO CHIPS HERE `[owner]`. The order, the check between the halves
            and the safety of stopping in the middle are things the run does for you, not decisions
            on this screen. The bars name the order once it starts, and the card behind this dialog
            already colours a mismatched pair red, where it can actually be acted on. */}

        {/* THE DURATION IS MEASURED -- see `BYTES_PER_SEC`. It is one run per chip, so the wording
            stays approximate: an owner needs to know whether this is a coffee or an evening, and
            that is the precision the number honestly supports. */}
        <div className="rounded-lg border p-3 text-sm">
          <p className="font-medium">While it runs</p>
          <ul className="mt-1 list-disc space-y-1 pl-4 text-muted-foreground">
            <li>stay next to the radiator — it is talking over Bluetooth the whole time</li>
            <li>do not lock the phone or let the screen go off</li>
            <li>do not switch to another app, or leave this page</li>
            {/* ONE FIGURE HERE `[owner]`. Before it starts, the only question is whether to begin
                now -- a breakdown is detail for a decision that does not need it. The per-chip
                numbers belong on the bars, where somebody is watching one of them move. */}
            <li>
              it takes <strong>{roughly(seconds(rel))}</strong>, most of it the thermostat
            </li>
          </ul>
        </div>

        {/* TWO CAUSES LOOK THE SAME HERE and they have different answers, so this stops short of
            claiming which. A radio with no update service leaves the thermostat half working; a
            thermostat asking for a PIN from a device that never paired closes BOTH halves, because
            the thermostat's own update travels on the plain command channel, which that setting
            shuts as well — and that is the case an owner is most likely to be in, since it is
            reached by turning on a setting rather than by owning older hardware. AN ENCRYPTION KEY
            DOES NOT HELP HERE, which is worth saying precisely because it helps everywhere else on
            this screen's neighbours: it admits a device to the commands, not to either update path.

            A WARNING, NOT A LOCK `[owner]`. The flag is read at connect, when a protected attribute
            may still have been refused, so disabling on it would say "unreachable" about a radio
            that pairing is about to make reachable — and a disabled button with a paragraph beside
            it is a dead end rather than a next step. The run re-checks after pairing and refuses
            there, before writing a byte, which is both later and better informed. */}
        {!radioOk && (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertDescription>
              Right now this connection cannot reach the radio’s update service. If the thermostat is
              asking for a PIN and this phone has not paired with it, that is the cause and the next
              step fixes it — updates need pairing, and an encryption key does not open them. This is
              checked again after pairing, and nothing is written until it passes.
            </AlertDescription>
          </Alert>
        )}

        {/* THE LINK CAN GO WHILE THIS DIALOG IS OPEN, and nothing has been written yet, so this is
            the one failure with a completely clean way out `[owner]`. Said HERE rather than left to
            fail at the pairing step, where the reason would arrive dressed as an error from a run
            that never started. Nothing in this dialog can reconnect — the button that does is behind
            it — so it says which button and in what order. */}
        {!connected && (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertDescription>
              <strong>The thermostat has disconnected.</strong> Nothing has been written, so there is
              nothing to undo. Close this, connect again with the button at the top, and start it
              afresh.
            </AlertDescription>
          </Alert>
        )}

        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" onClick={onClose}>
            {connected ? 'Not now' : 'Close'}
          </Button>
          <Button className="flex-1" disabled={!link.ok} title={link.reason ?? undefined} onClick={onGo}>
            Install {relText(rel.version)}
          </Button>
        </div>
      </div>
    </Sheet>
  )
}
