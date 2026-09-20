# Bluetooth protocol

Everything a program needs to talk to an eQ-3 CC-RT-BLE thermostat — enough to build a Home
Assistant integration, a phone app or a script.

This describes **firmware 2.00**, the one in this folder, and eQ-3's own 1.48 alongside it. Every
command table has a `firmware` column saying which of the two has that command — `stock + 2.00`,
`2.00 only` or `stock only` — so the same document works whichever a thermostat is running. The
thermostat answers `cmd 0x00` with its version, so a client can ask before it assumes.

The thermostat has two processors. A **radio** (Broadcom BCM20736) holds the Bluetooth stack; a
**thermostat chip** (STM8) runs the heating logic. They are joined by a short serial line. You never
see that line: you write to the radio and the radio relays. Which chip answers is stated where it
changes what you can expect, and nowhere else.

---

## 1. Three ways to reach a thermostat

| | broadcast | ordinary connection | encrypted connection |
|---|---|---|---|
| firmware | 2.00 only | stock + 2.00 | 2.00 only |
| needs a connection | no | yes | yes |
| needs pairing | no | only if the owner turned the **pairing PIN** on | **never** — the **encryption key** is what lets you in |
| how often | about once a second | on request, plus a push about once a second | on request |
| can it change anything | no | yes | yes |
| hidden from others in range | only once an encryption key is set | only if the pairing PIN is on and you paired | always |
| carries a firmware update | no | **yes, and only here** | no |
| what you get | room temperature, target, battery, valve, flags, button presses | all of that, plus settings, the schedule, and every control | everything the ordinary one carries except a firmware update |

**Read with the broadcast, write with a connection.** That is how the web app in this folder works
and it is what keeps battery drain low: a connection held open costs the thermostat far more than
listening costs you.

**Which connection**: the ordinary one unless you have a reason to use the other. The encrypted one
costs one extra exchange before the first command and fits less into each write, and it gives you two
things the ordinary one cannot:

- **Others in range cannot read what you send**, whether or not the owner set a pairing PIN.
- **It still answers on a thermostat that demands a pairing PIN you do not have.** That is what the
  encryption key is for.

Section 4 has the pairing PIN, section 6 has the encrypted connection. **One encryption key switches
on both that connection and broadcast encryption** — there is no separate setting for either.

**A firmware update cannot be sent through the encrypted connection.** Send `cmd 0xa0` and the `0xa1`
packets that follow it on the ordinary characteristic, even if everything else on that connection is
encrypted. Two reasons:

- **They do not fit.** An `0xa1` packet is a full 16 bytes, and one encrypted write carries only 8
  bytes of command — the other 8 are its header. So every packet would take three writes instead of
  one. The update fires its packets back to back and answers once per chunk, never per packet, so
  nothing slows down to wait: three times as many writes is enough to break it.
- **It would hide nothing anyway.** The radio decrypts each command before passing it on, and these
  are read by the thermostat, not by the radio. They travel the last stretch unencrypted either way.

Section 5.7 is the update itself.

**The radio's own firmware is a third service**, not a command on either characteristic — section 4
lists it. So updating "both chips" means two different mechanisms, and `python-scripts/flash.py` is
what knows the order.

---

## 2. Finding a thermostat

The advertised name is **`CC-RT-BLE`** by default. An owner can give a 2.00 unit its own name, which
is aired as **`eQ3-<name>`** — the radio adds that prefix so a chooser can still filter for it. A
renamed unit no longer matches `CC-RT-BLE`, which is why the eQ-3 app and Home Assistant's own
matcher stop finding it.

**Do not filter on the 128-bit service UUID.** 2.00 drops it from the advertisement to make room for
the broadcast data, so a filter on it finds nothing. Match the name, or match the `0xFCD2` service
data — but note that **a browser cannot do the second one**: Web Bluetooth has no service-data
filter, so a page must match by name. BlueZ and CoreBluetooth clients can use either.

**Do not trust an empty scan.** Hosts differ enormously in how many advertisements they receive. A
macOS machine picks up roughly a tenth of what a Linux Bluetooth adapter does, so "I scanned and saw
nothing" is weak evidence that a thermostat is silent.

---

## 3. The broadcast — BThome v2

Read from the advertisement, with no connection at all. 2.00 ships it **on**, and the owner can
switch it off (`cmd 0x1D` item 1) — in which case the thermostat still advertises, but carries no
`0xFCD2` service data at all. **No sensor data is not the same as not advertising**, and a client
should say which it saw.

### Layout

    service data 0xFCD2:  <device-info> <objects...>

`device-info` is `0x40` plain or `0x41` encrypted — bit 0 is the encryption flag. Objects follow the
BThome v2 spec: each is a one-byte object id, then its value.

### The objects

Three different object sets go out. Two of them alternate, one per advertisement, so at the ordinary
rate you see each about every two seconds. The third is sent only when something happens.

**Set A — the numbers** (sent every other advertisement):

| object id | meaning | encoding |
|---|---|---|
| `0x02` | room temperature | signed 16-bit, ÷100, °C |
| `0x02` | target temperature | signed 16-bit, ÷100, °C — **the second `0x02`** |
| `0x0C` | battery | unsigned 16-bit, ÷1000, volts |
| `0x2F` | valve opening | one byte, 0–100 % |

**Order is load-bearing.** Room temperature and target share object id `0x02` and are told apart
only by which comes first. A decoder that indexes by id alone gets one of the two at random.

**Set B — the flags** (the other advertisement):

| object id | meaning | encoding |
|---|---|---|
| `0x2D` | window open | 1 = open |
| `0x1F` | lock | **inverted** — 1 = *un*locked |
| `0x0F` | boost running | 1 = running |
| `0x15` | battery low | 1 = low |
| `0x09` | mode | 0 auto, 1 manual, 2 holiday |

**Set C — a button or wheel event** (only when one happens):

| object id | meaning | encoding |
|---|---|---|
| `0x00` | packet id | one byte, **constant across the repeats of one event** |
| `0x3A` | BOOST — the **centre** button | 0 nothing, 1 press, 4 long press, `0x80` hold |
| `0x3A` | MODE — the **left** button | same |
| `0x3A` | COMFORT — the **right** button | same |
| `0x3C` | wheel | direction (1 left, 2 right) then step count |

Only one of the four slots is non-zero per event. An event is repeated quickly for a short window,
because a single advertisement is easy for a passive scanner to miss. **The packet id is the same
across every repeat**, so a receiver de-duplicates on it and fires one event, not ten.

**Half your values are always about a second old.** The two sets alternate, so a reader that
timestamps everything with "when the last advertisement arrived" will believe the stale half is
fresher than a value a command reply just corrected. Keep a per-value timestamp.

**An unknown object id must stop the walk, not be skipped.** The id is what gives each object its
length, so guessing past one re-reads every following byte as the wrong field.

### When the broadcast is encrypted

If the owner has set an encryption key, `device-info` is `0x41` and the payload is:

    41 <ciphertext> <counter: 4 bytes LE> <MIC: 4 bytes>

AES-CCM, 128-bit key, 4-byte tag. The nonce is 13 bytes:

    <MAC: 6 bytes> D2 FC 41 <counter: 4 bytes>

That is the device MAC, the service UUID little-endian, the device-info byte, then the counter
exactly as it appears in the payload. The counter goes up by one per encrypted advertisement, which
lets a receiver reject a replayed one — the thermostat only supplies it; rejecting is the receiver's
job.

**A tag mismatch means a wrong key, a wrong MAC or a corrupt advertisement. It never means the
thermostat stopped broadcasting.** Say which.

**On macOS you cannot get the MAC.** CoreBluetooth never exposes a hardware address, so a Mac client
cannot build the nonce from what it scanned. Ask the thermostat for its own MAC with `cmd 0x51 02`
over a connection, once, and remember it.

---

## 4. Connecting

### Services and characteristics

| what | UUID |
|---|---|
| thermostat service | `3e135142-654f-9090-134a-a6ff5bb77046` |
| — command (write) | `3fa4585a-ce4a-3bad-db4b-b8df8179ea09` |
| — replies (notify) | `d0e8434d-cd29-0996-af41-6c90f4e0eb2a` |
| encrypted command (write) | `2e3fa1b0-5a55-4c0d-9e11-0b130a1c0001` |
| encrypted replies (notify) | `2e3fa1b0-5a55-4c0d-9e11-0b130a1c0002` |
| radio version + update service | `9e5d1e47-5c13-43a0-8635-82ad38a1386f` |
| — radio version (read) | `347f7608-2e2d-47eb-913b-75d4edc4de3b` |

The encrypted pair exists only on a 2.00 radio. **Discover it rather than assume it** — absent means
an older radio, not an error.

The radio version record is product id (16-bit little-endian), major, minor. **4.6 is a stock radio,
5.0 is this firmware's.** It is a plain read and answers on both, which is what makes it the way to
ask which radio image is running.

### The pairing PIN

Off by default on 2.00. When the owner turns it on, standard Bluetooth pairing with a six-digit
passkey is demanded, and **every characteristic in the thermostat service refuses an unpaired
central** — reads, writes and notifications alike. The PIN is shown on the thermostat's own screen.

The encrypted pair above is deliberately *not* gated: the encryption key is what lets you in. That is how
a client gets back into a thermostat whose PIN it does not know.

### Writing a command

Write the command bytes to the command characteristic. That is all — no length byte, no checksum, no
framing. **A write may be at most 16 bytes.**

Four rules, each of which has cost somebody a debugging session:

1. **One write in flight at a time.** Send, wait for the reply, then send the next.
2. **Send every argument, including ones you do not care about — send those as `0`.** The radio pads
   a short write out to the length it relays for that id, and it pads with **whatever the previous
   command left in the buffer**. The frame still checksums, so the thermostat runs your command on
   somebody else's bytes.
3. **Retry.** A radio link drops packets. Two or three attempts is normal practice here.
4. **A rejected command looks exactly like a dropped one: silence.** An id this firmware does not
   implement is discarded by the radio and never reaches the thermostat, so there is no reply and no
   error. Do not read silence as a broken device.

### What comes back

Notifications on the reply characteristic. There are three shapes, told apart by the first byte:

| first byte | shape | what it is |
|---|---|---|
| `0x02` | `02 01 <status> <valve%> <ui state> <target>` | the status — see below |
| `0x01` | `01 <version> 00 00 <serial: 11 bytes>` | the answer to `cmd 0x00` |
| `0x01` | `01 <tag> <13 bytes>` | the answer to any 2.00 command |
| `0x21` | `21 <day> <temp,until> × 7` | the answer to `cmd 0x20` |

**`0x01` is used twice and length does not separate them** — both are 15 bytes. The two zero bytes
at offsets 2 and 3 are the discriminator: the info reply always has them, a 2.00 reply has its tag
at offset 1 and real payload after it.

**The `<tag>` says which request a reply answers.** It is the command id for a plain acknowledgement,
and the low byte of the address for a memory read. You need it because the notification channel is
shared: the thermostat's own once-a-second status push arrives on it too.

**Status byte bits:**

| bit | meaning |
|---|---|
| 0–1 | mode: 0 auto, 1 manual, 2 holiday |
| 2 | boost running |
| 3 | automatic daylight saving is on |
| 4 | window open |
| 5 | child lock on |
| 6 | unused |
| 7 | battery low |

`valve%` is already a percentage. `target` is in half-degrees, so divide by 2. `ui state` is where
the thermostat is in its start-up: 4 means running normally.

**The status is both a reply and a push.** Every setting command ends with one, so a command's own
reply already carries the new state and you never need to follow up with a read.

**But the push is not a guarantee, and a client must not wait for one.** It comes from the
thermostat's periodic work, which does not run while the clock is unset or while a fault screen is
up. A thermostat in either state answers commands perfectly and pushes nothing at all. Measured: a
connection held for 15 seconds against a unit with no clock set received zero notifications.

**The room temperature is not in the status reply.** Only the target is. The measured room
temperature reaches a client through the broadcast and nowhere else on this channel.

**The serial number needs 0x30 subtracted from every byte**, and only the first **ten** are the
serial — the eleventh is a different value that changes when the pairing PIN does, so a client that keys a
device on eleven characters re-files the same thermostat under a new identity later.

---

## 5. The commands

**Every table below has a `firmware` column** saying which firmwares have the command, so you never
have to infer it from what an entry does *not* say:

| `firmware` | means |
|---|---|
| `stock + 2.00` | both. Works the same on eQ-3's 1.48 and on this firmware |
| `stock + 2.00 *` | both have the id, but **2.00 changed what it does**. Read the note under the table |
| `2.00 only` | added by this firmware. eQ-3's does not have it |
| `stock only` | eQ-3 had it; 2.00 reclaimed it. Answers as an unknown id here |

**Ask a thermostat which it is running with `cmd 0x00`** — `200` is this firmware, `148` is eQ-3's
last.

**A few `2.00 only` commands are answered by the RADIO rather than by the thermostat chip** —
`0x51`, `0x5B`, `0x52`–`0x54` and the sealed envelope `0x55`–`0x59`. The two chips are updated
together by `flash.py`, so normally this is invisible; it matters only on a half-updated device,
where the thermostat reports `200` and the radio is still eQ-3's. The radio has its own version
characteristic — `5.0` is ours, `4.6` is stock — and its encrypted characteristics are simply
absent on a stock radio, which is the easier test.

**An id a firmware does not implement is dropped by the radio and never reaches the thermostat.** No
reply, no error — the same silence as a lost packet. So check the version once at connect rather
than inferring from silence.

### 5.1 Everyday control

| id | firmware | write | what it does |
|---|---|---|---|
| `0x00` | stock + 2.00 | `00` | Ask for the version and serial. `200` is this firmware, `148` is eQ-3's last |
| `0x41` | stock + 2.00 | `41 <temp×2>` | Set the target temperature, and nothing else. 4.5–30 °C, so `0x09`–`0x3C` |
| `0x40` | stock + 2.00 | `40 <mode<<6 \| sub>` | Set the mode, and optionally a temperature. See below |
| `0x43` | stock + 2.00 | `43` | Jump the target to the stored comfort temperature |
| `0x44` | stock + 2.00 | `44` | Jump the target to the stored eco temperature |
| `0x45` | stock + 2.00 | `45 <0\|1>` | Boost off / on |
| `0x80` | stock + 2.00 | `80 <0\|1> 00` | Child lock off / on. **The flag is the FIRST argument; the second is ignored** |
| `0x30` | stock + 2.00 * | `30 <0\|1>` | Tell the thermostat a window is closed / open. See below |

**4.5 °C reads as `Off` on the glass and 30 °C reads as `On`.** They are ordinary temperatures on the
wire; only the display treats them as words.

**`cmd 0x40` packs two things into one byte.** The top two bits are the mode — 0 auto, 1 manual,
2 holiday — and the low six bits pick a temperature:

| low 6 bits | effect |
|---|---|
| `0` | change no temperature, only the mode |
| `1` | load the stored eco temperature |
| `2` | load the stored comfort temperature |
| `3` | load the stored window-open temperature |
| `9`–`0x3C` | set the target directly, in half-degrees |

So `40 00` is auto with no temperature change and `40 40` is manual with no temperature change.
**Prefer `cmd 0x41` when you only want a temperature** — `0x40` cannot express that without also
stating a mode.

**Holiday mode carries an end date** in four further bytes: `40 8<sub> <day> <year> <half-hours>
<month>`. The web app deliberately does not offer it — a mode that ends at a moment the client did
not show is worse than no control — but it will show a thermostat that is in it. **That byte order is
read out of the firmware and we have not sent one**, so test it before you trust it.

**`cmd 0x30` answers nothing. It is the only control command that does not.** A client waiting for
the usual status reply will time out and report a command that worked as a failure. Read the effect
from the next status push instead.

**On eQ-3's own firmware a commanded window NEVER closes itself, and this is worth knowing before you
build against one.** Stock's `30 01` sets a latch that stops the thermostat ever timing the window
out, so if your close never arrives — automation removed, box rebooted, sensor battery flat — the
valve sits at the window temperature for ever and nothing on the thermostat recovers it. A door
sensor that reports opens reliably and closes unreliably is the normal case, not the unlucky one.

2.00 removes that trap: `30 01` starts a countdown instead, so every window it opens closes by
itself. How long is the owner's stored window duration, not the command's:

| stored duration | `30 01` does, on 2.00 |
|---|---|
| non-zero (default 15 min) | opens, and closes itself after that many minutes |
| **0** | opens and **holds** until you send `30 00` |

So the indefinite hold still exists — but as a setting the owner can see and undo, rather than
something the command can impose.

A stored duration of `0` also switches the thermostat's own automatic detection off, so it means "no
windows on a timer, and a commanded one lasts until I say otherwise".

**`30 00` also clears the temperature history it was opened from**, so a close sticks. Otherwise the
thermostat's own detector would re-arm off the same falling temperature a couple of minutes later.

### 5.2 The weekly schedule

| id | firmware | write | what it does |
|---|---|---|---|
| `0x10` | stock + 2.00 | `10 <day> <temp,until> × 7` | Write one day, or a whole group of days |
| `0x20` | stock + 2.00 | `20 <day>` | Read one day. Answers `21 <day> <temp,until> × 7` |

**Encoding.** `temp` is °C × 2. `until` is minutes from midnight ÷ 10, so `0x24` is 06:00 and `0x90`
is 24:00. Each pair means "heat to `temp` until `until`".

**There are always exactly seven slots and no count field.** A day with four real switch points is
written by repeating the last temperature at 24:00 three more times. Send six pairs where seven fit
and the seventh comes from whatever was left in the device's buffer.

**Day 0 is Saturday**, then Sunday, Monday … Friday.

**A write takes a day group; a read does not:**

| day byte | `0x10` writes | `0x20` reads |
|---|---|---|
| `0`–`6` | that day | that day |
| `7` | days 0–1 (the weekend) | day 0 only |
| `8` | days 2–6 (the weekdays) | day 2 only |
| `9` | all seven days | day 2 only |

So setting a whole week is **one** command, and loading a week is **seven reads**. A client that
reads `20 09` once and calls it "the week" shows one day's programme as all seven. A group read also
echoes back the group byte you sent, not the day the data came from.

**A written programme does not take effect until the next switch point.** In auto mode, writing a
flat 23 °C week leaves the current target where it was. The programme is stored immediately and
consulted at the day's next change. A client that says "sent" without saying that is describing a
device that appears to have ignored it.

**The firmware validates nothing here.** Temperatures are masked and times are copied through
untouched, so every constraint is the client's.

### 5.3 Stored settings

| id | firmware | write | what it does |
|---|---|---|---|
| `0x11` | stock + 2.00 | `11 <comfort×2> <eco×2>` | Set the comfort and eco temperatures |
| `0x13` | stock + 2.00 * | `13 <offset×2 + 7>` | Temperature calibration offset, −3.5 to +3.5 °C. Takes effect at once |
| `0x14` | stock + 2.00 | `14 <temp×2> <duration÷5>` | Window-open temperature, and how many minutes it holds |
| `0x0E` | 2.00 only | `0E <minutes> <valve%>` | Boost duration and how far the valve opens |
| `0x15` | 2.00 only | `15 <mask> <seconds>` | What the idle screen shows, and how fast it rotates. See below |
| `0x1A` | 2.00 only | `1A <1..8>` | Screen brightness, applied live. `0` restores the factory level |
| `0xe0` | 2.00 only | `e0 <0\|1>` | Automatic window detection: `1` = the thermostat may decide for itself |
| `0x17` | 2.00 only | `17 <0..3> <0\|1>` | How often the descaling run happens, and whether a flat battery holds it back. See below |
| `0x16` | 2.00 only | `16` | **Read every setting above in one command.** See below |

**`0xe0` is a stock id whose stock handler cannot be reached** — so 2.00 took the id over. Sending it
to a thermostat on eQ-3's firmware changes nothing. Why the handler is unreachable there, we do not
know; that it is, is read out of the machine code.

**`0x11`, `0x13` and `0x14` answer with a STATUS reply, not a tagged one** — they are eQ-3's own
commands and predate the tag. A client that waits for `01 11` will wait out every retry and then
report a write that worked as a thermostat that did not answer. The rest of this table answers
`01 <id>`.

**On eQ-3's own firmware, `cmd 0x13` writes the cell and changes nothing.** The reading is corrected
from a copy in memory that stock never updates, so the offset only takes effect after a restart. 2.00
fixes it and applies it at once.

**`cmd 0x17` sets the descaling run.** Every Saturday at noon the thermostat drives the valve pin its
full travel so limescale cannot seize it. It shows `CAL` while it does, and it answers no commands for
the whole minute. The first argument is how often: `0` every week, which is what the thermostat has
always done, `1` every 4 weeks, `2` every 8 weeks, `3` never. The second is whether a flat battery
holds it back: `0` run it anyway, `1` skip it. The two are independent, and with the run off the
second has nothing to act on. Skipping on a low battery does more than save the charge: the run
drives the pin to both end stops, so a pack that dies part-way through can leave the valve wherever
the motor stopped, including fully open.

Which Saturdays `1` and `2` pick is the thermostat's own week count — days since 2000 divided by 7 —
so a client cannot predict them from the calendar alone, and setting the clock changes which ones they
are.

It answers `01 17 <how often> <battery>` with the values the thermostat now holds, so a client reads
back the device and not its own request. An argument out of range refuses the whole command with
`01 17 FF FF` and writes neither value.

**`3` (never) trades one thing, and it is mechanical: a valve pin that sits unmoved through a summer
can stick with limescale, and this stroke is what prevents it.** It does **not** stop the thermostat
adapting — ordinary valve movement keeps every value the regulation loop reads up to date. `1` still
exercises the pin thirteen times a year and drops about three quarters of the minute-long silences.

**`cmd 0x16` is how you read settings — do not read memory.** It answers `01 16` then 13 bytes, and
**every byte is in the units of the command that sets it**, so a client can echo one straight back:

| offset | value | set by |
|---|---|---|
| 0 | comfort temperature, half-degrees | `0x11` arg 0 |
| 1 | eco temperature, half-degrees | `0x11` arg 1 |
| 2 | calibration offset + 7, half-degrees | `0x13` |
| 3 | window-open temperature, half-degrees | `0x14` arg 0 |
| 4 | window-open duration, five-minute units | `0x14` arg 1 |
| 5 | boost duration, minutes | `0x0E` arg 0 |
| 6 | boost valve opening, percent | `0x0E` arg 1 |
| 7 | idle-screen mask | `0x15` arg 0 |
| 8 | idle-screen rotation, seconds | `0x15` arg 1 |
| 9 | screen brightness, 1–8 | `0x1A` |
| 10 | window auto-detect, 1 = it may decide | `0xE0` |
| 11 | descaling run, how often | `0x17` arg 0 |
| 12 | descaling run, 1 = a flat battery holds it back | `0x17` arg 1 |

**A setting the owner has never changed reports its default, not zero.** So a factory-fresh
thermostat answers with the values it is really running. The two descaling bytes are the exception
that needs no rule: `0` is a real value for both, and it is what a factory-fresh thermostat does.

**Thirteen bytes fills the reply exactly.** A fourteenth setting will need a second command, not a
longer answer.

**The pairing PIN and the encryption key are deliberately not here.** Neither can be read back out
of the thermostat, ever.

**The idle-screen mask:** bit 0 target, bit 1 room temperature, bit 2 clock, bit 3 valve percent. No
bits set falls back to the plain target screen; one bit pins that screen; several take turns at the
rotation period.

**Bit 4 is not a screen, and a client rewriting this mask must preserve it.** It chooses what the
24-slot bar across the top of the display shows — `0` the weekly schedule, `1` the valve position. A
client that rebuilds the mask from the four screen bits alone silently switches the valve bar off.

### 5.4 The clock

| id | firmware | write | what it does |
|---|---|---|---|
| `0x03` | stock + 2.00 | `03 <yy> <mm> <dd> <hh> <mi> <ss>` | Set the date and time |

**Send plain local wall-clock time.** The thermostat does not shift what you give it. If automatic
daylight saving is on, it moves its own clock at the European boundary — which is what your local
time does too, so there is no second adjustment to make.

**It validates nothing, and the host must.** Bad fields are not cosmetic:

- **A month above 12 is accepted and is durable.** The clock tidies the other fields within a minute
  but never the month, and the weekday is then looked up in a 12-entry table, so months 13–15 give a
  garbage weekday.
- **In auto mode the weekday picks the day of the weekly programme**, so a wrong one silently runs
  the wrong day's schedule for up to a month.
- **An hour out of range has corrupted a target temperature** through the same lookup.

**This is also what gets a thermostat past its date-entry screen after a firmware update** — and
until it is past that screen, the periodic work is stalled, so no status pushes and no live sensor
values.

**The first command after a reset is routinely swallowed.** Start-up busy-waits with the serial line
unserviced, for anything from nothing to about a minute depending on where the valve plunger sits.
Re-send until the thermostat leaves the date-entry state rather than waiting a fixed time.

### 5.5 Display and sound

| id | firmware | write | what it does |
|---|---|---|---|
| `0x0F` | 2.00 only | `0F <g0..g8> <hold> <icons: 2> <bar: 3>` | Paint the display: 9 characters, an icon mask, a bar mask |
| `0x23` | 2.00 only | `23 <mode>` | Read the display as it actually is, or subscribe to it. Answers `01 23 <13 bytes of segments>` |
| `0x1B` | 2.00 only | `1B <0..3>` | Play one of the four canned sounds on the valve motor |

**`cmd 0x0F` is the widest command the thermostat has** — 16 bytes exactly, the maximum a write can
carry.

**`cmd 0x23`'s argument says HOW, not what** — there is only one display, so the mode chooses between
one answer and a subscription:

| mode | what it does |
|---|---|
| `23 00` | answer once |
| `23 01` | **send the display whenever it changes**, for the next 10 seconds — and answer once now |
| `23 02` | stop sending |

**`23 01` is a LEASE, not a switch: renew it about every 5 seconds** or it lapses. The thermostat is
never told you hung up, so a subscription that never expired would leave it talking to nobody for the
rest of its battery.

**Renew well inside the ten seconds if you can.** Two renewals at five seconds fill the lease
exactly, so a single lost one lands on the moment it expires — the subscription re-arms on the next
renewal either way, but the display stops updating for a few seconds first.

**Every renewal answers as well**, so a push you never received is repaired at the next one and you
need no polling of your own. Pushes arrive as the same `01 23 …` frame, unsolicited, at most one
every half second. Send `23 02` when you stop watching.

The display is always the same thirteen bytes and one reply carries all of them, so a screen is read
in a single round trip and cannot be sampled across a repaint. Each bit is one segment: bit `n` is
bit `n & 7` of byte `n >> 3`.
Which bit draws which segment is in
[`webapp/src/device/lcd_tables.ts`](webapp/src/device/lcd_tables.ts), generated out of the firmware
image so it cannot drift.

Reading the panel this way needs no memory address. `cmd 0x18` in section 5.8 can return the same
bytes, but it is a raw-memory read and a development build is the only place to rely on one.

**Nine characters, always.** `hold` is in half-seconds; `0` cancels now and `0xFF` holds until
cancelled. Character codes are in
[`webapp/src/device/lcd_tables.ts`](webapp/src/device/lcd_tables.ts) (`GLYPHS`), which is generated
out of the firmware image so it cannot drift. `255` is a blank.

**Scrolling is not a mode.** The firmware trims the trailing blanks and, if more than four characters
are left, walks a four-character window across them and repeats. Four or fewer is static. So
**trailing spaces are indistinguishable from padding and are trimmed**; leading ones survive, so
right-aligning a short message still works.

**The top two bits of the icon mask are the scroll speed**, not icons: `00` is 1.0 s per step (the
sensible default for a client that knows nothing about the field), then 0.5 / 1.5 / 2.0 s.

**A message is always accepted and never refused for what is on the glass.** Whether it becomes
visible is decided separately — a message pushed during a boost, a fault or start-up is stored and
shown only if its hold outlives whatever owns the display.

**`cmd 0x1B`'s four sounds:** `0` a blip, `1` a trill (about a second — the one to find a radiator
with), `2` a fanfare, `3` a scale. Anything else plays the blip rather than nothing, so a wrong
number is audible instead of looking like a dead feature.

**The reply follows the sound.** The thermostat plays first and answers after, because the tone masks
interrupts. Your read timeout must cover the longest sound, about a second, and the device answers
nothing during it.

### 5.6 Bluetooth, the pairing PIN, the encryption key and the name

| id | firmware | write | what it does |
|---|---|---|---|
| `0x1d` | 2.00 only | `1D <item> <0\|1>` | Flip one of the Bluetooth switches. Answers `01 1D <item> <stored value, or 0xFF refused>` |
| `0x1e` | 2.00 only | `1E <d5d4> <d3d2> <d1d0>` | Set the pairing PIN, packed BCD. Answers `01 1E <0 ok, 0xFF refused>` |
| `0x1f` | 2.00 only | `1F A5` | Forget every paired phone. Answers `01 1F <0 ok, 0xFF refused>` |
| `0x22` | 2.00 only | `22 <0..3>` | How often the thermostat announces itself; `0` just reports. Answers `01 22 <what it is set to, or 0xFF refused>` |
| `0x51` | 2.00 only | `51 00 <off> <k×8>` · `51 01 A5` · `51 02` | Set, clear or report the encryption key |
| `0x5b` | 2.00 only | `5B 00 <off> <b×8>` · `5B 01 <len> A5` · `5B 02` | Set, clear or report the advertised name |

The last two are answered by the **radio**, not the thermostat chip, so they need the 2.00 radio image
even on a thermostat already running 2.00. A stock radio drops them and says nothing.

**`cmd 0x1D` items:**

| item | what it does |
|---|---|
| 0 | Bluetooth on or off |
| 1 | broadcast the readings, on or off |
| 2 | demand the pairing PIN before anything can be read or written |
| 3 | **refused, always** — starting pairing is something a person does standing at the thermostat |

**`1D 00 00` takes the radio down and you may not get a reply.** The way back is the Bluetooth page
on the thermostat itself. **`1D 00 01` is the useful direction** — it also clears the flag that would
otherwise leave the radio dark at its next start-up.

**`1D 02 01` gates the link it arrived on, deliberately.** It does not disconnect you; it makes the
connection useless. Everything on the thermostat service then answers *Insufficient Authentication*.
That is the stronger form — a client cannot opt out by declining to reconnect.

**A gated thermostat is still reachable.** Three ways back: a *paired* central sending `1D 02 00`
(the pairing PIN is on the thermostat's own screen); the Bluetooth page on the glass; or the
encrypted channel, if you hold the encryption key — which is exactly what that key is for.

**Turning the gate on survives a battery change.** The setting lives in the radio's own memory and is
restored before the first connection of a start-up can write anything.

**`cmd 0x22` — how often the thermostat announces itself.** The argument picks one of three:

| send | interval | battery | how long you wait for it to appear |
|---|---|---|---|
| `22 01` | about half a second | roughly 29 % shorter life | about half as long |
| `22 02` | about one second — **the default** | as it ships | as it ships |
| `22 03` | about two seconds | roughly 30 % longer life | about twice as long |

The battery figures are calculated from a measured model, not from a thermostat that has run a year.
The same three are on the thermostat's own Bluetooth page, drawn as `0.5` / `1.0` / `2.0`.

**`22 00` READS IT WITHOUT CHANGING IT.** `0` is the "never been set" value and can never pick an
interval, so it is free to mean "just tell me": the thermostat answers with what it is set to, writes
nothing and tells its radio nothing. That is how a client that has only just connected learns the
setting.

**The answer is always 1, 2 or 3 — never `0`.** A thermostat that has never been told keeps the
default and answers `2`. Anything above `3` is refused with `0xFF` and changes nothing.

**`cmd 0x16` does not carry this setting** — that reply is already full — so `22 00` is the way to read
it. **Pairing is not affected**: the pairing screen advertises at its own fixed, faster rate whichever
one you pick.

Both firmware halves are needed. With a stock radio the command never reaches the thermostat chip at
all, so nothing answers — the radio is what carries a 2.00 command id across, and it is also what
applies the interval.

**`cmd 0x1E` is packed BCD, most significant pair first**, so `1E 12 34 56` means the PIN 123456.
Every nibble must be a decimal digit or the whole command is refused. **All zeros means "forget the
stored PIN"**, so `000000` cannot be chosen. It survives a power cycle.

**Changing the pairing PIN does not unpair anything.** A phone that has already paired holds a
long-term **bonding** key and is never asked for the PIN again. `cmd 0x1F` is what throws those off,
and the `A5` is a guard byte, not a parameter — a bare `1F` is refused. **Nothing is disconnected**: a
live link keeps working on a session key already agreed, and what has gone is the bonding key the
*next* connection would have used.

**Those are Bluetooth's own pairing keys, not the encryption key below.** `cmd 0x1F` does not touch
`cmd 0x51`'s key and does not affect the encrypted channel or the broadcast — a client holding the
encryption key is unaffected by a re-pairing, which is the whole point of it.

**`cmd 0x51` — the encryption key.** Three writes: stage the low half (`off` 0), stage the high half
(`off` 8), then apply. Sixteen zero bytes is how "clear" is spelled. `51 02` reports without changing
anything. Both `51 01` and `51 02` answer
`51 <sub> <key in force> <advert encrypted> <store read> <flags> <result> <device MAC × 6>` —
**and that MAC is how a macOS client learns the address it cannot scan.**

**Setting a key is the whole of switching encryption on.** There is no second switch: with a key, the
broadcast is encrypted and the encrypted channel starts accepting frames; with none, neither happens.
**The key can never be read back out.**

**`cmd 0x5B` — the advertised name.** Stage in 8-byte halves, apply with the length; `len 0` clears
it and the thermostat goes back to `CC-RT-BLE`. Every arm answers
`5B <sub> <result> <max bytes> <the name now in force>`, where the name's length is the
notification's own and the maximum is in the reply rather than fixed here. The count is **UTF-8
bytes, not characters**. `result` is 0 stored, 1 those bytes may not be aired, 2 the store refused —
and because the name is read back out of the buffer the advertisement is built from, a refused write
comes back as the *old* name.

**The new name reaches the air only after you disconnect.** A connected peripheral advertises
non-connectable, which is not scannable, so no scan response goes out at all while anything is
connected. Measured: renamed over a held link, first heard on the air about five seconds after the
disconnect. **The GATT `Device Name` attribute updates at once**, so a connected client sees it
immediately.

### 5.7 Reset and firmware update

| id | firmware | write | what it does |
|---|---|---|---|
| `0xf0` | stock + 2.00 * | `F0` | Factory reset, then restart |
| `0xa0` | stock + 2.00 | `A0` | Enter update mode — hands the link to the bootloader |

After `0xa0` the thermostat's normal firmware is gone and its resident bootloader — the UBC — owns
the link, so one id is answered by the bootloader and not by the application at all:

| id | write | answered by | firmware | what it is |
|---|---|---|---|---|
| `0xa1` | `A1 <seq> <14 bytes>` | UBC | stock + 2.00 | one update data packet |

**A transfer in progress cannot be stalled by anything the application does**, because the
application is not running — the bootloader is. Whatever makes the thermostat stop answering ordinary
commands (the Saturday descaling run, a fault screen, an unset clock) cannot reach a transfer. Only
the `0xa0` that *starts* it is an ordinary command, and can be swallowed like any other. Re-send it.

#### The three verdicts, and what to do about each

Send a chunk as its `0xa1` packets, then read **one** verdict:

| verdict | meaning | do |
|---|---|---|
| `a1 22` | chunk accepted | send the next one |
| `a1 33` | chunk rejected | **send the same chunk again** |
| `a1 44` | the update is complete | stop; the thermostat restarts itself |

**`a1 11` is not a verdict.** It is a per-*packet* receipt. Counting one as a chunk answer shifts
every later verdict by one and desyncs the stream into rejections no retry can clear. Ignore anything
that is not one of the three above and keep listening.

**A rejection does not cost you the transfer — resend the chunk, do not start the image over.** The
bootloader checks a CRC over each frame and only decrypts it once that passes, so a frame it rejected
never advanced the decryption chain: it is still waiting for that same frame. Both clients here retry
a chunk up to three or four times before giving up, and a failed *write* is retried the same way for
the same reason.

**Measured, not assumed.** One bit was flipped in the body of chunk 5 of a 236-chunk image and the
chunk sent: the thermostat answered `a1 33`. The unmodified chunk was then sent again on the same
connection and answered `a1 22`, and the remaining 230 chunks went through to `a1 44` in 60 s. The
image booted and ran. So one corrupt chunk costs one chunk, and recovery needs no reconnect and no
restart of the update.

**Do not retry by re-entering the bootloader over and over.** It keeps a boot-attempt counter and
treats the fourth entry differently from the first. Retrying a chunk costs nothing; restarting the
whole update repeatedly is not the same thing.

**A factory reset takes the radio off the air, by either route** — this command or the reset page on
the thermostat. It comes back dark and stays dark. `1D 00 01` brings it back if you can still reach
the device. Assume a reset costs you Bluetooth.

**On 2.00 a reset clears the radio's secrets too** — the pairing PIN and the encryption key — and
leaves the PIN gate on, its default, so a reset unit is not left enforcing the previous owner's
choice with their PIN gone. The new owner reads the fresh PIN off the glass. It also clears the
settings 2.00 added. Stock's reset reaches neither.

**Updating the firmware is not something to build from this section.** `python-scripts/flash.py` in
this folder does both chips in one connection, in the right order, and checks the images first.
Flashing the radio drops the link you are using, which is why the thermostat chip always goes first.

### 5.8 Advanced — the debug surface

These exist and work, but they read and write raw memory. Nothing an owner does should need them, and
addresses move between firmware releases. Use `cmd 0x16` for settings.

| id | firmware | write | what it does |
|---|---|---|---|
| `0x19` | 2.00 only | `19 <what> <hold>` | Press a button or turn the wheel, as if a person had. `hold` is half-seconds, 1–20; `0` is a tap |
| `0x18` | 2.00 only | `18 <aH> <aL> <n>` | **Development only.** Read up to 13 bytes of thermostat memory in one round trip. Answers `01 <aL> <bytes>` |
| `0x04` | 2.00 only | `04 <aH> <aL> <v>` | **Development only.** Write one byte of thermostat RAM |
| `0x0a` | 2.00 only | `0A <aH> <aL>` | **Development only.** Call a routine at that address |
| `0x52` | 2.00 only | `52 <a0 a1 a2> <n>` | **Development only.** Read radio memory |
| `0x53` | 2.00 only | `53 <a0 a1 a2> <n> <b×n>` | **Development only.** Write radio memory. No reply |
| `0x54` | 2.00 only | `54 <a0 a1 a2>` | **Development only.** Call a radio routine. No reply |

**`cmd 0x04` writes RAM only. On stored settings it acknowledges and does nothing** — it echoes your
byte while the cell keeps its old value, which is indistinguishable from a successful write. Use the
command that owns the setting.

**`cmd 0x19` codes:** `01` BOOST (centre), `02` MODE (left), `03` COMFORT (right), `04` wheel one step
clockwise, `05` one step anticlockwise, `00` release now.

Set the top bit to hold several at once, one bit per button — bit 0 BOOST, bit 1 MODE, bit 2 COMFORT.
So `19 86` is MODE + COMFORT, the **left + right** child-lock grip, which is the one gesture a single
button cannot express.

**`cmd 0x19` has side effects worth knowing.** A long hold of **BOOST** is the pairing gesture, which
also switches the broadcast off and the PIN gate on. The way back is `1D 01 01` then `1D 02 00`, in
that order.

**The six `Development only` ids above are one switch, and it covers both chips.** A development
build answers all six. A release build answers none of them: `0x18`, `0x04` and `0x0a` come back as
the thermostat's plain "id I do not know" refusal, and `0x52`–`0x54` come back as nothing at all,
because the radio no longer listens for them. **`cmd 0x19` is the one thing here that works on
both** — it is an input rather than a memory access, and the buttons of the screen mirror are a
shipped feature. Reading the screen is `cmd 0x23` in section 5.5, which needs no address and is not
behind the switch. To ask which build a thermostat is running, use the radio peek —
it only reads: `52 00 00 20 01` answers one byte on a development build and nothing on a release one.

### 5.9 Reserved — do not send

All five are eQ-3's ids. They are listed because an id claimed here is an id nothing else may take,
not because you would ever send one.

| id | firmware | why it is listed |
|---|---|---|
| `0x12` | stock only | on eQ-3's: acknowledges with a trailing `0xE3` byte and changes nothing. 2.00 reclaimed it |
| `0x60` | stock only | on eQ-3's: the same, with a trailing `0xE4`. 2.00 reclaimed it |
| `0xe1` | stock only | on eQ-3's: blanks the display, shows code `0x14` for about 1.5 s, then redraws. 2.00 reclaimed it |

**What those three were for, we do not know.** The descriptions above are read out of eQ-3's machine
code — what the handlers do, not what they were meant for. We have no documentation from eQ-3, and
none of the three writes any state you could use.

**Do not confuse command id `0xff` with the factory test mode.** There is a dangerous `0xFF`, and it
is a different thing in a different direction: a frame type the *thermostat chip* sends to the
*radio*, which turns the radio's watchdog off, puts it in end-of-line production test and makes it
advertise its serial instead of its service. A phone cannot send it — it is not a command — and 2.00
removed both ends, the thermostat routine that emitted it and the radio arm that acted on it. On a
stock device the hazard is corruption: one wrong byte after a frame marker is executed as a frame
type, and that arm is live. Command id `0xff` above is unrelated and does nothing on either
firmware.
| `0xff` | stock + 2.00 | dead on both — rejected by the length gate before it is dispatched |
| `0x90` | stock + 2.00 | internal on both — the radio hands the pairing PIN up to the thermostat with it |

---

## 6. The encrypted channel

**All of this is `2.00 only`**, and the radio is the chip that implements it — so `0x55`–`0x59` do not
exist on a stock radio, and neither do the two characteristics they ride on. That absence is how you
detect it.

A second command characteristic that accepts nothing but encrypted frames. **The encryption key is
what lets you in** — there is no pairing — and this is the door that still works on a thermostat that
demands a pairing PIN.

**A firmware update does not come through here**, whatever else a connection is sealing: section 1
says why, and section 5.7 is the update itself.

This exists so a client can control a thermostat without the broadcast, the target or the schedule
being readable by anyone in range. **The command id stays inside the ciphertext**: to set a
temperature you send `0x55` on the outside and `0x41` on the inside.

**The four bytes below are not command ids.** They are the first byte of a write to the encrypted
characteristic, which accepts nothing else, so they take nothing from the id space above.

| first byte | firmware | the whole write | what it carries |
|---|---|---|---|
| `0x56` | 2.00 only | `56` | nothing. It **asks**: the reply is this connection's 8-byte nonce, in the clear |
| `0x55` | 2.00 only | `55 <seq:2> <mic:4> <n> <ciphertext×n>` | a whole sealed command, `n` ≤ 8 — the header takes 8 of the 16 bytes |
| `0x57` | 2.00 only | `57 <off> <n> <b×n>` | part of a command too long to send whole, staged at `off` in a 16-byte buffer |
| `0x58` | 2.00 only | `58 <seq:2> <mic:4> <n>` | nothing more. It **opens** what `0x57` staged, `n` ≤ 16 |

Replies come back on the encrypted notify characteristic, and reuse two of the same markers:

| first byte | firmware | the notification | what it means |
|---|---|---|---|
| `0x59` | 2.00 only | `59 <ctr:2> <ciphertext> <mic:4>` | a fragment with **more to follow** — open it, hold it, wait |
| `0x55` | 2.00 only | the same shape | the last, or only, fragment. Open it and deliver |

A reply is split because a notification may not exceed 21 bytes. The counter is per connection and
rises once per notification, which is what lets a reader tell a lost fragment from the next reply.

`0x56` is the only bootstrap a client needs, and it is deliberately a question rather than something
you set: nothing a host sends draws a new nonce, because that would reset the replay counter with it.
`0x57` needs no authentication because it only fills a buffer — the tag checked at `0x58` covers
every byte of it.

**With no key stored, this characteristic refuses everything, `0x56` included.** Silence there means
"use the ordinary one".

**A wrong key does not fail quietly: the write itself is refused at the Bluetooth layer**, and the
refusal reads as an error about the wrong thing. `bleak` reports `Invalid Handle`, which looks like a
missing characteristic or a permission problem and is neither. Two consequences:

- **Do not read it as a length or permission problem.** The refusal is identical for a 9-byte frame
  and a 16-byte one, and every length is accepted when the frame is a `0x56`.
- **A client can tell a wrong key from a missing one, and should say which.** A key changed on the
  device and not in the client is the ordinary case.

**Changing the key over this channel moves the key mid-exchange.** The radio builds the `0x51` report
*after* the new key is live, so the apply goes out under the old key and its answer comes back under
the new one. A client that opens replies with the key it sent under will fail to open that one, and a
key change that worked perfectly then reads as "no reply". Seal with the key in force; open with the
key you just installed.

**And clearing the key over this channel answers nothing at all** — with no key left there is nothing
to seal a report under. **The channel refusing you afterwards is the confirmation.** Verify a clear on
the ordinary characteristic, which is unaffected.

---

## 7. Traps

Every one of these has cost somebody real time. They are stated where they belong above; this is the
checklist.

| trap | what it looks like |
|---|---|
| Silence after a command | Could be a dropped packet, an id this firmware does not have, or `cmd 0x30`, which never answers |
| A scan that finds nothing | Weak evidence. Some hosts receive a tenth of what others do |
| No `0xFCD2` in the advert | The broadcast is switched off, not the device. Say so; do not keep showing old readings |
| Half the broadcast values are stale | Normal — two sets alternate. Timestamp each value, not the advertisement |
| `0x1F` looks inverted | It is. BThome calls it "lock"; 1 means *un*locked |
| Two `0x02` objects | Room temperature first, target second. Order is the only thing telling them apart |
| A setting write times out | `0x11`, `0x13` and `0x14` answer with a status reply, not a tagged one |
| A window never closes | On stock, `30 01` latches for ever and only `30 00` clears it. 2.00 times it out |
| A stock id behaves differently | The id is stock; the behaviour may not be. `0x30`, `0x13` and `0xf0` each changed in 2.00 |
| An update dies at the first chunk, every time | `a1 11` was counted as a chunk verdict. It is a per-packet receipt; the stream is one reply out of step |
| A rejected chunk | Resend that chunk. It does not cost you the image — the bootloader never advanced past it |
| A written schedule does nothing | It applies at the next switch point, not on receipt |
| `20 09` returns one day | Group reads select which day answers. A week is seven reads |
| A week write loses a slot | There are always seven; repeat the last temperature at 24:00 |
| The serial is gibberish | Subtract `0x30` from every byte, and take ten, not eleven |
| A 2.00 reply read as a version | Both start `01` and both are 15 bytes. Check the two zero bytes |
| `Invalid Handle` on the encrypted channel | Wrong encryption key, or none stored. Not a missing characteristic |
| A firmware update crawls, or dies part way, on an encrypted connection | Its packets were encrypted. Send them on the ordinary characteristic — a 16-byte packet does not fit in one encrypted write, and splitting each into three breaks the timing the update depends on |
| No status pushes at all | The clock is unset or a fault screen is up. Commands still work |
| A command ran on the wrong bytes | A short write was padded from the previous command's buffer. Send every argument |
| The renamed device still airs the old name | Renaming reaches the air only after you disconnect |
| Nothing answers on a Saturday at noon | The weekly descaling run — it drives the valve pin its full travel so limescale cannot seize it — holds the thermostat for about a minute and the receive path is not serviced. Commands are not answered; the radio keeps advertising, so it looks wedged. Re-send |

---

## 8. Working examples

The two clients in this folder both implement everything above, and are the reference when this
document is ambiguous:

- **[`webapp/src/device/`](webapp/src/device/)** — TypeScript. `protocol.ts` has the UUIDs,
  `commands.ts` and `config.ts` build frames, `status.ts` and `schedule.ts` decode replies,
  `bthome.js` decodes the broadcast, `sealed.ts` is the encrypted channel.
- **[`python-scripts/flash.py`](python-scripts/flash.py)** — Python, and the firmware update path
  end to end.
