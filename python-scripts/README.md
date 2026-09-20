# The scripts

Two programs. One installs firmware over Bluetooth; the other gets Bluetooth working again when it
has stopped. Most people only ever need the first, and most people do not need either — the
[web page](https://dbuezas.github.io/eq3-custom-fw/) does the same install with nothing to set up.

Reach for these when the page cannot help: no Chrome, no Bluetooth in the browser, a machine with no
screen, several thermostats to do in a row, or a radio that no longer answers at all.

## Setting up

```sh
pip install -r requirements.txt
```

Python 3.9 or newer. On Linux you may need to be in the `dialout` group to use a serial adapter —
log out and back in after adding yourself.

## `flash.py` — install firmware

```sh
python3 flash.py --list                    # which thermostats are in range
python3 flash.py <device>                  # install the newest version
python3 flash.py <device> --versions       # what is on offer
python3 flash.py <device> --release 1.48   # go back to an original eQ-3 version
```

`<device>` is whatever `--list` prints for that thermostat: a UUID on macOS, a MAC address on Linux.
You can save a name for one in `~/.config/eq3-firmware-mod/devices.json` and use that instead.

**It does both chips, in one connection, in the right order, and there is no option to do one.** A
thermostat is two processors that have to agree about what they say to each other, so a version means
both images or neither. Between the two it waits for the thermostat's own bootloader to confirm it
took the image, and stops without touching the radio if it did not.

A few minutes is normal. **The connection dropping at the very end is success, not failure** — the
radio applies its image and restarts, which kills the link it was being flashed over.

Afterwards the thermostat asks for the date and does nothing until it has one. Set it from the page,
from eQ-3's own app, or from Home Assistant. That is normal.

## `ble_chip_via_uart.py` — when Bluetooth stops answering

**Try this first.** Take the batteries out, put them back, then hold **BOOST** on the main screen
until it reacts. Bluetooth can be switched off on the thermostat itself, and that button turns it
back on. It costs a minute and no tools.

If the radio is still silent, this script talks to it down a wire instead. You need the case open and
a USB-to-serial adapter on the board's **PRG2** header:

| PRG2 pin | what it is | connect to |
|---|---|---|
| 1 | 3.3V | **nothing** |
| 2 | GND | adapter GND |
| 3 | radio RX | adapter **TX** |
| 4 | radio TX | adapter **RX** |
| 5 | VCC | **nothing** |

Hold the board so the `PRG2` text reads the right way up; pin 1 is then on the left. 115200 baud,
8N1. **Do not wire pins 1 or 5** — the batteries power the board, and a second supply stops the next
part working.

```sh
python3 ble_chip_via_uart.py dump    -p /dev/ttyUSB0 -o eeprom_backup.bin
python3 ble_chip_via_uart.py recover -p /dev/ttyUSB0
```

**It will ask you to pull a battery.** The chip's boot ROM listens only in a short window just after
power arrives, so the script calls out while you take a battery out, wait about two seconds, and put
it back. One pull covers the whole run.

`recover` writes into the slot the chip is *not* running and checks every byte before switching to
it, so a write that fails halfway leaves the chip booting what it had. Then unplug the wires, close
the case, and `flash.py <device>` finishes the job over Bluetooth as normal.

The image it installs is built to be found: it advertises twice a second, and it advertises even if
Bluetooth was switched off on the thermostat. It is meant to be replaced — run `flash.py` as soon as
the radio answers.

`python3 ble_chip_via_uart.py --help` lists the rest. **`flash` overwrites the whole chip including
its Bluetooth address**, so use it only to restore a dump from that same thermostat; `flash-fw`
writes only firmware and leaves the identity alone.

## If something goes wrong

**A failed transfer is not a dead device.** Both scripts check before they switch over, so a transfer
that stops leaves the old firmware in place. Run it again.

The thermostat's own bootloader lives in a part of its memory that an update never touches, so an
interrupted thermostat update still leaves a device that can be updated again — over the air, with no
case opening.

Each script's file starts with a long comment covering the details, the traps and the measured
numbers. That is the reference; this page is the tour.
