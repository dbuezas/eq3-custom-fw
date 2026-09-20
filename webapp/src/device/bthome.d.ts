/**
 * Types for `bthome.js`, which stays plain JS on purpose — see its header. This file gives callers
 * full typing without touching a decoder that currently passes against the Python implementation.
 */

export declare const hex: (b: Uint8Array | number[]) => string
export declare const unhex: (s: string) => Uint8Array

/** MAC in PRINTED order (`00:1a:22:…`); separators are stripped. */
export declare const macBytes: (s: string) => Uint8Array

/** `device_info` bit 0 — the objects are encrypted. */
export declare const isEncrypted: (payload: Uint8Array) => boolean

/**
 * AES-CCM at this device's parameters — M = 4, L = 2, a 13-byte nonce, no associated data.
 *
 * `bthome.js` holds the one implementation, and the reason WebCrypto makes it CTR plus CBC.
 */
export declare function ccmSeal(
  keyRaw: Uint8Array,
  nonce: Uint8Array,
  plain: Uint8Array,
): Promise<{ ct: Uint8Array; mic: Uint8Array }>

/** The inverse. THROWS `what` on a bad tag, which is the ordinary failure. */
export declare function ccmOpen(
  keyRaw: Uint8Array,
  nonce: Uint8Array,
  ct: Uint8Array,
  mic: Uint8Array,
  what: string,
): Promise<Uint8Array>

/**
 * Decrypt one BThome v2 service-data payload. THROWS on a bad tag, which a caller must never turn
 * into "the device is not advertising" — `bthome.js` has why.
 */
export declare function decryptAdvert(
  keyRaw: Uint8Array,
  mac: Uint8Array,
  payload: Uint8Array,
): Promise<{ objects: Uint8Array; counter: number }>

export type BthomeValue = number | boolean | string

/** One object in the order it appeared on the wire. */
export type BthomeObject = { id: number; name: string; value: BthomeValue }

export type DecodedObjects = {
  /** By name; a REPEATED id gets a `#2` suffix rather than overwriting — see `bthome.js`. */
  values: Record<string, BthomeValue>
  /** Wire order, which is the only thing that separates two objects sharing an id. */
  list: BthomeObject[]
  /** An unrecognised id STOPS the walk — the table is what gives each object its length. */
  unknown: number[]
}

export declare function decodeObjects(plain: Uint8Array): DecodedObjects
