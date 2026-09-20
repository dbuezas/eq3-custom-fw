import { REGEXP_ONLY_DIGITS } from 'input-otp'
import { useAtomValue } from 'jotai'
import {
  ChevronRight,
  Dices,
  KeyRound,
  Loader2,
  Radio,
  RotateCcw,
  ShieldCheck,
  Tag,
  Unlink,
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import {
  KEY_CHARS,
  RADIO_BACK_ON,
  RADIO_OFF_WARNING,
  ITEM_BROADCAST,
  ITEM_PIN_GATE,
  ITEM_RADIO,
  cleanKey,
  clearDeviceKey,
  clearPin,
  decodeKeyStatus,
  factoryReset,
  isPinReply,
  isSwitchReply,
  isUnpairReply,
  pinAccepted,
  unpairAccepted,
  unpairAll,
  randomKey,
  setDeviceKey,
  setPin,
  setSwitch,
  spellsClear,
  switchStored,
  type KeyStatus,
} from '@/device/access'
import {
  ADV_NAME_DEFAULT,
  ADV_NAME_PREFIX,
  aired,
  clearAdvName,
  count,
  decodeAdvName,
  isDefaultAdvName,
  setAdvName,
  type AdvName,
} from '@/device/advname'
import { log } from '@/state/log'
import {
  advNameAtom,
  chaseAdvName,
  disconnect,
  expectReplyUnderNewKey,
  keyStatusAtom,
  noteAdvName,
  noteKeyStatus,
  rearmSealing,
  refreshKeyStatus,
  request,
  send,
} from '@/device/link'
import type { Need } from '@/device/caps'
import { isAdvName, isKeyStatus } from '@/device/protocol'
import { useGate } from '@/state/useGate'
import { connectedAtom, openDeviceAtom } from '@/state/atoms'
import { registry } from '@/state/registry'

import { cn } from '@/lib/utils'

import { Gate } from './Gate'
import { Sheet } from './Sheet'
import { Alert, AlertDescription } from './ui/alert'
import { Button } from './ui/button'
import { Input } from './ui/input'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from './ui/input-group'
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSeparator,
  InputOTPSlot,
} from './ui/input-otp'
import { Label } from './ui/label'
import { Switch } from './ui/switch'

/**
 * The Install tab's access half: the name the thermostat broadcasts, the pairing PIN, the key the
 * DEVICE holds, and the three switches on its own Bluetooth page.
 *
 * **NONE OF THIS IS READ BACK, except as a yes/no — with ONE exception.** There is no command that
 * returns the key or the PIN, deliberately, so those items report what is in force and offer to
 * change it. The app's own stored copy of the key is a different thing and lives on the thermostat's
 * row in the saved list, where it is shown `[owner]`. The **name** is the exception and is read back
 * in full, because it is not a secret and because a person needs to see what they are changing —
 * `device/advname.ts`.
 */
export function AccessSettings() {
  const connected = useAtomValue(connectedAtom)
  const device = useAtomValue(openDeviceAtom)
  // The CONNECTION's state, read and never held — `link.ts` fills both on connect and clears them
  // when the link drops. Every tab unmounts when you leave it, so a copy here would be empty on
  // arrival (README, "one fact, one home").
  const status = useAtomValue(keyStatusAtom)
  const advName = useAtomValue(advNameAtom)
  const [open, setOpen] = useState<
    null | 'pin' | 'key' | 'radio' | 'gate' | 'unpair' | 'reset' | 'name'
  >(null)

  const load = useCallback(async () => {
    if (!connected) return
    // **THE NAME READ IS THE FEATURE PROBE, and nothing else can be.** The radio's app-info version
    // says `5.0` for every image we have ever shipped, including the ones from before `cmd 0x5B`
    // existed, so it cannot answer "does this device have the name command". The command answering
    // is the only evidence there is.
    void chaseAdvName()
    if (!(await refreshKeyStatus()))
      log('could not read this thermostat’s access settings — showing the last known state')
  }, [connected])

  // RE-ASK WHEN THIS OPENS: these settings have a writer nothing here can see — the thermostat's
  // own settings page 6 turns the broadcast off — so arriving is the moment to confirm.
  useEffect(() => {
    void load()
  }, [load])

  const flip = async (item: number, on: boolean, what: string) => {
    const r = await request(setSwitch(item, on), isSwitchReply)
    if (!r) return log(`${what}: no answer` + (item === ITEM_RADIO && !on ? ' — which is expected when the radio goes off' : ''))
    // THE REPLY CARRIES WHAT WAS STORED, so the switch is answered by the command itself and the
    // re-read below is only a confirmation. Redrawing the item from that read instead would make a
    // dropped reply look like a switch that refuses to move.
    const stored = switchStored(r)
    if (stored === null) return log(`${what}: the thermostat refused that`)
    if (status)
      noteKeyStatus(
        item === ITEM_BROADCAST
          ? { ...status, broadcastOn: !!stored }
          : item === ITEM_PIN_GATE
            ? { ...status, pinGateOn: !!stored }
            : status,
      )
    // THE PIN GATE DOES **NOT** END THE CONNECTION `[owner]`. The phone raises its own pairing
    // dialog the moment something needs it, so a link that has just been gated recovers in place —
    // which is what `PairInvite` is for — and turning the gate off loses nothing at all.
    // **The rule is to disconnect only when it is NECESSARY**, and this is not.
    void load()
  }

  return (
    <Gate need="link" className="space-y-3">
      <ul className="divide-y overflow-hidden rounded-xl border bg-card">
        {/* FIRST, BECAUSE IT IS WHAT MAKES THE REST OF THIS SCREEN AIMABLE. Everything below acts on
            "this thermostat", and until it has a name of its own there is no way to be sure which
            one that is — the browser's device list calls every one of them CC-RT-BLE. */}
        {/* WHY IT MIGHT NOT BE USABLE IS NOT THIS ROW'S BUSINESS — `need` asks, and `caps.ts`
            answers with the sentence too. What is left here is the one thing only this row knows:
            what to say when it IS usable. */}
        <LinkRow
          icon={Tag}
          title="Bluetooth name"
          value={
            !advName
              ? ''
              : isDefaultAdvName(advName.name)
                ? `${advName.name} — the same as every other thermostat, so the browser’s device list cannot tell them apart`
                : // THE AIRED NAME, NOT THE STORED ONE. They differ by the prefix the radio adds,
                  // and this row is about what a person will SEE in their browser's device list —
                  // showing the stored text here would name something that appears nowhere.
                  `${aired(advName.name)} — how it shows up in the browser’s device list`
          }
          need="advName"
          onClick={() => setOpen('name')}
        />
        <SwitchRow
          icon={ShieldCheck}
          title="Ask for a PIN"
          value={
            // **THE PIN DOES NOT COVER THE ENCRYPTED DOOR** `[manually verified]` — a connection
            // that has never paired turns this very setting off through it (`../../../PROTOCOL.md`, "Sending
            // a command encrypted"). `GateConfirm` states the same exception; this row is what most
            // people read instead of opening it, so it must not claim the PIN covers everything.
            status?.pinGateOn
              ? 'on — a phone must pair first, unless it holds the encryption key'
              : 'off — anything in range can read and change this thermostat'
          }
          on={!!status?.pinGateOn}
          need="access"
          // ON ASKS, OFF DOES NOT. Turning it on cannot be undone from this app; turning it off is
          // safe and instant, so making both confirm would train the confirmation away.
          onChange={(next) => (next ? setOpen('gate') : void flip(ITEM_PIN_GATE, false, 'asking for a PIN'))}
        />
        <LinkRow
          icon={ShieldCheck}
          title="Pairing PIN"
          value="six digits; changing it does not unpair anything already paired"
          need="link"
          onClick={() => setOpen('pin')}
        />
        <LinkRow
          icon={Unlink}
          title="Unpair all"
          value="removes every phone and computer that has paired with this thermostat"
          need="link"
          onClick={() => setOpen('unpair')}
        />
        {/* LAST IN THE LIST, because it is the only item that ends with a thermostat this app cannot
            reach. Its value line says so rather than saving it for the dialog: a person deciding
            whether to tap deserves the reason before the tap, not after it. */}
        <LinkRow
          icon={RotateCcw}
          title="Factory reset"
          value="everything back to factory, and switches the thermostat’s Bluetooth off"
          need="link"
          onClick={() => setOpen('reset')}
        />
        <LinkRow
          icon={KeyRound}
          title="Encryption key"
          value={
            !status?.storeRead
              ? 'not known yet — the radio has not read its store'
              : status.present
                ? `in force${status.advertEncrypted ? '; the broadcast is encrypted' : ''}`
                : 'none'
          }
          need="access"
          onClick={() => setOpen('key')}
        />
        <SwitchRow
          icon={Radio}
          title="BThome broadcast"
          value={
            status?.broadcastOn
              ? 'on — Home Assistant and this app read the temperature without connecting'
              : // The thermostat keeps advertising and stays connectable; what stops is the
                // readings, which are dropped from the advert rather than frozen at their last
                // values (`ble_chip/mod/bthome.S`, `.Le_quiet`).
                'off — no readings are aired, so this app’s list and Home Assistant go blank'
          }
          on={!!status?.broadcastOn}
          need="access"
          onChange={(next) => void flip(ITEM_BROADCAST, next, 'broadcast')}
        />
        <LinkRow
          icon={Radio}
          title="Bluetooth"
          need="link"
          value="on — turning it off needs the thermostat’s own buttons to undo"
          onClick={() => setOpen('radio')}
        />
      </ul>

      {open === 'name' && advName && (
        <NameSheet
          current={advName}
          onClose={() => setOpen(null)}
          onApply={async (writes, what) => {
            // THE STAGES ANSWER NOTHING, BY DESIGN, so they go through `send` — `request` would
            // spend a full reply timeout on each of them waiting for something that was never
            // coming. Only the apply has news. Same shape as the key's three writes above.
            const apply = writes[writes.length - 1]!
            for (const w of writes.slice(0, -1)) await send(w)
            const r = await request(apply, isAdvName)
            if (!r) {
              // The write was acknowledged at the Bluetooth layer or it threw, so a missing REPLY
              // says nothing about whether the name changed. Re-reading is the only honest answer,
              // and it is what the row will show.
              log('the thermostat did not confirm the new name — re-reading what it is called')
              return void chaseAdvName()
            }
            const next = decodeAdvName(r)
            // `noteAdvName` is the one writer: it files the reply, derives the displayed name and
            // updates the saved row, so every screen showing a name follows it — this row included.
            noteAdvName(next)
            log(next?.error ?? what)
            if (!next?.error) setOpen(null)
          }}
        />
      )}

      {open === 'gate' && (
        <GateConfirm
          onClose={() => setOpen(null)}
          onConfirm={() => {
            setOpen(null)
            void flip(ITEM_PIN_GATE, true, 'asking for a PIN')
          }}
        />
      )}

      {open === 'unpair' && (
        <UnpairConfirm
          onClose={() => setOpen(null)}
          onConfirm={async () => {
            setOpen(null)
            const r = await request(unpairAll(), isUnpairReply)
            const ok = !!r && unpairAccepted(r)
            log(
              !r
                ? 'unpair all: no answer'
                : ok
                  ? 'unpaired every device — each one has to pair again'
                  : 'the thermostat refused the unpair',
            )
            // AND THE LINK STAYS UP `[owner]`. Neither chip drops it, and hanging up would not make
            // the phone re-pair: it keeps its own half of the pairing whatever happens here, and only
            // finds out on its NEXT connection. So a disconnect would buy nothing and would read as
            // the command having broken something.
          }}
        />
      )}

      {open === 'reset' && (
        <ResetConfirm
          onClose={() => setOpen(null)}
          onConfirm={async () => {
            setOpen(null)
            // `send`, NOT `request`: the thermostat reboots, so there is no reply to wait for and
            // `request` would spend every attempt's timeout before calling a command that worked a
            // failure. See `factoryReset`'s own comment.
            await send(factoryReset())
            // The dialog has gone by now, so the log carries the way back — it is the only place
            // left that can, and somebody who closes the app here needs it.
            log(`factory reset sent — the thermostat is restarting with its Bluetooth off. ${RADIO_BACK_ON}`)
            // AND THE APP LETS GO. Every other row here leaves a thermostat this app can still
            // reach, so staying connected is right; this one leaves a radio that is going dark, and
            // holding a link to it would show "connected" against a device that has already gone.
            disconnect()
          }}
        />
      )}

      {open === 'pin' && (
        <PinSheet
          onClose={() => setOpen(null)}
          onSet={async (bytes, what) => {
            const r = await request(bytes, isPinReply)
            const ok = !!r && pinAccepted(r)
            log(!r ? 'the PIN: no answer' : ok ? what : 'the thermostat refused that PIN')
            setOpen(null)
            // A CHANGED PASSKEY DOES NOT END THE CONNECTION `[owner]`. This link is already bonded,
            // and a new passkey applies to the NEXT pairing, not to one that has already happened —
            // so there is nothing here for the connection to be out of step with. Dropping it would
            // have cost a reconnect to change nothing, and hidden that the change had worked.
          }}
        />
      )}

      {open === 'key' && (
        <KeySheet
          status={status}
          onClose={() => setOpen(null)}
          onSet={async (writes, key) => {
            // THE STAGING WRITES ANSWER NOTHING, BY DESIGN — `key_cmd`: "stage KEYBUF. No EEPROM, no
            // reply, nothing live yet." So they go through `send`, which queues them exactly like
            // any other write and does not sit out a reply timeout for an answer that was never
            // coming. Through `request` they cost six seconds of dead time before the apply.
            const apply = writes[writes.length - 1]!
            for (const w of writes.slice(0, -1)) await send(w)
            // THE APPLY'S REPLY COMES BACK UNDER THE NEW KEY when this connection is encrypted
            // `[binary]` — the radio builds the report after the key is live. The command still goes
            // out under the OLD key, which is the one the radio will open it with; only the answer
            // moves. Without this the report fails to open and a key change that worked perfectly
            // reads as "no reply", losing the one thing that says whether it reached the store.
            // A CLEAR gets null: there is then no key to seal a report under at all, so none
            // arrives, and the reconnect below re-reads the state on the plain door.
            expectReplyUnderNewKey(key || null)
            // ONE ATTEMPT, NEVER A RETRY. The write is acknowledged at the ATT layer, so if it
            // returned at all the radio has it and the key has already changed — a second apply
            // would be sealed under a key the device no longer holds and refused, turning a
            // successful key change into an alarming message. A missing reply here means the reply
            // was lost, which no retry can undo.
            const r = await request(apply, isKeyStatus, 1)
            const st = r && decodeKeyStatus(r)
            if (st) noteKeyStatus(st)
            else log('the key was sent, but the thermostat’s confirmation did not arrive')
            expectReplyUnderNewKey(null)
            // KEEP THE APP'S COPY IN STEP. The device will never tell us this key again, so a key
            // set here and not stored here is one the broadcast can no longer be decoded with.
            // THE KEY AND NOTHING ELSE. Spreading the whole row here would republish the name this
            // closure captured, undoing a rename made since — see `registry.upsert`.
            if (device) registry.upsert({ id: device.id, key: key || undefined })
            log(key ? 'key set on the thermostat, and saved here' : 'key cleared')
            setOpen(null)
            // RE-ARM IN PLACE, DO NOT HANG UP `[owner]`. Those writes went out under the OLD key and
            // everything after them must use the new one, which the thermostat has already adopted.
            // The row was updated a line above, so this picks the new key up and the next command is
            // sealed with it — the link never goes away, which is what the owner asked for.
            await rearmSealing()
          }}
        />
      )}

      {open === 'radio' && (
        <Sheet title="Turn Bluetooth off?" onClose={() => setOpen(null)}>
          <div className="space-y-4">
            <p className="text-sm">{RADIO_OFF_WARNING}</p>
            <div className="flex gap-2">
              <Button
                variant="destructive"
                onClick={() => {
                  void flip(ITEM_RADIO, false, 'Bluetooth')
                  setOpen(null)
                }}
              >
                Turn it off
              </Button>
              <Button variant="outline" onClick={() => setOpen(null)}>
                Cancel
              </Button>
            </div>
          </div>
        </Sheet>
      )}
    </Gate>
  )
}

/**
 * The shared body of a row: the icon and the two lines of text. What sits on the RIGHT is what
 * says whether tapping changes the thermostat now or opens something first.
 *
 * **THE TWO KINDS MUST NOT LOOK ALIKE, and they do very different things** `[owner]`: most open a
 * sheet you can back out of, two change a setting on the thermostat the instant they are touched.
 * One of those two is the pairing gate, which locks every client out of the device. A flat strip of
 * text with a `hover:` style is NO feedback at all on a phone — it does not read as a control, gives
 * nothing back when pressed, and the consequence arrives a minute later as a thermostat that has
 * stopped answering.
 */
function RowBody({
  icon: Icon,
  title,
  value,
}: {
  icon: typeof Radio
  title: string
  value: string
}) {
  return (
    <>
      <Icon className="size-5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs break-words text-muted-foreground">{value}</span>
      </span>
    </>
  )
}

/**
 * A row that flips a setting on the thermostat, with the switch as the only target.
 *
 * THE WHOLE ROW IS DELIBERATELY NOT TAPPABLE. It reads as a settings row either way, and the two
 * rows in this list that change something immediately are the two that must be hard to hit by
 * accident — which is the whole lesson of the pairing gate. The switch is a real one, so it also
 * shows the current state rather than only accepting a press.
 */
function SwitchRow({
  icon,
  title,
  value,
  on,
  need,
  onChange,
}: {
  icon: typeof Radio
  title: string
  value: string
  on: boolean
  need: Need
  onChange: (next: boolean) => void
}) {
  const { ok, reason } = useGate(need)
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <RowBody icon={icon} title={title} value={ok ? value : (reason ?? value)} />
      <Switch checked={on} disabled={!ok} onCheckedChange={onChange} aria-label={title} />
    </li>
  )
}

/**
 * A row that opens a sheet: a chevron, and the whole row is the target.
 *
 * **IT DOES NOT DECIDE WHETHER IT IS USABLE — `caps.ts` does** `[owner]`. A `Need` is the whole
 * interface, and the sentence a person reads comes from the same file that decided. A row working
 * its own `disabled` out at the call site is a private rule that nothing else on the page agrees
 * with: the name row greyed ITSELF out and announced that the radio was too old, on a screen showing
 * that radio's version as ours.
 *
 * GREYED OUT, NEVER HIDDEN, and the reason takes the value line. A row that is not there reads as an
 * app that cannot do the thing; a row that is there and says why reads as a device that cannot, and
 * names what to do about it.
 */
function LinkRow({
  icon,
  title,
  value,
  need,
  onClick,
}: {
  icon: typeof Radio
  title: string
  value: string
  need: Need
  onClick: () => void
}) {
  const { ok, reason } = useGate(need)
  return (
    <li>
      <Button variant="ghost" size="row" disabled={!ok} onClick={onClick}>
        <RowBody icon={icon} title={title} value={ok ? value : (reason ?? value)} />
        {ok && <ChevronRight className="size-4 shrink-0 text-muted-foreground" />}
      </Button>
    </li>
  )
}

/**
 * "Unpair all" — the one screen here that throws away something the owner cannot get back.
 *
 * **THE LAST PARAGRAPH IS LOAD-BEARING, not padding** `[inferred]`. A phone keeps its own half of the
 * pairing. If only the thermostat forgets, the phone reconnects with a key the thermostat no longer
 * has and the pairing fails in a way that reads as a broken device — so the way out has to be on this
 * screen, before the fact, rather than discovered afterwards.
 */
function UnpairConfirm({ onClose, onConfirm }: { onClose: () => void; onConfirm: () => void }) {
  return (
    <Sheet title="Unpair all?" onClose={onClose}>
      <div className="space-y-3 text-sm">
        <p>
          Every phone and computer that has paired with this thermostat will be removed. Each one has
          to pair again with the PIN, next time it connects.
        </p>
        <Alert variant="destructive">
          <AlertDescription>
            If your phone still lists the thermostat afterwards, remove it there too — otherwise it
            will fail to reconnect.
          </AlertDescription>
        </Alert>
        <p className="text-muted-foreground">
          This connection keeps working until it ends by itself, so nothing here will look different
          straight away. Home Assistant and any other paired tool have to pair again as well. The
          PIN itself does not change, and the thermostat stays the same device to everything else.
        </p>
        <div className="flex gap-2 pt-1">
          <Button variant="destructive" onClick={onConfirm}>
            Unpair all
          </Button>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Sheet>
  )
}

/**
 * The one control in this app whose failure needs hands, so its sheet says the whole truth twice:
 * what goes, and that the thermostat will not be reachable from here afterwards.
 *
 * **IT DOES NOT PRETEND THE APP CAN FINISH THE JOB.** Everything else here ends with the thermostat
 * still on the air, so a person can undo it from the same screen. This ends with a dark radio and a
 * walk to the radiator, and a dialog that glossed over that would be the app being polite about
 * somebody else's afternoon.
 */
function ResetConfirm({ onClose, onConfirm }: { onClose: () => void; onConfirm: () => void }) {
  return (
    <Sheet title="Factory reset?" onClose={onClose}>
      <div className="space-y-3 text-sm">
        <p>
          Every setting goes back to how the thermostat left the factory — the weekly programme, the
          comfort and eco temperatures, the offset, the window settings, and everything this
          firmware adds. The pairing PIN and the encryption key are erased too. Then it restarts.
        </p>
        <Alert variant="destructive">
          <AlertDescription>
            <strong>It also switches the thermostat&rsquo;s Bluetooth off, and it stays off.</strong>{' '}
            This app will not be able to reach it afterwards. {RADIO_BACK_ON}
          </AlertDescription>
        </Alert>
        <p className="text-muted-foreground">
          The firmware is not touched — this thermostat keeps the version it is running. Anything
          paired with it, including Home Assistant, will need pairing again once its Bluetooth is
          back on, with the new PIN the thermostat then shows under <strong>PAIr</strong>.
        </p>
        <div className="flex gap-2 pt-1">
          <Button variant="destructive" onClick={onConfirm}>
            Reset and switch Bluetooth off
          </Button>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Sheet>
  )
}

/**
 * The one control here that can lock you out, so it is the one that asks first.
 *
 * TURNING IT ON IS NOT UNDOABLE FROM THIS APP. The gate is enforced by the radio chip and applies
 * to every characteristic, so once it is on this page cannot reach the thermostat to turn it off
 * again — the ways back are the thermostat's own buttons, a client that is already paired, and a
 * client holding the encryption key. That asymmetry is why only the ON direction confirms: turning
 * it off is safe and instant.
 */
function GateConfirm({ onClose, onConfirm }: { onClose: () => void; onConfirm: () => void }) {
  return (
    <Sheet title="Ask for a PIN?" onClose={onClose}>
      <div className="space-y-3 text-sm">
        <p>
          The thermostat will demand a PIN from every phone and computer that is not already paired
          with it. Home Assistant, this app on another device, and every tool here stop working
          until they pair — <strong>unless they hold the encryption key</strong>, which this setting
          does not cover.
        </p>
        {/* THE ENCRYPTION KEY IS AN ADMISSION TICKET, and naming it here is not optional
            `[manually verified]`: a fresh connection that never paired turned this very setting off
            through the encrypted door (`../../../PROTOCOL.md`, "Sending a command encrypted"). Omitting it
            leaves somebody who holds a key believing they have locked themselves out. */}
        <Alert variant="destructive">
          <AlertDescription>
            <strong>This app cannot undo it without one of these.</strong> Afterwards the thermostat
            refuses this page too. Three ways back: the <strong>PIn</strong> item on the thermostat’s
            own screen, a device that is already paired, or one that holds the encryption key.
          </AlertDescription>
        </Alert>
        <p className="text-muted-foreground">
          The PIN is shown on the thermostat itself, under <strong>PAIr</strong>.
        </p>
        <div className="flex gap-2 pt-1">
          <Button variant="destructive" onClick={onConfirm}>
            Ask for a PIN
          </Button>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Sheet>
  )
}

/**
 * Name this thermostat, so the browser's device list can be aimed.
 *
 * **THIS IS THE ONLY NAME THERE IS** `[owner]`. A local alias kept in the saved list would be a
 * second answer to the same question — true in one browser, and invisible to every other phone, to
 * Home Assistant and to the eQ-3 app. The saved row follows this control; setting a name here is
 * what updates it.
 *
 * **THE LIMIT IS THE DEVICE'S**, read from its reply, so the counter and the Save button are driven
 * by `current.max` and there is no number in this file. The counter shows BYTES because that is what
 * the thermostat counts — a name of five accented letters is ten of them, and a field that counted
 * characters would let somebody type a name that is refused with no explanation on screen.
 *
 * **THE DISCOVERY COST IS STATED BEFORE THE ACTION, NOT AFTER IT, AND IT IS NOT A BLOCK** `[owner]`.
 * A renamed thermostat stops being found automatically by anything that looks for `CC-RT-BLE` — Home
 * Assistant's discovery does exactly that. Anything already introduced to it keeps working, because
 * a browser grant, a pairing and a Home Assistant entry all hold an address rather than a name.
 */
function NameSheet({
  current,
  onClose,
  onApply,
}: {
  current: AdvName
  onClose: () => void
  onApply: (writes: number[][], what: string) => Promise<void>
}) {
  const [text, setText] = useState(isDefaultAdvName(current.name) ? '' : current.name)
  const [busy, setBusy] = useState(false)
  const used = count(text)
  const writes = setAdvName(text.trim(), current.max)
  const run = (w: number[][], what: string) => {
    setBusy(true)
    void onApply(w, what).finally(() => setBusy(false))
  }
  return (
    <Sheet title="Bluetooth name" onClose={onClose}>
      {/* TWO SENTENCES OF PROSE, AND BOTH EARN IT: the only prose here is what the controls cannot
          show — that renaming costs automatic discovery, and that the phone's own device list will
          lie about it afterwards. Anything the title, the field or the buttons already say is a wall
          in front of the two warnings that actually change what a person does. */}
      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="advname">Name this thermostat</Label>
          {/* THE PREFIX IS IN THE BOX, GREYED, AND NOT TYPEABLE. The thermostat adds it, so a field
              that did not show it asked for one thing and produced another — and a person who typed
              it themselves would have got `eQ3-eQ3-Kitchen`. Showing it inert says both halves at
              once: this is part of the name, and it is not yours to change. */}
          <InputGroup>
            <InputGroupAddon>
              <InputGroupText>{ADV_NAME_PREFIX}</InputGroupText>
            </InputGroupAddon>
            <InputGroupInput
              id="advname"
              value={text}
              disabled={busy}
              placeholder="Kitchen"
              onChange={(e) => setText(e.target.value)}
            />
          </InputGroup>
          {/* BYTES, AND IT SAYS SO — an accented letter costs two and an emoji four. See the
              component's header for why the count cannot be in characters. */}
          <p className="text-xs text-muted-foreground">
            {used} of {current.max} bytes{used > current.max && ' — too long'}
            {used !== text.length && ' (accents and emoji count more)'}
          </p>
        </div>
        {current.error && (
          <Alert variant="destructive">
            <AlertDescription>{current.error}</AlertDescription>
          </Alert>
        )}
        <Alert>
          <AlertDescription>
            <strong>Home Assistant and the eQ-3 app will stop discovering it.</strong> They look for
            the name {ADV_NAME_DEFAULT}. Anything already set up keeps working.
          </AlertDescription>
        </Alert>
        <Button className="w-full" size="lg" disabled={!writes || busy} onClick={() => run(writes!, `this thermostat is now called ${text.trim()}`)}>
          {busy && <Loader2 className="animate-spin" />}
          {busy ? 'Saving…' : 'Save'}
        </Button>
        {/* NOT DESTRUCTIVE-STYLED: this is the direction that RESTORES automatic discovery, so it is
            the safe one. It is the "forget the stored PIN" button's opposite in that respect. */}
        <Button
          variant="outline"
          size="lg"
          className="w-full"
          disabled={busy || isDefaultAdvName(current.name)}
          onClick={() => run([clearAdvName()], `this thermostat is called ${ADV_NAME_DEFAULT} again`)}
        >
          Use {ADV_NAME_DEFAULT}
        </Button>
        {/* TWO REASONS A RENAME LOOKS LIKE IT FAILED, and the first one is ours to state because it
            is not a cache at all `[manually verified]`. The name lives in the SCAN RESPONSE, and a
            connected peripheral advertises non-connectable — which is not scannable — so the
            thermostat sends no scan response to anyone while this app is connected to it. Measured:
            renamed over a held link, in the device's own buffer within a second, first heard on the
            air about five seconds AFTER the disconnect. So a client cannot observe its own rename.
            The second is the platform's name cache, which the page cannot clear: `forget()` revokes
            this origin's permission, a different record from the one the chooser draws names out
            of. Both end at the same instruction, which is why they are one sentence. */}
        <p className="text-xs text-muted-foreground">
          The new name only goes out once nothing is connected. Disconnect, and if your phone still
          shows the old one, remove the thermostat from its Bluetooth settings.
        </p>
      </div>
    </Sheet>
  )
}

function PinSheet({
  onClose,
  onSet,
}: {
  onClose: () => void
  onSet: (bytes: number[], what: string) => Promise<void>
}) {
  const [pin, setPinText] = useState('')
  // The same silence the key sheet had: a command with retries behind it, and nothing on screen
  // saying it is running. See `KeySheet`.
  const [busy, setBusy] = useState(false)
  const bytes = setPin(pin)
  const send = (b: number[], what: string) => {
    setBusy(true)
    void onSet(b, what).finally(() => setBusy(false))
  }
  return (
    <Sheet title="Pairing PIN" onClose={onClose}>
      <div className="space-y-4">
        {/* THE ONE THING A PERSON GETS WRONG HERE `[owner]`. A new PIN reads like it locks the old
            phones out, and it does not: a paired device holds a key of its own and is never asked
            for the PIN again, so the new one only applies to devices that have not paired yet.
            Believing otherwise means thinking a phone has been removed when it has not — which is a
            security misunderstanding, not a cosmetic one, so it goes in the sheet and not only on
            the row behind it. `Unpair all` is the thing that does what this appears to. */}
        <p className="text-sm text-muted-foreground">
          <strong>Devices that have already paired stay paired.</strong> A new PIN is only asked of
          devices that pair from now on. To remove the ones already in, use{' '}
          <strong>Unpair all</strong>.
        </p>
        {/* SIX SLOTS, NOT A TEXT FIELD. The PIN is exactly six digits and nothing else — the
            primitive enforces the length and the digits itself, so there is no "that is not six
            digits" message to write and no way to submit four. The 3+3 grouping is how a person
            reads a six-digit code back off the thermostat's own display. */}
        <div className="space-y-2">
          <Label>New PIN</Label>
          <InputOTP
            maxLength={6}
            pattern={REGEXP_ONLY_DIGITS}
            value={pin}
            disabled={busy}
            onChange={setPinText}
          >
            <InputOTPGroup>
              <InputOTPSlot index={0} />
              <InputOTPSlot index={1} />
              <InputOTPSlot index={2} />
            </InputOTPGroup>
            <InputOTPSeparator />
            <InputOTPGroup>
              <InputOTPSlot index={3} />
              <InputOTPSlot index={4} />
              <InputOTPSlot index={5} />
            </InputOTPGroup>
          </InputOTP>
        </div>
        <Button
          className="w-full"
          size="lg"
          disabled={!bytes || pin === '000000' || busy}
          onClick={() => send(bytes!, `PIN set to ${pin}`)}
        >
          {busy && <Loader2 className="animate-spin" />}
          {busy ? 'Setting…' : 'Set this PIN'}
        </Button>
        {pin === '000000' && (
          // Not a validation quibble: the device reads all-zero as "forget the stored one", so
          // 000000 is the one six-digit number that cannot be a PIN.
          <Alert variant="destructive">
            <AlertDescription>
              000000 cannot be a PIN — the thermostat reads it as “forget the stored one”. Use the
              button below for that.
            </AlertDescription>
          </Alert>
        )}
        {/* Destructive because it deletes, and the softest of the three: it does not leave the
            device without a PIN, it puts it back on the ORIGINAL firmware's behaviour — worth
            saying rather than leaving somebody to guess what "forget" means. */}
        <p className="text-sm text-muted-foreground">
          <strong>Forgetting it does not leave the thermostat without a PIN.</strong> It goes back to
          how the original 1.48 firmware behaves: a new random PIN each time it restarts, shown on
          its own display under <code className="rounded bg-muted px-1">PAIr</code>.
        </p>
        <Button
          variant="destructive"
          size="lg"
          className="w-full"
          disabled={busy}
          onClick={() => send(clearPin(), 'PIN cleared; the next restart draws a random one')}
        >
          Forget the stored PIN
        </Button>
      </div>
    </Sheet>
  )
}

/**
 * Setting the key ON the device — not the app's copy of it, which is on the saved list.
 *
 * It is presented plainly `[owner]`: a key encrypts the broadcast and opens the sealed command
 * pair, the ordinary command characteristic keeps working either way, and so it can never lock
 * anybody out. The threat model is the neighbour.
 */
function KeySheet({
  status,
  onClose,
  onSet,
}: {
  status: KeyStatus | null
  onClose: () => void
  onSet: (writes: number[][], key: string) => Promise<void>
}) {
  const [key, setKey] = useState('')
  // SENDING THIS TAKES SECONDS: three writes, each retried, so a bad moment on the radio runs it to
  // fifteen. An unchanged dialog with a live Set button through all of that is indistinguishable
  // from a button that did nothing, and pressing it again queues the whole thing a second time.
  const [busy, setBusy] = useState(false)
  const writes = setDeviceKey(key)
  const send = (w: number[][], k: string) => {
    setBusy(true)
    void onSet(w, k).finally(() => setBusy(false))
  }
  return (
    <Sheet title="Encryption key" onClose={onClose}>
      <div className="space-y-4">
        {/* **SAY THE TWO THINGS A KEY DOES, AND STOP** `[owner]`. The pair-less half is
            `[manually verified]` — holding the key admits you the same way pairing does, measured on
            a connection that had never paired (`../../../PROTOCOL.md`, "Sending a command encrypted") — and
            the firmware exception rides with it rather than being left for somebody to meet on the
            Install tab, because it is the one case where a key is not enough. */}
        <p className="text-sm text-muted-foreground">
          This key encrypts the thermostat’s BThome broadcasts, and opens a second, pair-less
          encrypted connection channel alongside the usual one.{' '}
          <strong>Installing firmware is the exception</strong> — that goes over the usual channel,
          and still needs pairing.
        </p>
        <p className="text-sm text-muted-foreground">
          The thermostat never tells a key back, so keep it: give the same one to Home Assistant,
          and this app stores its own copy on the thermostat’s row in the list.
        </p>
        {status && !status.storeRead && (
          <Alert>
            <AlertDescription>
              Whether one is already in force is not known yet: the radio has not read its store
              this session. That is not the same as “none”.
            </AlertDescription>
          </Alert>
        )}
        {/* WHAT AN OWNER MUST BE TOLD WHEN THEY SET A KEY, on the same two conditions
            `tools/set_bindkey.py` prints them — a provisioning screen that omits them is worse than
            the script it replaces. Both are about a key that IS in force, so neither appears while
            there is nothing to be wrong about. */}
        {status?.present && !status.pinGateOn && (
          <Alert>
            <AlertDescription>
              <strong>A key alone is not a lock.</strong> With “Ask for a PIN” off, anyone in range
              can replace this key with their own — and read yours: no command hands a key back, but
              the memory-read command travels on the same channel and the key sits at a known
              address. So this is protecting the broadcast from someone listening passively, and
              nothing more. Turn the PIN on for it to mean more than that.
            </AlertDescription>
          </Alert>
        )}
        {status?.present && !status.advertEncrypted && (
          <Alert>
            <AlertDescription>
              A key is in force but the broadcast is still in the clear. That should not last: the
              radio works this out from the key it holds, so it has not caught up yet. Give it a
              moment, or reconnect.
            </AlertDescription>
          </Alert>
        )}
        {/* NOT SLOTS, and that is a deliberate difference from the PIN above. 32 of them is about
            10 px each on a phone, and this value is PASTED out of Home Assistant rather than typed
            — so what helps is a field that cannot hold anything invalid and says how far along it
            is. Non-hex is dropped as it arrives, so a pasted key with spaces or capitals lands
            clean, and the counter is the whole validation message. */}
        <div className="space-y-2">
          <div className="flex items-baseline justify-between">
            <Label htmlFor="devkey">Key</Label>
            <span
              className={cn(
                'text-xs tabular-nums',
                key.length === KEY_CHARS ? 'text-ok' : 'text-muted-foreground',
              )}
            >
              {key.length} / {KEY_CHARS}
            </span>
          </div>
          {/* THE PLACEHOLDER CARRIES THE ALPHABET AND NOTHING ELSE `[owner]`. The length is already
              on screen in the counter above; the alphabet is the only thing a person can get wrong
              here, because the field drops everything outside 0-9 a-f — so a key with a `g` in it
              lands one short and the counter is the only complaint. */}
          <Input
            id="devkey"
            value={key}
            disabled={busy}
            onChange={(e) => setKey(cleanKey(e.target.value))}
            maxLength={KEY_CHARS}
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="0-9 a-f"
            className="font-mono tracking-wider"
          />
          {/* SAID ONLY WHEN THE FIELD IS FULL. Every prefix of it is all-zero too, so complaining
              from the first `0` would be nagging about the eventual value rather than reporting
              this one — and while it is short the counter is already saying what is wrong. */}
          {key.length === KEY_CHARS && spellsClear(key) && (
            <p className="text-xs text-warn">Can’t be all zeroes</p>
          )}
          {/* THE KEY IS CHOSEN HERE, not fetched from anywhere: this screen SETS it on the
              thermostat, and Home Assistant is where it goes afterwards. Sixteen random bytes are
              not something to invent by hand, so the app offers them. */}
          <Button variant="outline" size="sm" disabled={busy} onClick={() => setKey(randomKey())}>
            <Dices /> Generate a random key
          </Button>
        </div>
        {/* ALL ZEROS IS REFUSED, exactly as the PIN sheet refuses `000000` — it is how "clear" is
            spelled on the wire, so setting it would turn encryption OFF over a field reading 32/32.
            `access.ts`, `spellsClear`. Clearing has its own button below. */}
        <Button
          className="w-full"
          size="lg"
          disabled={!writes || spellsClear(key) || busy}
          onClick={() => send(writes!, key)}
        >
          {busy && <Loader2 className="animate-spin" />}
          {busy ? 'Setting…' : 'Set this key'}
        </Button>
        {/* Destructive because it deletes `[owner]`, and this is the most irreversible of them:
            the thermostat never tells a key back, so removing one that is not written down
            elsewhere loses it. */}
        <Button
          variant="destructive"
          size="lg"
          className="w-full"
          disabled={busy}
          onClick={() => send(clearDeviceKey(), '')}
        >
          Remove the key
        </Button>
      </div>
    </Sheet>
  )
}
