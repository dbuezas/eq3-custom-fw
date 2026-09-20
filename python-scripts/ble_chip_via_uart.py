#!/usr/bin/env python3
"""Reach the radio chip over a wire, when it no longer answers over Bluetooth.

The radio holds the Bluetooth link, so a bad radio image takes away the very thing you would use to
replace it. This talks to the chip's own boot ROM instead, down a serial wire, and that ROM is in
silicon -- it answers whatever state the firmware is in.

**Almost nobody needs this.** Bluetooth can be switched OFF on the thermostat, and a thermostat that
is off is not one that is broken. Before opening anything: take the batteries out, put them back, and
hold BOOST on the main screen until it reacts. That is what turns the radio back on, and it costs a
minute. Open the case only if the radio still says nothing.

WHAT YOU NEED
=============
A USB-to-serial adapter (an FTDI one is known to work) and the case open. The board has a 5-pin
header marked **PRG2**. Hold it so its text reads the right way up; the pins are then, left to right:

    pin 1     pin 2     pin 3         pin 4         pin 5
    3.3V      GND       radio RX      radio TX      VCC

    adapter GND  ->  pin 2
    adapter TX   ->  pin 3        (you transmit, the radio receives)
    adapter RX   ->  pin 4        (the radio transmits, you receive)

**Leave pins 1 and 5 alone.** The batteries power the board; feeding it a second supply means the
next step cannot work, because you will not be able to take its power away.

The port runs at 115200 baud, 8N1. `-p` is the adapter's device name: `/dev/ttyUSB0` or
`/dev/ttyACM0` on Linux, `/dev/cu.usbserial-*` on macOS, `COM3` on Windows.

HOW IT CONNECTS: YOU PULL A BATTERY WHILE IT ASKS
=================================================
The boot ROM listens only in a short window just after power comes up, before the firmware starts.
There is no way to ask for that window later, so every command here begins the same way: the script
starts calling out, and **you take a battery out, wait about two seconds, and put it back**. It
catches the chip on the way up and says so.

Once it is in, it stays in for the rest of that run -- so a command that does several things needs
only the one battery pull. Starting the script again needs another.

THE REASON MOST PEOPLE ARE HERE
===============================
    pip install -r requirements.txt

    python3 ble_chip_via_uart.py dump    -p /dev/ttyUSB0 -o eeprom_backup.bin   # do this first
    python3 ble_chip_via_uart.py recover -p /dev/ttyUSB0
    ... unplug the wires, put the batteries back, close the case ...
    python3 flash.py <device>                                                   # both chips, wireless

`recover` puts a radio image that answers without pairing into the slot the chip is NOT running,
checks every byte of it, and only then points the chip at the new one. If the write fails halfway the
chip still boots what it had, so this is safe to try again.

That image is built to be found: it advertises even if Bluetooth was switched off on the thermostat,
and twice a second instead of once. It is meant to be replaced -- run `flash.py` as soon as the radio
answers, and the version it installs behaves normally again.

**It is stock 1.48, not our 2.00, on purpose.** Our own firmware can demand a pairing PIN, and on a
thermostat that never ran it, the radio has never been told the owner's choice and assumes the
cautious one -- so it would come back refusing you. The stock image has no such feature to refuse
with. `--release X` picks a different one if you know better; `-i FILE` uses a file of your own.

**One thing it cannot undo.** If the thermostat chip is alive and set to demand a PIN, it tells the
radio so at every boot, and the radio obeys. `recover` fixes the radio, not that instruction. Turn
the PIN off from the thermostat's own Bluetooth settings page, or over Bluetooth once you are back
in. If the thermostat is dead -- the usual reason for being here -- it says nothing and the rescue
stands.

THE REST
========
    ds-status   which of the two firmware slots the chip actually boots from
    read        show a piece of the EEPROM
    dump        save all 64 KB to a file
    patch       change one byte
    patch-mac   change the Bluetooth address
    flash-fw    write a firmware image into one slot, without switching to it
    ds-select   switch which slot boots
    flash       restore a whole 64 KB dump -- see the warning below

    python3 ble_chip_via_uart.py ds-status -p /dev/ttyUSB0
    python3 ble_chip_via_uart.py read      -p /dev/ttyUSB0 --offset 0x3C00 --length 128
    python3 ble_chip_via_uart.py flash     -p /dev/ttyUSB0 -i eeprom_backup.bin

**`flash` overwrites everything, the Bluetooth address and pairing data included.** Use it only to
put back a dump you took from that same thermostat. `flash-fw` writes only a firmware slot and leaves
the device's identity alone, which is why `recover` is built on that one.

Every write is read back and checked as it goes, so a transfer that stops tells you where it stopped.

Adapted from https://github.com/dbuezas/eq3-flashing/blob/main/ble_chip_via_uart.py.
"""
import argparse
import json
import os
import serial
import struct
import sys
import time

EEPROM_BASE = 0xFF000000
EEPROM_SIZE = 0x10000  # 64KB
# EEPROM layout
SS1_OFFSET = 0x0000
SS2_OFFSET = 0x0100
VS_OFFSET = 0x0140
DS1_OFFSET = 0x0580
DS2_OFFSET = 0x8000

CONFIG_DS_LOCATION = 0x2044d8  # RAM -- what the ROM actually booted from, this session

# The write ceiling that actually matters: measured 64B OK / 96B TIMEOUT on this rig. Kept well
# under it, and used for every write in this file (dump/read keep the 240B upstream default --
# only writes were ever the problem).
WRITE_CHUNK = 32
READ_CHUNK = 240

# BD_ADDR (MAC) location in the Static Section
# Config-item header: id=0x40 (BD_ADDR), length=0x0006
# Stored little-endian (LSB first) at offset 0x15 within each SS copy
BDADDR_HEADER = bytes([0x40, 0x06, 0x00])
BDADDR_HEADER_OFFSET = 0x12  # relative to SS start
BDADDR_OFFSET = 0x15  # relative to SS start
BDADDR_LEN = 6

MINIDRIVER_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "firmware", "minidriver")


def parse_intel_hex(path):
    """Parse Intel HEX file into (address, data) segments."""
    segments = []
    base_addr = 0
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line.startswith(':'):
                continue
            raw = bytes.fromhex(line[1:])
            byte_count = raw[0]
            addr = (raw[1] << 8) | raw[2]
            rec_type = raw[3]
            data = raw[4:4 + byte_count]
            if rec_type == 0x00:
                segments.append((base_addr + addr, data))
            elif rec_type == 0x04:
                base_addr = ((data[0] << 8) | data[1]) << 16
            elif rec_type == 0x01:
                break
    return segments


class HCITransport:
    """HCI command/event transport over serial."""

    def __init__(self, port, baud=115200):
        self.ser = serial.Serial(port, baud, timeout=0.1)

    def close(self):
        self.ser.close()

    def send_cmd(self, opcode, params=b''):
        pkt = struct.pack('<BHB', 0x01, opcode, len(params)) + params
        self.ser.write(pkt)
        self.ser.flush()

    def wait_command_complete(self, expected_opcode=None, timeout=5.0):
        """Wait for HCI Command Complete event. Returns (opcode, status, payload) or None."""
        start = time.time()
        buf = b''
        while time.time() - start < timeout:
            b = self.ser.read(1)
            if not b:
                continue
            buf += b
            while len(buf) >= 3:
                idx = buf.find(b'\x04')
                if idx == -1:
                    buf = b''
                    break
                if idx > 0:
                    buf = buf[idx:]
                if len(buf) < 3:
                    break
                plen = buf[2]
                if len(buf) < 3 + plen:
                    break
                evt_code = buf[1]
                data = buf[3:3 + plen]
                buf = buf[3 + plen:]
                if evt_code == 0x0E and len(data) >= 3:
                    opcode = data[1] | (data[2] << 8)
                    status = data[3] if len(data) > 3 else -1
                    payload = data[4:] if len(data) > 4 else b''
                    if expected_opcode is None or opcode == expected_opcode:
                        return (opcode, status, payload)
        return None

    def reset_input(self):
        self.ser.reset_input_buffer()

    def drain(self, timeout=0.5):
        start = time.time()
        while time.time() - start < timeout:
            self.ser.read(256)


def wait_for_rom(hci, timeout=60):
    """Call the boot ROM until it answers. The person at the device has to take a battery out.

    IF IT NEVER ANSWERS AT ALL, check the wiring first -- swapped TX and RX look exactly like this,
    and so does anything else feeding the board power, because then taking a battery out changes
    nothing. Try a few more battery pulls too: the window is short and it is easy to miss.

    If it still never answers, the chip may be beyond this wire. The serial port it replies on is
    switched on by the firmware's own start-up, so firmware that crashes before it gets there leaves
    the port correctly wired and permanently silent. There is no other way in to this chip."""
    print(">>> Pull battery, wait 2s, re-insert <<<")
    hci.reset_input()
    start = time.time()
    last_print = 0
    while time.time() - start < timeout:
        hci.send_cmd(0x0C03)  # HCI Reset
        hci.send_cmd(0xFC2E)  # Download Minidriver
        r = hci.wait_command_complete(0x0C03, timeout=0.05)
        if r and r[1] == 0x00:
            elapsed = time.time() - start
            print(f"ROM bootloader detected ({elapsed:.1f}s)")
            return True
        r = hci.wait_command_complete(0xFC2E, timeout=0.05)
        if r and r[1] == 0x00:
            elapsed = time.time() - start
            print(f"ROM bootloader detected via DL Minidriver ({elapsed:.1f}s)")
            return True
        elapsed = time.time() - start
        if elapsed - last_print >= 10:
            print(f"  Still waiting... ({elapsed:.0f}s)")
            last_print = elapsed
    print("Timeout waiting for ROM bootloader.")
    return False


def load_minidriver(hci):
    """Load and launch the WP-disable minidriver."""
    hex_path = os.path.join(MINIDRIVER_DIR, "uart_DISABLE_EEPROM_WP_PIN1.hex")
    if not os.path.exists(hex_path):
        print(f"Minidriver not found: {hex_path}")
        return False

    segments = parse_intel_hex(hex_path)
    entry_point = segments[0][0]

    hci.send_cmd(0xFC2E)
    r = hci.wait_command_complete(0xFC2E, timeout=5.0)
    if not r or r[1] != 0:
        print(f"Download Minidriver command failed: {r}")
        return False

    for addr, data in segments:
        offset = 0
        while offset < len(data):
            chunk = data[offset:offset + 247]
            params = struct.pack('<I', addr + offset) + bytes(chunk)
            hci.send_cmd(0xFC4C, params)
            r = hci.wait_command_complete(0xFC4C, timeout=2.0)
            if not r or r[1] != 0:
                print(f"Write RAM failed at 0x{addr + offset:08X}")
                return False
            offset += len(chunk)

    hci.send_cmd(0xFC4E, struct.pack('<I', entry_point))
    time.sleep(2.0)
    hci.drain()
    print("Minidriver running")
    return True


def read_eeprom(hci, offset, length):
    """Read bytes from EEPROM (the 0xFF000000-tagged indirect map). Returns bytes or None."""
    params = struct.pack('<IB', EEPROM_BASE + offset, length)
    hci.send_cmd(0xFC4D, params)
    r = hci.wait_command_complete(0xFC4D, timeout=10.0)
    if r and r[1] == 0:
        return r[2]
    return None


def read_eeprom_chunked(hci, offset, length, chunk=READ_CHUNK):
    """read_eeprom for spans over the single-request cap. Returns None on any failure."""
    out = b""
    for off in range(0, length, chunk):
        n = min(chunk, length - off)
        got = read_eeprom(hci, offset + off, n)
        if got is None:
            return None
        out += got
    return out


def peek_ram(hci, addr, length):
    """Read plain RAM (or any address not in the 0xFF000000 EEPROM range) -- same opcode as
    read_eeprom, no EEPROM_BASE tag, so the minidriver's map treats it as direct memory."""
    params = struct.pack('<IB', addr, length)
    hci.send_cmd(0xFC4D, params)
    r = hci.wait_command_complete(0xFC4D, timeout=10.0)
    if r and r[1] == 0:
        return r[2]
    return None


def write_eeprom(hci, offset, data):
    """Write bytes to EEPROM. Returns True on success. Caller chunks -- this does one HCI write,
    so keep `data` at or under WRITE_CHUNK (measured ceiling is 64B; this stays at 32B)."""
    params = struct.pack('<I', EEPROM_BASE + offset) + data
    hci.send_cmd(0xFC4C, params)
    r = hci.wait_command_complete(0xFC4C, timeout=10.0)
    return r is not None and r[1] == 0


def write_eeprom_verified(hci, offset, data, chunk=WRITE_CHUNK, on_progress=None):
    """Write `data` at `offset` in `chunk`-sized pieces, reading each one back immediately after
    writing it. Returns None on success, or an error string identifying exactly where it failed --
    upstream's whole-transfer-then-verify left no way to know how far a failed write actually got."""
    for off in range(0, len(data), chunk):
        piece = data[off:off + chunk]
        if not write_eeprom(hci, offset + off, piece):
            return f"write failed at +{off:#06x} ({off}/{len(data)})"
        back = read_eeprom(hci, offset + off, len(piece))
        if back != piece:
            return (f"verify mismatch at +{off:#06x}: wrote {piece.hex()} got "
                    f"{back.hex() if back else None}")
        if on_progress:
            on_progress(off + len(piece), len(data))
    return None


def enter_download_mode(hci):
    """Enter download mode and load minidriver."""
    if not wait_for_rom(hci):
        return False
    if not load_minidriver(hci):
        return False
    data = read_eeprom(hci, 0x0000, 4)
    if data is None:
        print("EEPROM read test failed!")
        return False
    print(f"EEPROM access verified (SS1: {data.hex()})")
    return True


# --------------------------------------------------------------------------------------- ds-status / ds-select

def ds_addr(n):
    return {1: DS1_OFFSET, 2: DS2_OFFSET}[n]


def parse_ss_chain(ss_bytes):
    """Walk a Static Section's {type:1B, len:2B-LE, payload} record chain from offset 0, stopping
    at type 0x02 (the DS-location item -- also where the ROM's own boot-time walker stops, since
    that is the one item it is looking for) or the 0xFE/0xFF terminators.

    Returns (items, ok). `ok` is False if the walk ran off the end of the buffer BEFORE reaching
    one of those stop points -- do not trust any offset found on that walk. SS bytes past the
    DS-location item are NOT further chain records (SS2 in particular carries pairing/NVRAM-shaped
    data there) -- stopping early is what keeps the walker from wandering into them and misreading
    unrelated bytes as record headers."""
    items = []
    i = 0
    while i + 3 <= len(ss_bytes):
        t = ss_bytes[i]
        ln = ss_bytes[i + 1] | (ss_bytes[i + 2] << 8)
        if i + 3 + ln > len(ss_bytes):
            return items, False
        payload = ss_bytes[i + 3:i + 3 + ln]
        items.append((i, t, ln, payload))
        i += 3 + ln
        if t in (0xFE, 0xFF, 0x02):
            break
    return items, True


def find_ds_location_item(items):
    """First type-0x02 item's payload offset within the SS, or None."""
    for off, t, ln, payload in items:
        if t == 0x02 and ln >= 4:
            return off + 3  # header is 3 bytes (type + 2-byte len)
    return None


def checksum_item1_ok(items):
    """The chain's only integrity check: the FIRST item's payload sums to 0 mod 256 (its own type
    field is 0x00 on this device -- "item 1" means chain position, not a type==0x01 match).
    Confirms the parse offsets are right -- if this fails, do not trust any offset this parse
    produced."""
    if not items:
        return False
    return (sum(items[0][3]) & 0xFF) == 0


def read_ss(hci, base):
    raw = read_eeprom_chunked(hci, base, 256)
    if raw is None:
        return None
    return raw


def cmd_ds_status(args):
    """Report which DS is actually active (live RAM, authoritative) alongside what SS1 and SS2
    each separately claim -- these three can disagree, and only the RAM read is what the chip is
    really running from right now."""
    hci = HCITransport(args.port)
    try:
        if not enter_download_mode(hci):
            return 1

        raw = peek_ram(hci, CONFIG_DS_LOCATION, 4)
        live = struct.unpack('<I', raw)[0] if raw else None
        print(f"live Config_DS_Location (RAM {CONFIG_DS_LOCATION:#010x}): "
              f"{'unreadable' if live is None else f'{live:#010x}'}"
              + ("" if live is None else f"  -> {'DS1' if live == DS1_OFFSET else 'DS2' if live == DS2_OFFSET else 'UNRECOGNIZED'}"))

        for label, base in (("SS1", SS1_OFFSET), ("SS2", SS2_OFFSET)):
            ss = read_ss(hci, base)
            if ss is None:
                print(f"{label}: read failed")
                continue
            items, ok = parse_ss_chain(ss)
            if not ok:
                print(f"{label}: chain walk ran off the end -- not trusting any offset in it")
                continue
            csum_ok = checksum_item1_ok(items)
            item_off = find_ds_location_item(items)
            if item_off is None:
                print(f"{label}: no type-0x02 (DS-location) item found")
                continue
            val = struct.unpack_from('<I', ss, item_off)[0]
            claim = 'DS1' if val == DS1_OFFSET else 'DS2' if val == DS2_OFFSET else 'UNRECOGNIZED'
            match = " (LIVE)" if live is not None and val == live else ""
            print(f"{label}: item-1 checksum {'OK' if csum_ok else 'BAD -- offsets suspect'}, "
                  f"DS-location item @ SS+{item_off:#04x} = {val:#010x} -> {claim}{match}")
        return 0
    finally:
        hci.close()


def find_trusted_ss(hci, live):
    """The SS whose DS-location item matches what the chip actually booted from, or None.

    WHICH SS IS TRUSTED IS NOT FIXED, so it is found by agreement with the live RAM value rather than
    assumed: writing the other one changes nothing and looks exactly like success. Returns
    (label, base, item offset, current value).
    """
    for label, base in (("SS1", SS1_OFFSET), ("SS2", SS2_OFFSET)):
        ss = read_ss(hci, base)
        if ss is None:
            continue
        items, ok = parse_ss_chain(ss)
        if not ok or not checksum_item1_ok(items):
            continue
        item_off = find_ds_location_item(items)
        if item_off is None:
            continue
        val = struct.unpack_from('<I', ss, item_off)[0]
        if val == live:
            return label, base, item_off, val
    return None


def cmd_ds_select(args):
    """Flip whichever SS is actually being trusted (matches the live RAM read) to point at the
    requested DS slot -- a single small write to an unprotected 4-byte field, not a DS rewrite.
    Refuses to proceed if the item-1 checksum doesn't validate first, since that is the one
    signal available that the parse offsets are trustworthy."""
    target = ds_addr(args.ds)
    hci = HCITransport(args.port)
    try:
        if not enter_download_mode(hci):
            return 1

        raw = peek_ram(hci, CONFIG_DS_LOCATION, 4)
        live = struct.unpack('<I', raw)[0] if raw else None
        if live is None:
            print("could not read live Config_DS_Location -- refusing to guess which SS to edit")
            return 1
        print(f"live Config_DS_Location = {live:#010x}")

        target_ss = find_trusted_ss(hci, live)
        if target_ss is None:
            print("could not find an SS whose DS-location item matches the live RAM value -- "
                  "refusing to write blind")
            return 1
        label, base, item_off, cur_val = target_ss
        abs_off = base + item_off
        if cur_val == target:
            print(f"{label} already selects {'DS1' if target == DS1_OFFSET else 'DS2'} -- nothing to do")
            return 0

        new_bytes = struct.pack('<I', target)
        print(f"writing {label}+{item_off:#04x} (absolute {abs_off:#06x}): "
              f"{cur_val:#010x} -> {target:#010x}")
        err = write_eeprom_verified(hci, abs_off, new_bytes)
        if err:
            print(f"FAILED: {err}")
            return 1
        print("Selector flipped and verified. Power cycle the device for it to take effect.")
        return 0
    finally:
        hci.close()


# --------------------------------------------------------------------------------------- dump / flash / flash-fw

def cmd_dump(args):
    """Dump full EEPROM to file."""
    hci = HCITransport(args.port)
    try:
        if not enter_download_mode(hci):
            return 1

        print(f"Dumping EEPROM ({EEPROM_SIZE // 1024}KB)...")
        dump = bytearray()

        for offset in range(0, EEPROM_SIZE, READ_CHUNK):
            remaining = min(READ_CHUNK, EEPROM_SIZE - offset)
            data = read_eeprom(hci, offset, remaining)
            if data:
                dump.extend(data)
            else:
                print(f"  Read failed at 0x{offset:04X}, padding with 0xFF")
                dump.extend(b'\xFF' * remaining)

            pct = (offset * 100) // EEPROM_SIZE
            if pct % 10 == 0 and offset > 0 and offset % (EEPROM_SIZE // 10) < READ_CHUNK:
                print(f"  {pct}%")

        with open(args.output, 'wb') as f:
            f.write(dump)
        print(f"Saved {len(dump)} bytes to {args.output}")
        return 0
    finally:
        hci.close()


def cmd_flash(args):
    """Flash a full EEPROM image.
    CAUTION: This overwrites the entire EEPROM including device identity
    (MAC address, pairing data, NVRAM). A failed write can make the device
    unrecoverable via PUART. Always dump a backup first."""
    image = open(args.input, 'rb').read()
    if len(image) != EEPROM_SIZE:
        print(f"ERROR: image is {len(image)} bytes, expected {EEPROM_SIZE} (64 KB).")
        if len(image) < EEPROM_SIZE:
            print("This looks like a firmware .bin, not a full EEPROM dump.")
            print("Did you mean 'flash-fw' instead of 'flash'?")
        return 1
    print("CAUTION: This overwrites the ENTIRE EEPROM including device identity.")
    print("A failed write can make the device unrecoverable via PUART.")
    print("Make sure you have a dump backup first!")
    resp = input("Continue? (yes/no): ")
    if resp.strip().lower() != 'yes':
        print("Aborted.")
        return 0

    hci = HCITransport(args.port)
    try:
        if not enter_download_mode(hci):
            return 1

        print(f"Writing {len(image)} bytes to EEPROM in {WRITE_CHUNK}B verified chunks...")

        def progress(done, total):
            pct = (done * 100) // total
            if pct % 5 == 0 and done != total:
                print(f"  {pct}%  (+{done}/{total})")

        err = write_eeprom_verified(hci, 0, image, on_progress=progress)
        if err:
            print(f"  {err}")
            return 1
        print("Verified OK!")
        return 0
    finally:
        hci.close()


STAGED = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                      "..", "webapp", "public", "firmware")


def staged(release=None, rescue=False):
    """(what it is, path) for a staged radio image, checked against the catalogue on the way out.

    The catalogue is read through flash.py, so ONE piece of code knows what it means and one checks
    an image against its recorded size and hash. That import is late on purpose: it pulls in bleak,
    which a wire-only rescue has no use for, and every other subcommand here works without it.
    """
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    try:
        from flash import FIRMWARE, image, load_catalogue, pick             # noqa: PLC0415
    except ImportError as e:
        sys.exit(f"cannot read the firmware catalogue ({e}).\n"
                 f"  pip install -r requirements.txt, or pass a file with -i instead.")
    if rescue:
        entry = json.load(open(os.path.join(FIRMWARE, "catalogue.json"))).get("rescue_radio")
        if not entry:
            sys.exit("no rescue image is staged in this folder -- pass one with -i.")
        return ("the rescue image: stock 1.48, connectable without pairing, and advertising "
                "twice a second whatever the thermostat last said about Bluetooth"), image(entry)
    rel = pick(load_catalogue(), release)
    return (f"{rel['version']} radio"
            + ("  (ours)" if rel.get("mod") else "  (stock eQ-3)")), image(rel["radio"])


def resolve_fw(args, rescue_default=False):
    """The image to write: -i as given, --release from the catalogue, else the default for this job."""
    if getattr(args, "input", None) and getattr(args, "release", None):
        sys.exit("pass either -i or --release, not both")
    if getattr(args, "input", None):
        return args.input
    what, path = staged(getattr(args, "release", None),
                        rescue=rescue_default and not getattr(args, "release", None))
    print(f"image: {what}")
    return path


def cmd_recover(args):
    """Put a connectable radio image on the chip over the wire, so the rest can go over the air.

    THE POINT IS TO STOP NEEDING THE WIRE. Every release of ours is noauth -- the radio accepts a
    connection with no pairing -- so once one is running, `flash.py <device>` installs both chips the
    normal way and the case can be shut. Use this when the radio answers nothing over the air at all:
    a half-written radio image, or a PIN that cannot be read off the display.

    IT WRITES ONE CHIP. The thermostat half is untouched and stays whatever it was; bring it up to
    date afterwards with flash.py, which does both.

    It writes the INACTIVE slot and then flips the selector, which is what makes this safe to try: if
    the write fails partway, the chip still boots the image it has now and you can try again.
    """
    fw_path = resolve_fw(args, rescue_default=True)
    fw_data = open(fw_path, 'rb').read()
    max_ds_size = DS2_OFFSET - DS1_OFFSET
    if len(fw_data) > max_ds_size:
        print(f"ERROR: image is {len(fw_data)} bytes, a DS region holds {max_ds_size}")
        return 1

    hci = HCITransport(args.port)
    try:
        if not enter_download_mode(hci):
            return 1

        raw = peek_ram(hci, CONFIG_DS_LOCATION, 4)
        live = struct.unpack('<I', raw)[0] if raw else None
        if live is None:
            print("could not read which DS the chip booted from -- refusing to write blind.")
            return 1
        # The slot it is NOT running. Whichever that is, writing it cannot cost the working image.
        target_ds = 2 if live == DS1_OFFSET else 1
        target_off = ds_addr(target_ds)
        print(f"booted from {live:#06x} -> writing the spare slot, DS{target_ds} at {target_off:#06x}")

        print(f"\nAbout to write {len(fw_data)} bytes and point the chip at them.")
        print("Take an EEPROM backup first if you have not: `dump -o backup.bin`.")
        if input("Continue? (yes/no): ").strip().lower() != 'yes':
            print("Aborted.")
            return 0

        def progress(done, total):
            pct = (done * 100) // total
            if pct % 10 == 0 and done != total:
                print(f"  {pct}%")

        err = write_eeprom_verified(hci, target_off, fw_data, on_progress=progress)
        if err:
            print(f"  {err}\n  Nothing was selected, so the chip still boots the image it had.")
            return 1
        if read_eeprom_chunked(hci, target_off, len(fw_data), chunk=WRITE_CHUNK) != fw_data:
            print("FINAL VERIFY MISMATCH -- not selecting it. The chip still boots what it had.")
            return 1
        print("written and verified")

        found = find_trusted_ss(hci, live)
        if found is None:
            print("could not find the selector the chip is actually reading -- refusing to write "
                  f"blind.\n  The image IS written and verified; finish with: ds-select --ds {target_ds}")
            return 1
        label, base, item_off, _cur = found
        err = write_eeprom_verified(hci, base + item_off, struct.pack('<I', target_off))
        if err:
            print(f"selector write FAILED: {err}\n"
                  f"  The image is written; finish with: ds-select --ds {target_ds}")
            return 1
        print(f"{label} now points at DS{target_ds}")
    finally:
        hci.close()

    print("\nDone. Now:")
    print("  1. disconnect the UART wires and power cycle the thermostat")
    print("  2. close the case")
    print("  3. python3 flash.py --list          # it should appear")
    print("  4. python3 flash.py <device>        # brings BOTH chips up to date")
    return 0


def cmd_flash_fw(args):
    """Flash a BLE firmware .bin file to a DS region (DS1 by default, or --ds 2).
    CAUTION: A failed write can corrupt the firmware header, making the
    device unrecoverable via PUART. Always dump a backup first.
    The .bin file is written as-is (including any OTA header) since the
    EEPROM DS region stores the complete file verbatim.

    THIS WRITES DS CONTENT ONLY -- it does NOT change which DS boots. The hard rule this tool
    enforces, not just documents: WRITE THE INACTIVE SLOT, VERIFY, THEN `ds-select` TO FLIP --
    never write the slot that's currently live. A write already in progress against the live
    slot is a device with no fallback if it fails partway. This function checks the live RAM
    Config_DS_Location itself before writing and refuses the active slot unless --force-active
    is given explicitly -- a human remembering the rule is not the safety net, this check is."""
    fw_path = resolve_fw(args)
    fw_data = open(fw_path, 'rb').read()
    ds_offset = ds_addr(args.ds)
    max_ds_size = DS2_OFFSET - DS1_OFFSET
    if len(fw_data) == EEPROM_SIZE:
        print(f"ERROR: file is {len(fw_data)} bytes -- this looks like a full EEPROM dump.")
        print("Did you mean 'flash' instead of 'flash-fw'?")
        return 1
    if len(fw_data) > max_ds_size:
        print(f"ERROR: firmware too large: {len(fw_data)} > {max_ds_size}")
        return 1

    hci = HCITransport(args.port)
    try:
        if not enter_download_mode(hci):
            return 1

        raw = peek_ram(hci, CONFIG_DS_LOCATION, 4)
        live = struct.unpack('<I', raw)[0] if raw else None
        if live is None:
            print("could not read live Config_DS_Location -- refusing to write blind. Use "
                  "--force-active only if you understand the risk and this check is the problem.")
            if not args.force_active:
                return 1
        elif live == ds_offset and not args.force_active:
            print(f"REFUSING: DS{args.ds} at {ds_offset:#06x} is the CURRENTLY ACTIVE slot "
                  f"(live Config_DS_Location = {live:#010x}). Writing it risks leaving the device "
                  f"with no fallback if this write fails partway. Write the INACTIVE DS instead, "
                  f"verify it, then `ds-select` to flip. Pass --force-active only if you genuinely "
                  f"mean to overwrite the running image in place.")
            return 1
        elif live == ds_offset and args.force_active:
            print(f"--force-active given: proceeding against the ACTIVE slot DS{args.ds} anyway. "
                  f"This is the risky path -- a failed write here has no fallback.")

        print(f"Target: DS{args.ds} at {ds_offset:#06x}"
              + (" (inactive -- safe)" if live is not None and live != ds_offset else ""))
        print("CAUTION: If the write fails partially, the device may become")
        print("unrecoverable via PUART. Make sure you have a dump backup first!")
        resp = input("Continue? (yes/no): ")
        if resp.strip().lower() != 'yes':
            print("Aborted.")
            return 0

        print(f"Writing firmware ({len(fw_data)} bytes) to DS{args.ds} at 0x{ds_offset:04X} "
              f"in {WRITE_CHUNK}B verified chunks...")

        def progress(done, total):
            pct = (done * 100) // total
            if pct % 5 == 0 and done != total:
                print(f"  {pct}%  (+{done}/{total})")

        err = write_eeprom_verified(hci, ds_offset, fw_data, on_progress=progress)
        if err:
            print(f"  {err}")
            return 1

        print("Final independent full-image re-read...")
        readback = read_eeprom_chunked(hci, ds_offset, len(fw_data), chunk=WRITE_CHUNK)
        if readback == fw_data:
            print("Verified OK! (byte-identical to the source file)")
            print(f"Now run: ds-select --ds {args.ds}  (once you're satisfied), then power cycle.")
            return 0
        print("FINAL VERIFY MISMATCH -- do not select this DS yet.")
        return 1
    finally:
        hci.close()


def cmd_patch(args):
    """Patch a single byte in EEPROM."""
    hci = HCITransport(args.port)
    try:
        if not enter_download_mode(hci):
            return 1

        offset = int(args.offset, 0)
        value = int(args.value, 0)

        current = read_eeprom(hci, offset, 1)
        if current is None:
            print(f"Failed to read 0x{offset:04X}")
            return 1
        print(f"Current: EEPROM[0x{offset:04X}] = 0x{current[0]:02X}")

        if current[0] == value:
            print("Already has the target value, nothing to do.")
            return 0

        if not write_eeprom(hci, offset, bytes([value])):
            print("Write failed!")
            return 1

        readback = read_eeprom(hci, offset, 1)
        if readback and readback[0] == value:
            print(f"Patched: 0x{current[0]:02X} -> 0x{value:02X} (verified)")
        else:
            print(f"VERIFICATION FAILED! Readback: {readback}")
            return 1
        return 0
    finally:
        hci.close()


def parse_mac(s):
    """Parse 'XX:XX:XX:XX:XX:XX' (or '-' separators) into 6 bytes, big-endian."""
    s = s.replace('-', ':').strip()
    parts = s.split(':')
    if len(parts) != 6:
        return None
    try:
        return bytes(int(p, 16) for p in parts)
    except ValueError:
        return None


def fmt_mac(mac_le):
    """Format 6 little-endian bytes as XX:XX:XX:XX:XX:XX."""
    return ':'.join(f'{b:02X}' for b in mac_le[::-1])


def cmd_patch_mac(args):
    """Change the BLE MAC address (BD_ADDR) in EEPROM.

    Patches the BD_ADDR in both SS1 and SS2 using single-byte writes
    (the same proven-safe write primitive as the 'patch' command).
    Only one battery-pull is needed -- the minidriver stays loaded."""
    mac_be = parse_mac(args.mac)
    if mac_be is None:
        print(f"Invalid MAC format: {args.mac}")
        print("Expected: XX:XX:XX:XX:XX:XX (e.g. 00:1A:22:AA:BB:CC)")
        return 1
    mac_le = mac_be[::-1]

    hci = HCITransport(args.port)
    try:
        if not enter_download_mode(hci):
            return 1

        for label, ss_base in [("SS1", SS1_OFFSET), ("SS2", SS2_OFFSET)]:
            hdr_off = ss_base + BDADDR_HEADER_OFFSET
            hdr = read_eeprom(hci, hdr_off, 3)
            if hdr is None:
                print(f"Failed to read {label} header at 0x{hdr_off:04X}")
                return 1
            if bytes(hdr) != BDADDR_HEADER:
                if label == "SS2" and bytes(hdr) == b'\x00\x00\x00':
                    print(f"{label}: blank (all zeros) -- will skip")
                    continue
                print(f"ERROR: {label} BD_ADDR header at 0x{hdr_off:04X} is "
                      f"{bytes(hdr).hex()}, expected {BDADDR_HEADER.hex()}")
                print("EEPROM layout does not match -- aborting for safety.")
                return 1

        copies = []
        for label, ss_base in [("SS1", SS1_OFFSET), ("SS2", SS2_OFFSET)]:
            addr_off = ss_base + BDADDR_OFFSET
            cur = read_eeprom(hci, addr_off, BDADDR_LEN)
            if cur is None:
                print(f"Failed to read {label} BD_ADDR")
                return 1
            is_blank = all(b == 0 for b in cur)
            copies.append((label, ss_base, bytes(cur), is_blank))
            status = "(blank)" if is_blank else ""
            print(f"Current {label} BD_ADDR: {fmt_mac(cur)} {status}")

        print(f"Target BD_ADDR:      {fmt_mac(mac_le)}")

        if all(c[2] == mac_le or c[3] for c in copies):
            non_blank = [c for c in copies if not c[3]]
            if non_blank and non_blank[0][2] == mac_le:
                print("Already at target MAC, nothing to do.")
                return 0

        for label, ss_base, cur, is_blank in copies:
            if is_blank:
                print(f"Skipping {label} (blank)")
                continue
            addr_off = ss_base + BDADDR_OFFSET
            print(f"Patching {label} at 0x{addr_off:04X}...")
            for i in range(BDADDR_LEN):
                if cur[i] == mac_le[i]:
                    continue
                if not write_eeprom(hci, addr_off + i, bytes([mac_le[i]])):
                    print(f"  Write failed at 0x{addr_off + i:04X}!")
                    return 1
            readback = read_eeprom(hci, addr_off, BDADDR_LEN)
            if bytes(readback) != mac_le:
                print(f"  VERIFICATION FAILED! Got: {fmt_mac(readback)}")
                return 1
            print(f"  {label} verified: {fmt_mac(readback)}")

        print(f"\nBD_ADDR changed to {fmt_mac(mac_le)}")
        print("Power cycle the device for the change to take effect.")
        return 0
    finally:
        hci.close()


def cmd_read(args):
    """Read and display a region of EEPROM."""
    hci = HCITransport(args.port)
    try:
        if not enter_download_mode(hci):
            return 1

        offset = int(args.offset, 0)
        length = int(args.length, 0)

        print(f"Reading EEPROM 0x{offset:04X}-0x{offset + length - 1:04X} ({length} bytes):")
        data = read_eeprom_chunked(hci, offset, length)
        if data is None:
            print("  Read failed")
            return 1

        for i in range(0, len(data), 16):
            addr = offset + i
            row = data[i:i + 16]
            hexstr = ' '.join(f'{b:02x}' for b in row)
            ascstr = ''.join(chr(b) if 32 <= b < 127 else '.' for b in row)
            print(f"  {addr:04X}: {hexstr:<48} {ascstr}")
        return 0
    finally:
        hci.close()


def main():
    ap = argparse.ArgumentParser(
        description="Reach the radio chip over a wire, when it no longer answers over Bluetooth. "
                    "Needs a USB-to-serial adapter on the board's PRG2 header; see this file's "
                    "header for the wiring, or ./README.md.")
    sub = ap.add_subparsers(dest='cmd', required=True)
    port_arg = {'flags': ['--port', '-p'], 'kwargs': {'required': True}}

    p_status = sub.add_parser('ds-status', help='Which firmware slot the chip actually boots from')
    p_status.add_argument(*port_arg['flags'], **port_arg['kwargs'])

    p_select = sub.add_parser('ds-select', help='Switch which firmware slot boots')
    p_select.add_argument(*port_arg['flags'], **port_arg['kwargs'])
    p_select.add_argument('--ds', type=int, choices=[1, 2], required=True)

    p_dump = sub.add_parser('dump', help="Save the chip's whole memory to a file -- do this first")
    p_dump.add_argument(*port_arg['flags'], **port_arg['kwargs'])
    p_dump.add_argument('--output', '-o', required=True)

    p_flash = sub.add_parser(
        'flash', help='Restore a whole memory dump -- OVERWRITES the Bluetooth address and pairing '
                      'data too, so only use one taken from this same thermostat')
    p_flash.add_argument(*port_arg['flags'], **port_arg['kwargs'])
    p_flash.add_argument('--input', '-i', required=True)

    p_recover = sub.add_parser(
        'recover', help='Put a connectable radio image on the chip so the rest can go over the air')
    p_recover.add_argument(*port_arg['flags'], **port_arg['kwargs'])
    p_recover.add_argument('--release', help='use a release instead of the rescue image')
    p_recover.add_argument('--input', '-i', help='a .bin of your own instead of a staged release')

    p_flash_fw = sub.add_parser(
        'flash-fw', help='Write a radio firmware file into one slot, without switching to it')
    p_flash_fw.add_argument(*port_arg['flags'], **port_arg['kwargs'])
    p_flash_fw.add_argument('--input', '-i', help='BLE firmware .bin file')
    p_flash_fw.add_argument('--release', help='or a staged release, by version')
    p_flash_fw.add_argument('--ds', type=int, choices=[1, 2], default=1,
                            help='which DS region to write (default 1) -- check ds-status first')
    p_flash_fw.add_argument('--force-active', action='store_true',
                            help='override the refusal to write the currently-active DS slot -- '
                                 'only for a deliberate in-place overwrite, understanding a failed '
                                 'write here has no fallback')

    p_patch = sub.add_parser('patch', help="Change one byte of the chip's memory")
    p_patch.add_argument(*port_arg['flags'], **port_arg['kwargs'])
    p_patch.add_argument('--offset', required=True)
    p_patch.add_argument('--value', required=True)

    p_patch_mac = sub.add_parser('patch-mac', help="Change the thermostat's Bluetooth address")
    p_patch_mac.add_argument(*port_arg['flags'], **port_arg['kwargs'])
    p_patch_mac.add_argument('--mac', required=True)

    p_read = sub.add_parser('read', help="Show a piece of the chip's memory")
    p_read.add_argument(*port_arg['flags'], **port_arg['kwargs'])
    p_read.add_argument('--offset', required=True)
    p_read.add_argument('--length', required=True)

    args = ap.parse_args()
    fn = {
        'ds-status': cmd_ds_status,
        'ds-select': cmd_ds_select,
        'dump': cmd_dump,
        'flash': cmd_flash,
        'recover': cmd_recover,
        'flash-fw': cmd_flash_fw,
        'patch': cmd_patch,
        'patch-mac': cmd_patch_mac,
        'read': cmd_read,
    }[args.cmd]
    sys.exit(fn(args))


if __name__ == '__main__':
    main()
