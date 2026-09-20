# eQ-3 custom firmware

[!["Buy Me A Coffee"](https://www.buymeacoffee.com/assets/img/custom_images/orange_img.png)](https://www.buymeacoffee.com/dbuezas)

## ▶ [Open the app: dbuezas.github.io/eq3-custom-fw](https://dbuezas.github.io/eq3-custom-fw/)

It runs in your browser, talks to the thermostat over Bluetooth, and needs nothing installed.

Chrome or Edge only, on Android, Windows, macOS, Linux or ChromeOS. Safari and Firefox have no Web
Bluetooth, so **iPhones and iPads cannot do this at all**. You can install the page to your home
screen and it works with no network, which matters in a cellar with no wifi.

---

Alternative firmware for the **eQ-3 CC-RT-BLE** Bluetooth radiator thermostat, plus the tools to put
it on one. It keeps everything the original does and adds pair-less encrypted connections, BTHome
broadcasts for Home Assistant, a settable pairing PIN, a screen mirror, the thermostat's own buttons
as a remote control, and longer battery life.

Every eQ-3 firmware version is here too, so you can always put it back exactly as it was.

**[What's new →](CHANGELOG.md)**  ·  **[Bluetooth protocol →](PROTOCOL.md)** — everything a program
needs to talk to a thermostat, if you want to build your own integration or app.

## If the page cannot help

[`python-scripts/`](python-scripts/README.md) flashes the same firmware from a computer, and reaches
the thermostat by wire when Bluetooth no longer answers.

```sh
pip install -r python-scripts/requirements.txt
python3 python-scripts/flash.py --list               # which thermostats are in range
python3 python-scripts/flash.py <device>             # install the newest version, both chips
python3 python-scripts/flash.py <device> --versions  # every version on offer
```

## What each script is for

Every one of them explains itself at the top of the file — the wiring, the traps and the measured
numbers live there, not here.

| script | what it does |
|---|---|
| [`flash.py`](python-scripts/flash.py) | **This is the one.** Finds thermostats, and installs a version onto both chips in the right order with a safety check between them. Self-contained. |
| [`ble_chip_via_uart.py`](python-scripts/ble_chip_via_uart.py) | Gets Bluetooth answering again when it has stopped. Needs a USB-UART adapter and the case open — **read its header first.** |

Updating firmware is `flash.py` and nothing else.

## If Bluetooth stops answering

**Try this first — it needs no tools and no open case.** Take the batteries out, put them back, and
then hold the **BOOST** button down on the main screen until it reacts. Bluetooth can be switched off
on the thermostat itself, and a thermostat that is off is not a thermostat that is broken; that
button is what turns the radio back on. It costs a minute and it is the one cause the wire cannot
help with any faster.

If the radio is still silent, it is not lost — it just cannot be reached through the air any more.
Open the case and put a USB-to-serial adapter on the 5-pin header marked **PRG2**, holding the board
so that text reads the right way up:

| PRG2 pin | what it is | connect to |
|---|---|---|
| 1 | 3.3V | **nothing** |
| 2 | GND | adapter GND |
| 3 | radio RX | adapter **TX** |
| 4 | radio TX | adapter **RX** |
| 5 | VCC | **nothing** |

115200 baud, 8N1. **Leave pins 1 and 5 unconnected** — the batteries power the board, and a second
supply stops the recovery working, because it needs you to take the power away.

```sh
python3 python-scripts/ble_chip_via_uart.py dump -p /dev/ttyUSB0 -o backup.bin
python3 python-scripts/ble_chip_via_uart.py recover -p /dev/ttyUSB0
```

It will ask you to **pull a battery, wait two seconds, and put it back** — the chip's boot ROM
listens only in a short window just after power arrives.

That puts a radio image that answers without pairing into the spare slot and points the chip at it.
Power cycle, close the case, and `flash.py` takes it from there over Bluetooth as normal. The wire is
for getting Bluetooth back, not for living on.

Two things the rescue image does that a normal one does not: it advertises **whatever the thermostat
last said about Bluetooth**, so it comes back even when the radio was switched off, and it advertises
**twice a second** instead of once, so it is quicker to find and quicker to connect to. Both are there
for the same reason — this image exists to be reachable, and then to be replaced. Install a real
version over it with `flash.py` as soon as it answers; that one goes back to respecting the setting
and the normal rate.

## Two chips, one version

A thermostat is two processors: the one that runs the heating, and the radio that carries Bluetooth.
They have to agree about what they say to each other, so a version means **both** images or neither.
`flash.py` does both, and there is no option to do one.

It flashes the thermostat first and the radio last, because flashing the radio ends the very
connection it is being flashed over. Between the two it waits for the thermostat's own bootloader to
confirm it took the image, and **stops without touching the radio** if it did not. A half-installed
thermostat leaves you one working chip; carrying on would leave you none.

## Afterwards

A freshly flashed thermostat asks for the date and does nothing until it has one — no measuring, no
heating, no broadcasts. Set it from the page, or from eQ-3's own app. That is normal and is not a
failure.

## Going back

The original eQ-3 versions are on offer too, so `flash.py <device> --release 1.48` puts the thermostat
back on stock 1.48, radio included. Nothing here is one-way.

## Warning

This is unofficial firmware, written by reading eQ-3's. It is not from eQ-3, not supported by them,
and it may void your warranty. You are installing it at your own risk.
