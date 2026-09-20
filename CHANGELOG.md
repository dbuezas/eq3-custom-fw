# What's new

## 2.00 — this firmware

Built on eQ-3's 1.48. Everything the original does, plus the following. You can go back to any eQ-3
version at any time.

Two words used throughout, because the thermostat has two separate secrets:

- **pairing PIN** — the code a phone is asked for before it may connect. Optional, off by default.
- **encryption key** — a 16-byte key you choose. Setting one encrypts the Home Assistant broadcast
  and opens a second, pair-free way in. Also optional.

---

## New and changed menu items

Hold MODE for the settings menu. **Every page and menu item now scrolls its full name**, instead of the
three-letter code you had to learn. The seven stock pages:

| now scrolls | was |
|---|---|
| `ProGrAm` | `Pro` |
| `dAtE` | `dAt` |
| `dAyLIGHt SAVInGS` | `dSt` |
| `oPEn dEtECt` | `AEr` |
| `OFFSEt` | `tOF` |
| `bLuEtOOtH` | `bLE` |
| `rSEt` | `rES` |

Two of those were unguessable: `AEr` was open-window detection, `dSt` was daylight saving.

**Five pages are new:** `bUttonS`, `SCrEEn`, `booSt`, `COntrASt` and `COMFort ECo`.

### `bUttonS` — what each button does

Pick a button — `LEFt`, `CEntEr`, `rIGHt` — then a gesture, `SHort` or `LonG`. Each gesture can be set
to any of:

| action | what it does |
|---|---|
| `AUto-MAnUAL` | step through auto / manual / holiday |
| `ECo-COMFort` | swap between the eco and comfort temperatures |
| `EdIt ECo-COMF` | open the editor for that pair |
| `booSt` | start boost |
| `PAIrInG` | start pairing |
| `SCrEEn` | step the idle display on to the next thing it shows |
| `btHomE` | send the press to Home Assistant as an event, and do nothing locally |

Each gesture offers its own stock action, the button's *other* stock action, `SCrEEn` and `btHomE` —
so the centre button's short press can send an event to Home Assistant instead of starting boost.

Buttons also now report **short press, long press and hold** separately, they act **when you let go**
rather than after three seconds, and COMFORT answers on the **first** press.

### `SCrEEn` — what the display shows when idle

| item | what it shows |
|---|---|
| `tArGEt` | the target temperature — what stock always showed |
| `CurrEnt` | the measured room temperature, labelled `c 23.7` so the two cannot be confused |
| `CLoCK` | the time |
| `vALvE` | how far open the valve is |
| `bAr vALvE` | valve position in the top bar, instead of the weekly schedule |
| `SECondS` | 1 to 9 — how long each is held when more than one is on |

One on its own stays put; several take turns. All off gives you the stock target display back, so you
cannot end up with a blank screen. The wheel moves between the items and the button acts on the one you
are looking at, so you can read the settings without changing them.

### `booSt` — boost settings

- **duration**, shown as a time: `b1:30` is an hour and a half
- **valve opening**, as a percentage

The boost countdown on the main screen is now `mm:ss`, so a long boost can actually be read.

### `COntrASt`

Adjustable, and it shows a **number** instead of spelling its own name at you.

### `COMFort ECo`

The comfort and eco temperatures were only reachable by holding the right-hand button. Now they have a
page of their own too.

### `bLuEtOOtH` — rewritten

Stock showed one word, the wheel did nothing, and the word named what pressing would *do* rather than
how the thermostat was set — so you could not look without changing it. It is now a list you walk with
the wheel, each item showing its current state:

| item | what it does |
|---|---|
| `EnAbLE` | Bluetooth on or off |
| `btHomE` | broadcast readings to Home Assistant, on or off. Off really stops the work, not just the transmission |
| `PIn CodE` | demand the pairing PIN before anything can be read or written. Off by default |
| `PAIrInG` | start pairing now, and show the PIN three digits at a time |
| `unPAIr ALL` | forget every phone that has ever paired. Asks you to confirm |
| `0.5` `1.0` `2.0` | how often the thermostat announces itself, in seconds. `1.0` is the default |

`EnAbLE`, `btHomE`, `PIn CodE` and the announce interval can also be set remotely. `PAIrInG`
deliberately cannot — putting a device into pairing mode is something you do standing at it.

**How often it announces itself is the biggest single thing left that changes battery life.** Pick
`2.0` and the batteries last roughly 30 % longer, but the thermostat takes about twice as long to be
found — by Home Assistant, by a phone, and by this firmware's own tools. Pick `0.5` and it is found
twice as fast and the batteries last roughly 29 % less. The battery figures are calculated, not from a
thermostat that has run a year. Pairing is not affected: the pairing screen always announces itself
quickly, whichever item you pick.

### `oPEn dEtECt` — open window

- `AUto dEtECt` — whether the thermostat decides for itself that a window is open, **on or off**.
  New: there was no way to change this before.
- the **temperature** it drops to and **how long** it holds it — both settable on the thermostat now,
  not only from an app.

A window-open event can also be **sent from outside**, so a door sensor in Home Assistant tells it
directly instead of leaving it to guess from a temperature drop.

### `dESCALInG` — the weekly valve stroke

Every Saturday at noon the thermostat drives the valve pin its full travel so limescale cannot seize
it. It shows `CAL` while it does, and it answers nothing — no app, no Home Assistant — for the whole
minute. This was never explained anywhere and could not be changed.

- **how often** — `7 dAyS` (every week, what it has always done), `28 dAyS` (every 4 weeks),
  `56 dAyS` (every 8 weeks), or `oFF`. The panel has no letter `w`, so the intervals are written in
  days; the stroke always lands on a Saturday, so they are exactly 1, 4 and 8 weeks.
- **`bAtt`** — whether a flat battery holds the stroke back until the batteries are changed. Only
  asked when the stroke is not off. As well as saving the charge, this avoids the batteries dying
  part-way through the stroke, which can leave the radiator stuck fully open.

**Read the trade before choosing `oFF`:** the stroke is what stops the pin sticking when a valve sits
unmoved through a summer. `28 dAyS` still exercises it thirteen times a year and drops about three
quarters of the silent minutes. Turning it off does **not** stop the thermostat adapting to the valve —
it keeps learning from ordinary movement.

### `rSEt` — factory reset

Confirms by spelling `COnFIrm`, the way every other confirmation on the device asks. It now clears the
mod's settings, the pairing PIN and the encryption key along with everything else.

## Home Assistant

- **The thermostat broadcasts its state** — room temperature, target, battery, valve position, and the
  window/lock/boost flags — so Home Assistant sees it with **no pairing, no connection and no app**.
- Those broadcasts can be **encrypted** with your encryption key.
- Values arrive **within a couple of seconds of changing**, without anything holding a connection open.
- Valve position is reported as **a real percentage**, not a rounded step.
- **A door sensor can tell it a window is open**, so it does not have to guess from a temperature drop.
- **Button presses and wheel turns arrive as events**, including while the child lock is on — so a
  locked thermostat works as a remote control for anything in your house.
- Home Assistant can **write text on the display**, longer than the screen, and it scrolls.
- **Brightness, the Bluetooth items, boost duration and boost valve opening can all be set remotely.**
- An app can **ask what the settings are** instead of reading raw memory to find out.
- An app can **be sent the display whenever it changes**, instead of asking over and over — so a
  mirror of the screen keeps up with a button press, and a thermostat nobody is watching is left
  alone.
- **Give a thermostat its own name** so you can tell two apart in a device list.
- **Apple devices can receive data back.** Chrome on a Mac could send but never hear the reply.

## Pairing PIN and encryption key

- **Pairing is off until you switch it on.** No PIN dance to talk to your own thermostat.
- **Set a fixed pairing PIN** if you want one, and **it survives a battery change** — it did not before.
- The PIN also **covers firmware updates**, not just the controls. A lock with an "install anything"
  door beside it would not be a lock.
- **Setting an encryption key is the whole of switching encryption on.** There is no second switch:
  set a key and the broadcast is encrypted and the pair-free encrypted channel opens; set none and
  neither happens.
- **A second, pair-free encrypted channel** — so a computer that holds the key can talk to the
  thermostat without pairing at all.
- **Neither the encryption key nor the pairing PIN can be read back out** of the thermostat.
- **`unPAIr ALL`** throws off every phone that has already paired. Changing the PIN does not do this —
  a paired phone holds a key of its own and is never asked again.

## Battery life

- **Expect roughly 50% longer battery life.** After a battery change the radio used to settle into a
  high-power idle and stay there for the rest of that set of batteries, unless you happened to switch
  Bluetooth off and on again. That is fixed, and it is the single largest saving in this firmware:
  measured on one thermostat at 3.3 V on the bench, against the original firmware, the sleeping current
  falls from 114 µA to 36 µA and the ten-minute average from 204 µA to 137 µA, so a set of batteries
  should last about one and a half times as long. Valve movement is unchanged, so a head that drives a
  lot will see less than a head that does not.
- A thermostat **waiting for its clock to be set** no longer drains its batteries while it waits.
- **Leaving a menu open** no longer costs ten times the normal drain, and every settings screen now
  closes itself when you walk away.
- The radio is **put back to sleep sooner** after each reading, sleeps while a pairing PIN is on
  screen, and the two chips no longer wait on fixed delays for each other.
- The thermostat **stops rewriting settings that have not changed**, at start-up and on every connection.
- The **low-battery warning follows the thermostat's own brown-out point** rather than a fixed number.

## Other display changes

- **Animated version on boot.**
- The settings menu **shows where you are** in the list with a progress bar.
- The clock's **colon blinks once a second**.
- The **whole alphabet** can be drawn now, `W` `X` `Y` `Z` included.
- Turning the wheel **shows you the target temperature**.
- The daylight-saving page shows **how it is actually set**, not what pressing would do.
- A yes/no setting says **`On` or `OFF`** when you save it, instead of the same digit again.
- The thermostat **can beep**.

## Fixes

Things that were wrong in eQ-3's 1.48 and are not any more. This project's own builds have never been
released, so bugs in them are not fixes to anybody — they are not listed.

- The **temperature-offset calibration set over Bluetooth did nothing** — a bug the thermostat has
  always had. Set it from an app and the reading did not move.

## Removed

- The **hidden factory service menu**, and the factory test modes it was the only way to reach.

---

## Before this — eQ-3's own versions

Short, because little of it was visible from the outside. The last eQ-3 release is 1.48.

**1.48** — **the pairing PIN became real**: from here the thermostat actually enforces it, where 1.46
let a host skip it. Also, returning to Auto reloads the scheduled temperature straight away instead of
holding the old one until the next switch-point.

**1.46** — **a real six-digit PIN, but one a host could skip.** Before this the number on the screen
was derived from the thermostat's serial number and checked by the app itself, so anyone who knew the
derivation could work it out. 1.46 made it a genuinely random six digits — but asking for it was a
request the connecting side could simply ignore, which is why ESPHome's Bluetooth proxy and Tasmota
went on working against these thermostats.

**1.20** — apps can **read the stored settings back**: open-window temperature and duration, comfort
and eco temperatures, the calibration offset. Before this they could only be set, never read.

**1.10** — the **valve motor was retuned**: smaller steps, gentler correction, a longer history for
detecting the end stop. Quieter, less mechanical stress, more reliable fitting. Still in use at 1.48.

**1.06** — the valve **anticipates the next scheduled temperature**, easing towards the morning
comfort setting before the switch-point rather than reacting after it.

**1.05** — the earliest firmware here.
