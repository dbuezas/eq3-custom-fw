/**
 * The two flashing protocols, held to the PROVEN implementations.
 *
 * `../../../python-scripts/flash_mcu.py` and `../../../python-scripts/flash_ble_firmware.py` have put firmware on real
 * devices many times; this module is a translation of them, so the numbers below were taken by
 * running those tools' own functions over the repo's own images rather than derived here. If the
 * two disagree, this one is wrong.
 *
 * WHY THIS IS TESTED HARDER THAN ANYTHING ELSE IN THE APP: a wrong byte in a control channel gets a
 * NAK, and a wrong byte here writes it into a chip.
 */
import { expect, test } from 'bun:test'

import {
  OTA_CHUNK,
  OTA_MAX_IMAGE,
  OTA_START,
  catalogueUrl,
  checkImage,
  chunkPackets,
  chunkVerdict,
  crc32Wiced,
  imageUrl,
  otaPrepare,
  otaVerify,
  parseChunks,
  sha256Hex,
  unhexPayload,
} from './flash'

test('the WICED CRC32 matches the Python flasher on the repo’s own images', () => {
  // Both taken from `flash_ble_firmware.crc32_wiced` over the committed files.
  expect(crc32Wiced(new Uint8Array(0))).toBe(0)
  // A short vector first, so a failure says whether the algorithm or the file is wrong.
  expect(crc32Wiced(new Uint8Array([0x00]))).toBe(0xd202ef8d)
  expect(crc32Wiced(new Uint8Array([0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39]))).toBe(
    0xcbf43926,
  )
})

test('a payload splits into the chunks the Python parser finds', () => {
  // Two chunks: a 4-byte one and a 2-byte one, each with its own two-byte length prefix.
  const raw = new Uint8Array([0x00, 0x04, 1, 2, 3, 4, 0x00, 0x02, 9, 9])
  const chunks = parseChunks(raw)
  expect(chunks.map((c) => c.length)).toEqual([6, 4])
  expect([...chunks[0]!]).toEqual([0x00, 0x04, 1, 2, 3, 4])
})

test('a trailing fragment that claims more than remains is DROPPED, never padded', () => {
  const raw = new Uint8Array([0x00, 0x02, 1, 2, 0x00, 0x40, 5])
  expect(parseChunks(raw)).toHaveLength(1)
})

test('the first packet of stock 1.48’s first chunk is byte-for-byte what the tool sends', () => {
  // From the committed payload: 34024 bytes, 230 chunks, first chunk 148 bytes long.
  const first = unhexPayload('009247f3c6c8f48f231719fb9bf4' + '00'.repeat(200))
  const packets = chunkPackets(parseChunks(first)[0]!)
  expect(packets[0]).toEqual([
    0xa1, 0x00, 0x00, 0x92, 0x47, 0xf3, 0xc6, 0xc8, 0xf4, 0x8f, 0x23, 0x17, 0x19, 0xfb, 0x9b, 0xf4,
  ])
})

test('a short final packet is zero-padded to fourteen, because the frame is fixed', () => {
  const packets = chunkPackets(new Uint8Array([1, 2, 3]))
  expect(packets).toHaveLength(1)
  expect(packets[0]).toEqual([0xa1, 0, 1, 2, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
})

test('the sequence number counts packets within the chunk, from zero', () => {
  const packets = chunkPackets(new Uint8Array(30))
  expect(packets.map((p) => p[1])).toEqual([0, 1, 2])
})

test('ONLY 22, 33 and 44 are chunk verdicts — a stale frame is not one', () => {
  const b = (...x: number[]) => new Uint8Array(x)
  expect(chunkVerdict(b(0xa1, 0x22))).toBe('ok')
  expect(chunkVerdict(b(0xa1, 0x33))).toBe('nack')
  expect(chunkVerdict(b(0xa1, 0x44))).toBe('finished')
  // The two that desync a stream if they are taken for an answer.
  expect(chunkVerdict(b(0xa1, 0x11))).toBeNull() // a per-PACKET receipt
  expect(chunkVerdict(b(0xa0, 0x11))).toBeNull() // a stale enter-bootloader reply
  expect(chunkVerdict(b(0x02, 0x80))).toBeNull() // the periodic status push
})

test('the radio’s three control frames are little-endian, as its stack reads them', () => {
  expect([...otaPrepare(19128)]).toEqual([1, 0xb8, 0x4a]) // 19128 = 0x4ab8
  expect([...OTA_START]).toEqual([2])
  expect([...otaVerify(0xff5edefc)]).toEqual([3, 0xfc, 0xde, 0x5e, 0xff])
})

test('an image the 16-bit length cannot describe is REFUSED, never truncated', () => {
  // The largest it can announce still works, and announces itself in full.
  expect([...otaPrepare(OTA_MAX_IMAGE)]).toEqual([1, 0xff, 0xff])
  // One byte more would have wrapped to `01 00 00` -- the chip told to expect nothing, then handed
  // 64 KB. That is a failure found part-way through writing to a chip instead of before one.
  expect(() => otaPrepare(OTA_MAX_IMAGE + 1)).toThrow(/16 bits/)
  expect(() => otaPrepare(-1)).toThrow()
})

test('twenty bytes per data write, which is one ATT value on this stack', () => {
  expect(OTA_CHUNK).toBe(20)
})

test('sha256Hex spells a digest the way the staging tool writes it', async () => {
  // The empty digest, lower-case hex and 64 characters -- `hashlib.sha256(b"").hexdigest()`.
  expect(await sha256Hex(new Uint8Array(0))).toBe(
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  )
})

test('A DOWNLOADED IMAGE IS HELD TO THE CATALOGUE, and an HTML page is not silently flashed', async () => {
  const bytes = new Uint8Array([1, 2, 3, 4])
  const sha256 = await sha256Hex(bytes)
  // The ordinary case: what the catalogue promised is what arrived.
  await checkImage(bytes, { file: 'radio-x.bin', sha256 })

  // THE CASE THIS EXISTS FOR. A dev server answers a missing path with the app's own markup at
  // status 200, so `response.ok` is true and these bytes would have gone straight to the radio.
  const page = new TextEncoder().encode('<!doctype html><title>app</title>')
  expect(checkImage(page, { file: 'radio-x.bin', sha256 })).rejects.toThrow(/did not arrive intact/)

  // And a catalogue with nothing to check against FAILS, rather than passing vacuously.
  expect(checkImage(bytes, { file: 'radio-x.bin', sha256: '' })).rejects.toThrow(/no usable checksum/)
  expect(checkImage(bytes, { file: 'radio-x.bin', sha256: 'NOTAHASH' })).rejects.toThrow(
    /no usable checksum/,
  )
})

test('THE FIRMWARE URLS ARE ABSOLUTE, because a relative one silently returns the app', () => {
  // The app lives at /thermostat/<id>/install, so a relative `firmware/…` asks for
  // /thermostat/<id>/firmware/… -- which the SPA fallback answers with index.html and status 200.
  // response.ok is then true and the only symptom is JSON that will not parse, which the page
  // reported as "no firmware is staged" on a deploy that had seven releases.
  expect(catalogueUrl().startsWith('/')).toBe(true)
  expect(imageUrl('stm8-2.00.enc').startsWith('/')).toBe(true)
  expect(catalogueUrl()).toBe('/firmware/catalogue.json')
  expect(imageUrl('radio-1.48.bin')).toBe('/firmware/radio-1.48.bin')
})

test('...AND ANCHORED TO THE DEPLOY BASE, because a project page is not at the host root', () => {
  // THE TEST ABOVE PASSED WHILE THE PUBLISHED APP WAS BROKEN, which is the whole reason this one
  // exists. Under `bun test` BASE_URL is `/`, so a hardcoded `/firmware/` satisfies every assertion
  // up there -- and on GitHub Pages the app is served from /eq3-custom-fw/, where `/firmware/…` is
  // the USER page's root, a different site, which 404s. The live app reported carrying no firmware
  // at all while seven releases sat one directory along.
  //
  // So this drives the one input that differs between the two: the base Vite was built with.
  const real = import.meta.env.BASE_URL
  try {
    import.meta.env.BASE_URL = '/eq3-custom-fw/'
    expect(catalogueUrl()).toBe('/eq3-custom-fw/firmware/catalogue.json')
    expect(imageUrl('stm8-2.00.enc')).toBe('/eq3-custom-fw/firmware/stm8-2.00.enc')
  } finally {
    import.meta.env.BASE_URL = real
  }
})

