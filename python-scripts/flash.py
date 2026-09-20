#!/usr/bin/env python3
"""Install firmware on an eQ-3 CC-RT-BLE thermostat -- both of its chips, in one command.

    python3 flash.py --list                    # which thermostats are in range
    python3 flash.py <device>                  # install the newest version
    python3 flash.py <device> --versions       # what is on offer
    python3 flash.py <device> --release 1.48   # go back to an original eQ-3 version
    python3 flash.py <device> --adapter hci0   # Linux, if you have more than one Bluetooth adapter

<device> is whatever `--list` prints for it: a UUID on macOS, a MAC address on Linux. You can save a
name for one in ~/.config/eq3-firmware-mod/devices.json and use that instead.

    pip install -r requirements.txt

IT DOES BOTH CHIPS AND THERE IS NO OPTION TO DO ONE. A thermostat is two processors -- one runs the
heating, the other carries Bluetooth -- and they have to agree about what they say to each other. So
a version means both images or neither. That is not a missing feature.

WHAT YOU WILL SEE. It connects once, sends the thermostat's image, then the radio's, and prints a
percentage as each goes. Allow a few minutes. **The connection dropping at the very end is success**:
the radio restarts into its new image, which kills the link it was being flashed over. It says so
when that happens.

IF THE THERMOSTAT HALF FAILS, IT STOPS AND LEAVES THE RADIO ALONE. Between the two it waits for the
thermostat's own bootloader to say it took the image. A thermostat that refused its update still has
working firmware and can be updated again; carrying on to the radio is what would leave you with
neither. It writes a log and tells you where.

AFTERWARDS the thermostat asks for the date and does nothing at all until it has one -- no heating,
no measuring, no broadcasts. Set it from the web page, from eQ-3's own app, or from Home Assistant.
That is normal and is not a failed update.

IT ONLY EVER WRITES FIRMWARE. It does not read your settings, change anything on the thermostat, or
touch its schedule.
"""
import argparse
import asyncio
import binascii
import hashlib
import json
import os
import re
import struct
import sys
import tempfile
import time

from bleak import BleakClient, BleakScanner

# ---------------------------------------------------------------- what is where ----
HERE = os.path.dirname(os.path.abspath(__file__))
FIRMWARE = os.path.join(HERE, "..", "webapp", "public", "firmware")
ALIAS_PATH = os.path.expanduser("~/.config/eq3-firmware-mod/devices.json")

IS_MACOS = sys.platform == "darwin"

ADV_NAME = "CC-RT-BLE"      # the DEFAULT advertised name -- every un-renamed unit shares it, so it
                            # identifies the MODEL and never a particular thermostat.
ADV_PREFIX = "eQ3-"         # a renamed 2.00 unit airs its custom name behind this, so a rename does
                            # not hide it from a filter.
BTHOME_UUID = "0000fcd2-0000-1000-8000-00805f9b34fb"   # aired by 2.00 whatever it is called

_MAC_RE = re.compile(r"^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$")
_UUID_RE = re.compile(r"^[0-9A-Fa-f]{8}(-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$")

# The thermostat's command pair, reached through the radio's relay.
MCU_WRITE = "3fa4585a-ce4a-3bad-db4b-b8df8179ea09"
MCU_NOTIFY = "d0e8434d-cd29-0996-af41-6c90f4e0eb2a"
# The radio's own WICED OTA pair.
OTA_CONTROL = "e3dd50bf-f7a7-4e99-838e-570a086c666b"
OTA_DATA = "92e86c7a-d961-4091-b74f-2409e72efe36"

# How the thermostat transfer can end. The first three mean it took the image and restarted --
# `FINISHED` is the bootloader's explicit `a1 44`, the other two are it rebooting out from under the
# last chunks, which it does.
TOOK_IT = ("FINISHED", "SELFBOOT", "SELFBOOT_LASTCHUNK")

WS_STATUS = {0: "OK", 1: "Unsupported command", 2: "Illegal state",
             3: "Verification failed (CRC mismatch)", 4: "Invalid image",
             5: "Invalid image size", 6: "More data needed",
             7: "Invalid app ID", 8: "Invalid version"}


# ---------------------------------------------------------------- finding a device ----
# A MAC DOES NOT IDENTIFY A DEVICE ON macOS. CoreBluetooth never exposes the hardware address; it
# hands out a UUID of its own, unique per (computer, device) and never transmitted. So a MAC matches
# nothing there and the failure is silent -- "did not advertise" while the thermostat sits in front of
# you. `--list` is how you get the identifier this computer needs. Linux is unaffected: a MAC goes
# straight to find_device_by_address.
#
# There is no fall back to matching by name, deliberately. Every un-renamed thermostat airs the same
# one, so that would flash whichever answered first -- harmless with one in the house, not harmless
# with two.
def load_aliases():
    try:
        with open(ALIAS_PATH) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def dealias(spec):
    """A saved name -> its address, matched without regard to case."""
    aliases = load_aliases()
    if spec in aliases:
        return aliases[spec]
    for k, v in aliases.items():
        if k.lower() == spec.lower():
            return v
    return spec


async def find_all(adapter=None, timeout=15):
    """Every thermostat in range, as (device, advertised name).

    A DETECTION CALLBACK, never BleakScanner.discover(): discover() returns an end-of-run snapshot and
    drops adverts without saying so, which comes back empty for a device that is airing perfectly.
    Measured: a 15 s discover() printed nothing for a unit half a metre away that had just answered.

    Three tests, because a renamed unit is still one of ours and each covers what the others miss: the
    default name, the prefix a renamed 2.00 unit keeps, and BThome service data, which survives a
    rename and arrives even when the name does not.
    """
    seen = {}

    def cb(dev, adv):
        # adv.local_name first: on macOS dev.name is routinely None while the advert carries it.
        name = adv.local_name or dev.name or ""
        if (name == ADV_NAME or name.startswith(ADV_PREFIX)
                or BTHOME_UUID in (adv.service_data or {})):
            seen[dev.address] = (dev, name)

    kw = {"bluez": {"adapter": adapter}} if adapter else {}
    scanner = BleakScanner(cb, **kw)
    await scanner.start()
    try:
        await asyncio.sleep(timeout)
    finally:
        await scanner.stop()
    return list(seen.values())


async def resolve(spec, adapter=None, timeout=20):
    """A device for `spec`, or RuntimeError saying what to do instead."""
    spec = dealias(spec)
    if _UUID_RE.match(spec) or (_MAC_RE.match(spec) and not IS_MACOS):
        kw = {"timeout": timeout}
        if adapter:
            kw["adapter"] = adapter
        dev = await BleakScanner.find_device_by_address(spec, **kw)
        if dev is None:
            raise RuntimeError(f"{spec} did not advertise within {timeout} s")
        return dev
    if IS_MACOS and _MAC_RE.match(spec):
        found = []
        try:
            found = await find_all(adapter)
        except Exception:                                   # noqa: BLE001
            pass
        listing = "\n".join(f"    {d.address}   {n}" for d, n in found) or "    (none in range)"
        raise RuntimeError(
            f"{spec} is a MAC, and macOS cannot match one -- it identifies devices by its own UUID.\n"
            f"  Use one of these instead, or save it as a name in {ALIAS_PATH}:\n{listing}")
    raise RuntimeError(f"{spec!r} is not an address this computer can use, or a name in {ALIAS_PATH}")


class ConnectFailed(Exception, SystemExit):
    """Every attempt failed. Both bases are load-bearing: `except Exception` catches it, and uncaught
    it still exits 1 with the message rather than a traceback."""


async def connect(spec, adapter=None, timeout=30, tries=4, disconnected_callback=None, budget=75.0):
    """Discover, then connect -- retrying the PAIR, with a wall clock across all attempts.

    Never hand a bare address to BleakClient: on Linux that depends on BlueZ still holding a cached
    object, which it may have pruned when the advert changed, and on macOS it cannot work at all. The
    object can also vanish between discovery and connect, which is a race rather than a state -- so
    the answer is to re-discover and try again.

    The discovery is INSIDE the retry: it starts an active scan, and a computer already scanning
    answers "operation in progress", which is transient and must be retried rather than fatal.

    It retries the CONNECT and nothing else. A retry wrapped around a whole transfer would re-enter a
    partially written image, which is far worse than the race it would fix.
    """
    deadline = time.monotonic() + budget
    last = None
    for attempt in range(tries):
        left = deadline - time.monotonic()
        if left <= 1.0:
            raise ConnectFailed(f"could not reach {spec} within {budget:.0f}s "
                                f"({attempt} attempt(s)); last failure: {last}")
        client = None
        if attempt:
            print(f"    retry {attempt + 1}/{tries} after {last}")
        try:
            dev = await resolve(spec, adapter=adapter, timeout=max(5.0, min(20.0, left)))
            client = BleakClient(dev,
                                 timeout=max(5.0, min(timeout, deadline - time.monotonic())),
                                 disconnected_callback=disconnected_callback)
            await client.connect()
            # A connection is not usable until its services resolve, and connect() can return first.
            # Asking here keeps the failure where the answer is still a retry.
            _ = client.services
            return client
        except RuntimeError as e:                           # resolve() could not find it
            last = str(e)
        except Exception as e:                              # noqa: BLE001  connect races, refusals
            last = f"{type(e).__name__}: {e}"
            if client is not None:
                try:
                    await client.disconnect()               # never leave a half-open link behind
                except Exception:                           # noqa: BLE001
                    pass
        await asyncio.sleep(1.0 + attempt)
    raise ConnectFailed(
        f"could not reach {spec} after {tries} attempts -- last: {last}\n"
        "  If it IS in range (--list), this is your computer's Bluetooth rather than the thermostat:\n"
        "  turn Bluetooth off and on, or on Linux `bluetoothctl remove <MAC>` to drop a stale entry.")


# ---------------------------------------------------------------- what to install ----
# THE WEB PAGE READS THIS SAME FILE -- `../webapp/public/firmware/catalogue.json`, the same list,
# file names and SHA-256. One list means the two can never disagree about which versions exist, and
# neither can offer an image that is not on disk beside it.
def load_catalogue():
    path = os.path.join(FIRMWARE, "catalogue.json")
    if not os.path.isfile(path):
        sys.exit(f"no firmware catalogue at {os.path.normpath(path)} -- this folder is incomplete")
    return json.load(open(path))["releases"]


def pick(releases, want):
    """`--release X`, or the newest of ours. The list is written newest-first."""
    if want:
        for r in releases:
            if r["version"] == want:
                return r
        sys.exit(f"no release {want}. Offered: {', '.join(r['version'] for r in releases)}")
    ours = next((r for r in releases if r.get("mod")), None)
    if not ours:
        sys.exit("the catalogue offers no release of ours -- only stock. Pass --release to choose one.")
    return ours


def image(entry):
    """One chip's file, checked against the catalogue before a byte is sent.

    Not ceremony: these bytes are about to be written into a thermostat's flash, and a truncated or
    half-copied file looks exactly like a good one at the point of no return.
    """
    path = os.path.join(FIRMWARE, entry["file"])
    if not os.path.isfile(path):
        sys.exit(f"{entry['file']} is named by the catalogue but is not in {os.path.normpath(FIRMWARE)}")
    raw = open(path, "rb").read()
    # The hash is over the FILE; `bytes` is what REACHES THE DEVICE, and for the thermostat those
    # differ by exactly two -- its payload ships as hex TEXT, the form eQ-3's own updater used, so the
    # file is twice the firmware. Comparing the file's length against `bytes` fails every .enc.
    payload = len(bytes.fromhex("".join(raw.decode().split()))) if path.endswith(".enc") else len(raw)
    if payload != entry["bytes"]:
        sys.exit(f"{entry['file']} carries {payload} bytes of firmware, the catalogue says {entry['bytes']}")
    if hashlib.sha256(raw).hexdigest() != entry["sha256"]:
        sys.exit(f"{entry['file']} does not match its catalogue hash -- refusing to install it")
    return path


# ---------------------------------------------------------------- the thermostat ----
def parse_chunks(raw):
    """Split the payload into the chunks the bootloader expects: 2-byte length, then that many."""
    out, i = [], 0
    while i < len(raw):
        n = ((raw[i] << 8) | raw[i + 1]) + 2
        if n > len(raw) - i:
            break
        out.append(raw[i:i + n])
        i += n
    return out


async def flash_thermostat(client, enc_path, logfile, dropped, retries=4):
    """Send the thermostat's image chunk by chunk. Returns how it ended; see TOOK_IT.

    Burst every packet of a chunk, then read ONE chunk response. `a1 22` accepts it, `a1 33` asks for
    it again, `a1 44` ends the update. `a1 11` is a per-PACKET receipt and is not an answer to a
    chunk -- counting it as one shifts every later verdict by one and desyncs the stream into NACKs no
    retry can clear.
    """
    log_file = open(logfile, "w", buffering=1)
    t0 = time.time()

    def log(*a):
        # Silent once the run has ended: notifications keep arriving while the device reboots and the
        # callback is still registered, and writing to the closed log printed a traceback in the
        # middle of a SUCCESSFUL update, which reads exactly like a failure.
        if log_file.closed:
            return
        line = f"+{time.time() - t0:8.3f} " + " ".join(str(x) for x in a)
        log_file.write(line + "\n")

    queue, arrived = [], asyncio.Event()

    def on_notify(_sender, data):
        b = bytes(data)
        log("RX", b.hex())
        if b and b[0] == 0x02:                              # periodic status, not ours
            return
        if len(b) >= 2 and b[0] == 0xA1 and b[1] == 0x11:   # per-packet receipt
            return
        queue.append(b)
        arrived.set()

    async def next_reply(t=20.0):
        end = time.time() + t
        while time.time() < end:
            if queue:
                return queue.pop(0)
            arrived.clear()
            try:
                await asyncio.wait_for(arrived.wait(), max(0.05, end - time.time()))
            except asyncio.TimeoutError:
                return None
        return None

    def done(verdict):
        log("RESULT", verdict)
        log_file.close()
        return verdict

    raw = binascii.unhexlify(open(enc_path).read().strip())
    chunks = parse_chunks(raw)
    await client.start_notify(MCU_NOTIFY, on_notify)
    await asyncio.sleep(1.0)

    log("START", f"{len(chunks)} chunks from {enc_path}")
    queue.clear()
    await client.write_gatt_char(MCU_WRITE, bytes([0xA0]))   # enter update mode
    reply = await next_reply(25)
    if not reply or reply[0] != 0xA0:
        return done("ABORT_NO_FLASHMODE")
    while await next_reply(2.0) is not None:                 # drain anything left from a past attempt
        pass

    last_pct = -1
    for index, chunk in enumerate(chunks):
        for attempt in range(retries + 1):
            seq, off = 0, 0
            queue.clear()                                    # this chunk's answer, not a stale one
            while off < len(chunk):
                end = min(off + 14, len(chunk))
                packet = chunk[off:end] + bytes(14 - (end - off))
                await client.write_gatt_char(MCU_WRITE, bytes([0xA1, seq]) + packet)
                off, seq = end, seq + 1
            reply = await next_reply(20)
            while reply is not None and not (reply[0] == 0xA1 and len(reply) > 1
                                             and reply[1] in (0x22, 0x33, 0x44)):
                log("IGNORE", f"ch{index}", reply.hex(), "not a chunk verdict")
                reply = await next_reply(10)
            if reply is None:
                if dropped["v"] and index >= len(chunks) - 2:
                    return done("SELFBOOT_LASTCHUNK")
                log("TIMEOUT", f"ch{index} attempt{attempt}")
                continue
            if reply[1] == 0x44:
                return done("FINISHED")
            if reply[1] == 0x33:
                log("NACK", f"ch{index} attempt{attempt}")
                await asyncio.sleep(0.3)
                continue
            break                                            # a1 22, chunk accepted
        else:
            return done(f"NACK_GIVEUP_ch{index}")
        pct = (index + 1) * 100 // len(chunks)
        if pct >= last_pct + 10:
            print(f"    {pct}%")
            last_pct = pct

    log("DELIVERED", "all chunks; waiting for the restart")
    for _ in range(75):
        if dropped["v"]:
            return done("SELFBOOT")
        await asyncio.sleep(1)
    return done("NO_SELFBOOT")


# ---------------------------------------------------------------- the radio ----
def _bitrev(value, width):
    out = 0
    for i in range(width):
        if value & (1 << i):
            out |= 1 << (width - 1 - i)
    return out


def crc32_wiced(data):
    """Broadcom WICED CRC32 (poly 0x04C11DB7, bit-reversed in and out)."""
    crc = 0xFFFFFFFF
    for byte in data:
        crc ^= _bitrev(byte, 8) << 24
        for _ in range(8):
            crc = ((crc << 1) ^ 0x04C11DB7) & 0xFFFFFFFF if crc & 0x80000000 else (crc << 1) & 0xFFFFFFFF
    return _bitrev(crc, 32) ^ 0xFFFFFFFF


async def flash_radio(client, bin_path):
    """Send the radio's image over WICED OTA. True, False, or None when the link died at the verify.

    None is the honest answer, not a shrug: the chip applies the image and reboots at the verify step,
    so the connection dies before any status can come back. That is what a transfer that WORKED looks
    like, and it is also what a silent non-take looks like. Only comparing the bytes afterwards
    separates them, which needs a tool an owner does not have.
    """
    data = open(bin_path, "rb").read()
    crc = crc32_wiced(data)
    print(f"    {len(data)} bytes, CRC32 0x{crc:08X}")

    arrived, status = asyncio.Event(), [None]

    def on_notify(_sender, value):
        status[0] = value[0]
        arrived.set()

    async def send(payload, timeout=10.0):
        arrived.clear()
        status[0] = None
        await client.write_gatt_char(OTA_CONTROL, payload)
        try:
            await asyncio.wait_for(arrived.wait(), timeout)
        except asyncio.TimeoutError:
            return 255
        return status[0]

    await client.start_notify(OTA_CONTROL, on_notify)
    await asyncio.sleep(1.0)

    s = await send(struct.pack("<BH", 1, len(data)))
    if s != 0:
        print(f"    FAILED to prepare: {WS_STATUS.get(s, s)}")
        return False
    s = await send(struct.pack("<B", 2))
    if s != 0:
        print(f"    FAILED to start: {WS_STATUS.get(s, s)}")
        return False

    off, last_pct = 0, -1
    while off < len(data):
        end = min(off + 20, len(data))
        await client.write_gatt_char(OTA_DATA, data[off:end], response=True)
        off = end
        pct = off * 100 // len(data)
        if pct >= last_pct + 10:
            print(f"    {pct}%")
            last_pct = pct

    try:
        s = await send(struct.pack("<BI", 3, crc), timeout=30.0)
        await client.stop_notify(OTA_CONTROL)
    except Exception as e:                                   # noqa: BLE001  a drop here is expected
        print(f"    the link dropped at the verify step ({type(e).__name__}) -- that is the radio "
              f"applying the image and restarting, which is the normal ending")
        return None
    if s == 0:
        return True
    print(f"    Failed: {WS_STATUS.get(s, f'unknown status {s}')}")
    return False


# ---------------------------------------------------------------- doing it ----
async def main():
    ap = argparse.ArgumentParser(description="Update an eQ-3 CC-RT-BLE thermostat, both chips.")
    ap.add_argument("device", nargs="?", help="UUID (macOS), MAC (Linux), or a saved name")
    ap.add_argument("--release", help="version to install (default: the newest of ours)")
    ap.add_argument("--adapter", default=None, help="Linux Bluetooth adapter, e.g. hci0")
    ap.add_argument("--list", action="store_true", help="list the thermostats in range and stop")
    ap.add_argument("--versions", action="store_true", help="list the releases on offer and stop")
    ap.add_argument("--log", default=None, help="where to write the thermostat transfer log")
    args = ap.parse_args()

    if args.list:
        print("scanning for 15 s ...")
        found = await find_all(args.adapter)
        if not found:
            # AN EMPTY SCAN IS WEAK EVIDENCE, especially on macOS, which receives roughly a tenth of
            # the adverts a Linux computer does. Measured here: one 15 s scan found nothing and the
            # next two found the thermostat immediately, with nothing touched in between. Saying
            # "not found" without saying "scan again" sends people to look for a fault there is not.
            print("  nothing found -- but try again before believing it. A scan misses adverts,\n"
                  "  macOS especially, so an empty one often just means bad luck.\n"
                  "  If it stays empty: press a button on the thermostat to wake it, check it has\n"
                  "  batteries, and make sure nothing else is already connected to it.")
            return 1
        for dev, name in found:
            print(f"  {dev.address}   {name}")
        print(f"\nUse one of those addresses, or save it as a name in {ALIAS_PATH}:")
        print('  { "landing": "%s" }' % found[0][0].address)
        return 0

    releases = load_catalogue()
    if args.versions:
        for r in releases:
            print(f"  {r['version']:5}  {'ours ' if r.get('mod') else 'stock'}")
        return 0
    if not args.device:
        ap.error("name a thermostat, or use --list to find one")

    rel = pick(releases, args.release)
    stm8_img, radio_img = image(rel["stm8"]), image(rel["radio"])
    log = args.log or os.path.join(tempfile.gettempdir(),
                                   f"eq3-update-{rel['version']}-{int(time.time())}.log")

    print(f"release {rel['version']}" + ("  (ours)" if rel.get("mod") else "  (stock eQ-3)"))
    if rel.get("note"):
        print(f"  {rel['note']}")

    # ONE CONNECTION CARRIES BOTH TRANSFERS, and the order is fixed by which chip is which.
    #
    # The radio IS this link, so flashing it ends the connection -- nothing can be scheduled after
    # it, and thermostat-then-radio is the only order there is. The thermostat's transfer, by
    # contrast, cannot disturb the radio at all: measured, a full 236-chunk one logs zero disconnects
    # and ends on the bootloader's acknowledgement. So reconnecting in between would be inventing
    # work.
    #
    # flash_thermostat's restart verdicts need to know whether the device dropped the link, so the
    # flag belongs to whoever owns the connection.
    dropped = {"v": False}
    print(f"\nconnecting to {args.device} ...")
    client = await connect(args.device, adapter=args.adapter, timeout=20,
                           disconnected_callback=lambda _c: dropped.update(v=True))
    try:
        print(f"\n1/2 thermostat: {rel['stm8']['file']}  ({rel['stm8']['bytes']} bytes)")
        verdict = await flash_thermostat(client, stm8_img, log, dropped)
        print(f"    ended: {verdict}")
        # THE GATE IS THE BOOTLOADER'S OWN WORD, AND NOTHING IS ASKED OF THE APPLICATION.
        #
        # `TOOK_IT` is how the transfer ENDED, which is the code that did the writing reporting on
        # itself. Reading the version back instead would REFUSE GOOD UPDATES: a freshly flashed
        # thermostat busy-waits through its start-up without servicing its serial line, for as long
        # as the valve motor takes -- up to about a minute -- and for exactly that long "no answer
        # yet" and "it failed" are the same thing on the wire.
        if verdict not in TOOK_IT:
            print(f"\nthe thermostat did not take its image, so THE RADIO HAS NOT BEEN TOUCHED.\n"
                  f"It still has the firmware it started with and can be updated again.\n"
                  f"Details: {log}")
            return 1

        # Drop the thermostat's reply subscription before the radio transfer shares this link.
        try:
            await client.stop_notify(MCU_NOTIFY)
        except Exception:                                    # noqa: BLE001
            pass

        print(f"\n2/2 radio: {rel['radio']['file']}  ({rel['radio']['bytes']} bytes)  ~2 minutes")
        await flash_radio(client, radio_img)
    finally:
        # The radio reboots into its new image at the verify step, so the link is usually gone
        # already and this raises. That is the ordinary ending, not an error.
        try:
            await client.disconnect()
        except Exception:                                    # noqa: BLE001
            pass

    print(f"\nDONE -- {args.device} is on {rel['version']}, both chips.")
    if rel.get("mod"):
        print("Set the date to finish: the thermostat does nothing until you do, from the web page "
              "or from eQ-3's app.")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
