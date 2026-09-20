/**
 * WHAT THIS PARTICULAR THERMOSTAT CAN DO — the one place the app decides, so no control has to.
 *
 * A stock thermostat is a working thermostat: the temperature, the mode, the boost, the child lock
 * and the weekly programme are all STOCK commands and behave identically on both images. What our
 * firmware adds is everything else, and on a stock device those controls cannot work.
 *
 * **GREY OUT WITH A REASON, NEVER HIDE.** A missing control reads as an app that cannot do the
 * thing; a disabled one that says why reads as a device that cannot, which is the truth and is
 * actionable — the reason is usually "install our firmware".
 *
 * TWO CHIPS, TWO ANSWERS, and conflating them mislabels features. The thermostat's own firmware
 * (`cmd 0x00`, against `FW_MOD`) gates everything the STM8 implements; the radio chip's (WS-OTA
 * app-info, against `CHIP_MOD_MAJOR`) gates the encrypted broadcast and the encrypted command door.
 * A device can genuinely be one of each — that is the state every install passes through.
 *
 * NULL IS NOT STOCK. A version we have not read is unknown, and treating unknown as stock would
 * grey out a modded thermostat's whole app the moment a read was slow. Unknown gates as "not yet
 * known", which reads as waiting rather than as absent.
 */
import type { KeyStatus } from './access'
import type { AdvName } from './advname'
import type { Settings } from './config'
import { CHIP_MOD_MAJOR, FW_MOD, type ChipVersion } from './protocol'

/**
 * What a control needs. The names are features, not command ids — ids move between chips.
 *
 * **THE LAST FOUR ARE PROBES RATHER THAN VERSIONS, and they are here for exactly that reason**
 * `[owner]`. A version cannot answer every question: the radio reports `5.0` for every image we have
 * ever shipped, including the ones from before the name command existed, so "can this thermostat be
 * renamed" is settled only by asking it. A row that decides that for itself is a row we cannot hold
 * to the others — the name row once greyed itself out and said the radio was too old, on a screen
 * showing that radio's version as ours.
 *
 * So the probes live here beside the versions. **One file decides whether a control is usable, and
 * one file writes the sentence saying why not** — whether the answer comes from a version or from a
 * question the device was asked.
 */
export type Need =
  /** Any thermostat, stock included, but the link must be up. */
  | 'link'
  /** The thermostat runs our firmware — the mod command ids live there. */
  | 'modThermostat'
  /** The radio chip runs our firmware — the encrypted broadcast and the sealed door. */
  | 'modRadio'
  /** The radio answers the name command, which only asking it can establish. */
  | 'advName'
  /** The access report has arrived — the PIN gate, the broadcast switch and the key's state. */
  | 'access'
  /** The settings report has arrived — `cmd 0x16`, which only our firmware answers. */
  | 'settings'

export type Caps = {
  connected: boolean
  /** null = not read yet, which is NOT the same as stock. */
  fw: number | null
  chip: ChipVersion | null
  /** undefined = not asked yet, null = asked and it does not answer. They are different states. */
  advName: AdvName | null | undefined
  /** The access report, or null while nothing has said one. */
  access: KeyStatus | null
  /** The settings report, or null while nothing has said one. */
  settings: Settings | null
}

export type Verdict = { ok: boolean; reason: string | null }

/**
 * "Does this chip run OUR firmware?" — the two predicates this whole file exists to own, and the
 * only place either test is written.
 *
 * `gate`, `pairing` and the top bar's version pills all ask these rather than each spelling the
 * comparison out: the green "ours" pill and the greyed-out mod-only tabs must not be able to
 * contradict each other on the same screen.
 *
 * **NOT-READ IS FALSE HERE, and callers that need to tell "no" from "not yet" must check for `null`
 * themselves** — `gate` does, because "still asking" and "this is a stock thermostat" are different
 * things to say to a person, and `pairing` does, because a pair cannot be judged from one version.
 */
export const isModFw = (fw: number | null): boolean => fw === FW_MOD
export const isModRadio = (chip: ChipVersion | null): boolean =>
  chip !== null && chip.major >= CHIP_MOD_MAJOR

const OK: Verdict = { ok: true, reason: null }

/**
 * Can this control be used, and if not, what would a person do about it?
 *
 * The reason is written for somebody standing at a radiator, so it names the thing to do rather
 * than the byte that is missing.
 */
export function gate(need: Need, c: Caps): Verdict {
  if (!c.connected) return { ok: false, reason: 'connect to the thermostat to use this' }
  switch (need) {
    case 'link':
      return OK
    case 'modThermostat':
      if (c.fw === null) return { ok: false, reason: 'still asking the thermostat what it runs' }
      return isModFw(c.fw)
        ? OK
        : { ok: false, reason: 'this thermostat runs the original firmware — install ours to use it' }
    case 'modRadio':
      if (c.chip === null) return { ok: false, reason: 'still asking the radio what it runs' }
      return isModRadio(c.chip)
        ? OK
        : { ok: false, reason: 'the radio runs the original firmware — install ours to use it' }
    case 'advName':
      // TWO STATES FAIL AND THEY SAY DIFFERENT THINGS. Not asked yet reads as waiting; asked and
      // never answered is a verdict on the RADIO and names what to do about it.
      if (c.advName === undefined) return { ok: false, reason: 'still asking what it is called' }
      if (c.advName === null)
        return {
          ok: false,
          reason: 'this radio does not answer the name command — install a newer radio firmware',
        }
      // **A REFUSED NAME IS NOT A REASON THE ROW CANNOT BE USED**, and treating it as one takes the
      // row away at the moment it is most needed: the refusal is about the name somebody just
      // TRIED, the thermostat is still called whatever it was called, and the only thing to do is
      // open the row again and pick a shorter one. The device's own words about the refusal belong
      // in the sheet, which is where they are said.
      return OK
    case 'access':
      return c.access
        ? OK
        : { ok: false, reason: 'still reading this thermostat’s access settings' }
    case 'settings':
      return c.settings ? OK : { ok: false, reason: 'still reading this thermostat’s settings' }
  }
}

/**
 * Do the two chips belong together?
 *
 * **THE TWO NUMBERS ARE ONLY WORTH SHOWING SEPARATELY WHEN THEY DISAGREE** `[owner]`. A device that
 * is wholly ours is "2.00" and a device that is wholly original is "1.48"; printing the radio's own
 * version beside either is noise, and — since the bar has room for a number but not for a label —
 * noise that reads as a second opinion about the same thing. The report this came from was exactly
 * that: a lone `5.0` on screen, taken for the thermostat's version.
 *
 * **MIXED IS A REAL AND ORDINARY STATE, not a fault**: it is what every install and every revert
 * passes through, and it is the one moment when both numbers matter, because which chip is still
 * behind is the whole question.
 *
 * The pairing is decided by MOD-OR-NOT rather than by matching release numbers, and that is
 * deliberate: the app's own catalogue knows which radio version ships with which release, but the bar
 * has no business fetching it, and the distinction an owner acts on is "half installed", not "1.48
 * with a 4.4 radio" — a combination nothing here produces.
 */
export type Pairing = 'matched' | 'mixed' | 'unknown'

export function pairing(fw: number | null, chip: ChipVersion | null): Pairing {
  // NOT-YET-READ IS ITS OWN ANSWER, and it must not collapse into either other one: a version we
  // have not got is not evidence of stock, and pretending the pair matches would print one number as
  // though it stood for both chips. It is the state the missing-pill report was really about.
  if (fw === null || chip === null) return 'unknown'
  return isModFw(fw) === isModRadio(chip) ? 'matched' : 'mixed'
}

/**
 * THE macOS MESSAGE, and it is macOS ONLY — never iOS `[owner]` `[binary]`.
 *
 * A stock radio chip puts its notify descriptor fifteen handles away from the value it belongs to,
 * and CoreBluetooth will not attach it — so on a Mac the page can SEND commands and never see a
 * single reply. Our radio firmware moves it adjacent and fixes exactly that. It is the one failure
 * here with something a person can do about it, which is why it gets a sentence instead of silence.
 *
 * It cannot be about iPhones: Web Bluetooth ships in Chrome and Edge only, and on iOS every browser
 * is Safari underneath, so this app does not run there at all and the message is unreachable.
 * Writing it as an iOS fix would be promising something no firmware of ours can deliver.
 */
export const MAC_NOTIFY_HINT =
  'This Mac cannot hear the thermostat answer, because its radio still runs the original ' +
  'firmware — macOS refuses to subscribe to it. Install our radio firmware from the Install tab ' +
  'and replies work. Sending commands already works; only the answers are missing.'

/** True on an Apple desktop, which is the only platform the message above applies to. */
export function isMac(): boolean {
  return /Mac/i.test(navigator.platform ?? '') || /Mac OS X/i.test(navigator.userAgent)
}
