/**
 * The SEALED command envelope — how a command and its reply are wrapped once this app holds a key.
 *
 * ================================================================================================
 * THIS IS A PORT, NOT A DESIGN. `ble_chip/mod/bthome_crypto.py` IS THE AUTHORITY
 * ================================================================================================
 * Every constant, offset and byte order below is that file's, and the device's firmware is the other
 * end of it. Nothing here may be adjusted to make a test pass: if this disagrees with the Python,
 * the Python is right and this is broken. `sealed.test.ts` holds the two together on fixtures the
 * Python generated, which is the only reason a second implementation is safe to have at all.
 *
 * **WHY SEAL AT ALL, when the plaintext door is open anyway.** Two reasons, and the second is the
 * one that matters day to day. Holding the key is what admits you to the encrypted door, so an app
 * that decodes the broadcast and then shouts every command in the clear is choosing the weaker of
 * two channels it is already equipped for. And **with the thermostat's PIN gate on, the plaintext
 * characteristic answers an unpaired browser `Insufficient Authentication` while the sealed one
 * still works** — so this is also the app's only way into a gated thermostat, which it otherwise
 * has none of.
 *
 * ---- the shapes ---------------------------------------------------------------------------------
 *
 *   downlink, inline (1..8 inner bytes)   55 | seq(2 LE) | mic(4) | len | ct[len]
 *   downlink, staged (9..16 inner bytes)  57 | off | n | ct[n]  …then…  58 | seq(2 LE) | mic(4) | len
 *   uplink                                55 | ctr(2 LE) | ct[…] | mic(4)      last or only fragment
 *                                         59 | ctr(2 LE) | ct[…] | mic(4)      more to follow
 *
 * **ONE 16-BYTE WRITE CARRIES ONLY 8 INNER BYTES**, because the header spends the other eight. That
 * is not a limit on what can be sent — the staging pair covers the full 16 the command attribute
 * holds, which is also the widest bare command there is (`cmd 0x0F`, panel paint) — so encryption
 * costs no reach. It does mean the long commands, the schedule writes, take three writes instead of
 * one, and every one of them still goes through the single-write-in-flight queue.
 *
 * **THE DIRECTION BYTE IN THE NONCE IS NOT DECORATION.** Both directions share one key and one
 * session nonce, so without it a reply would share its keystream with the command that triggered
 * it; commands are low-entropy, so one captured pair would give up the reply.
 */
import { ccmOpen, ccmSeal } from './bthome'

/** A sealed frame, in BOTH directions. */
export const MAGIC_ENC = 0x55
/** A sealed reply FRAGMENT with more to follow; `MAGIC_ENC` marks the last or only one. */
export const MAGIC_ENC_FRAG = 0x59

const DIR_DOWN = 0x00
const DIR_UP = 0x01
/** CCM's M. A parameter of the B0 block, never a runtime choice. */
const MIC_LEN = 4
/** Uplink header: `55 | ctr(2 LE)`. */
const UP_HDR = 3

/** What is left of a 16-byte write once the inline header has taken its eight. */
export const ENV_MAXIN = 8
/** The command attribute's own value size — the most any command can be, sealed or bare. */
export const ENV_MAXCOMMIT = 16
/** A staging write is `57 | off | n` and then this many bytes. */
const STAGE_MAXN = 13

/** The one-byte request that asks the device for this connection's session nonce. */
export const NONCE_REQUEST = [0x56]
/** How long the answer is. Used to recognise it — see the trap in `link.ts`. */
export const NONCE_LEN = 8

/**
 * THE IDS THE DEVICE ANSWERS IN THE CLEAR EVEN WITH A KEY IN FORCE, and sealing one breaks it.
 *
 * This mirrors the radio's own pass-list in `ble_chip/mod/bthome.S` exactly, and it has to.
 * `0x52`/`0x53`/`0x54` are the debug oracle, handled ON the radio before the sealing check runs, so
 * a sealed one is opened, unwrapped and passed to the thermostat — which does not know those ids and
 * rejects it. They are the RECOVERY PATH and are unauthenticated on purpose. `0x56` is the nonce
 * request, the bootstrap: a client that cannot ask for the nonce cannot encrypt anything at all.
 */
export const PLAINTEXT_IDS = new Set([0x52, 0x53, 0x54, 0x56])

/**
 * `Uint8Array<ArrayBuffer>`, not the default `ArrayBufferLike`, and the annotation is load-bearing:
 * a frame built here is handed to `writeValueWithResponse`, whose `BufferSource` refuses a view that
 * might sit on a `SharedArrayBuffer`. Building from an array-like always allocates a plain buffer,
 * so this narrows a type rather than asserting something untrue.
 */
const u8 = (a: ArrayLike<number>): Uint8Array<ArrayBuffer> => new Uint8Array(a)

/** The 13 bytes both sides feed CCM. 13 is what makes L = 2, which is what the radio is built for. */
function connNonce(session: Uint8Array, counter: number, direction: number): Uint8Array {
  const n = new Uint8Array(13)
  n.set(session)
  n[session.length] = counter & 0xff
  n[session.length + 1] = (counter >> 8) & 0xff
  n[session.length + 2] = direction
  return n // the last two bytes stay zero
}

/**
 * One inline write: `55 | seq(2 LE) | mic(4) | len | ct[len]`.
 *
 * THROWS rather than truncating. A silently shortened command would be sealed, accepted and wrong,
 * which is worse than a refusal — anything longer belongs in `stageCommand`.
 */
export async function sealCommand(
  key: Uint8Array,
  session: Uint8Array,
  seq: number,
  inner: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  if (inner.length === 0 || inner.length > ENV_MAXIN)
    throw new Error(
      `inner command is ${inner.length} B; ONE write carries 1..${ENV_MAXIN} inline. ` +
        'Use stageCommand() for anything longer.',
    )
  const { ct, mic } = await ccmSeal(key, connNonce(session, seq, DIR_DOWN), inner)
  return u8([MAGIC_ENC, seq & 0xff, (seq >> 8) & 0xff, ...mic, ct.length, ...ct])
}

/**
 * The writes for a command too long to sit beside its own header: staging chunks, then a commit.
 *
 * Staging is unauthenticated and safe: the tag checked at commit covers every byte of the buffer, so
 * a stranger who scribbles there can make a commit FAIL, which they could do by saying nothing at
 * all.
 */
export async function stageCommand(
  key: Uint8Array,
  session: Uint8Array,
  seq: number,
  inner: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>[]> {
  if (inner.length === 0 || inner.length > ENV_MAXCOMMIT)
    throw new Error(
      `inner command is ${inner.length} B; the command attribute holds ${ENV_MAXCOMMIT}, ` +
        'so nothing longer reaches the thermostat encrypted OR bare.',
    )
  const { ct, mic } = await ccmSeal(key, connNonce(session, seq, DIR_DOWN), inner)
  const out: Uint8Array<ArrayBuffer>[] = []
  for (let off = 0; off < ct.length; off += STAGE_MAXN) {
    const part = ct.slice(off, off + STAGE_MAXN)
    out.push(u8([0x57, off, part.length, ...part]))
  }
  out.push(u8([0x58, seq & 0xff, (seq >> 8) & 0xff, ...mic, ct.length]))
  return out
}

export type Opened = { data: Uint8Array; ctr: number | null; more: boolean }

/**
 * Open one notification. `ctr` is null when the frame was not sealed at all, and `data` is then what
 * arrived, untouched.
 *
 * **THE NOTIFY CHANNEL IS MIXED, by design**: only the thermostat's relayed replies are encrypted,
 * so the radio's own status codes and its serial still arrive in the clear on the same handle.
 * `MAGIC_ENC` is what separates the two and **LENGTH CANNOT** — a sealed 1-byte reply is exactly
 * eight bytes, the length of the nonce answer. Every caller that matches a reply by length must
 * apply this test first.
 *
 * `more` is the fragment marker, and reassembly is deliberately NOT done here: it needs
 * per-connection state and a counter check, both of which live in `link.ts`.
 */
export async function openReply(
  key: Uint8Array,
  session: Uint8Array,
  raw: Uint8Array,
): Promise<Opened> {
  const sealed = raw.length >= UP_HDR + MIC_LEN && (raw[0] === MAGIC_ENC || raw[0] === MAGIC_ENC_FRAG)
  if (!sealed) return { data: raw, ctr: null, more: false }
  const ctr = raw[1]! | (raw[2]! << 8)
  const body = raw.slice(UP_HDR)
  const data = await ccmOpen(
    key,
    connNonce(session, ctr, DIR_UP),
    body.slice(0, -MIC_LEN),
    body.slice(-MIC_LEN),
    'sealed reply tag mismatch — the stored key does not match the one the thermostat holds.',
  )
  return { data, ctr, more: raw[0] === MAGIC_ENC_FRAG }
}

const join = (a: Uint8Array, b: Uint8Array) => {
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

/**
 * Put a fragmented reply back together.
 *
 * ================================================================================================
 * A COMPLETE FRAME IS DELIVERED WHATEVER ITS COUNTER SAYS
 * ================================================================================================
 * A reply too wide for one air-safe notification is split rather than truncated, and the marker byte
 * says whether another follows. A buffered partial is the ONLY evidence that a fragmented message is
 * in flight, so a tail is joined to the head we really saw and the uplink counter is consulted for
 * nothing but pairing those two.
 *
 * **DO NOT GATE DELIVERY ON THAT COUNTER** `[owner]`. It steps by one per NOTIFICATION, so a gap
 * does mean one went missing — but dropping the next complete frame on that evidence cost a whole
 * evening: the first reply of a connection is not always counter 0 and was thrown away, and after
 * ANY missed notification the next good reply was swallowed too, so one loss became two, silently,
 * presenting as a command that simply never answered (the thermostat's version went missing on every
 * encrypted connection for exactly that reason). A frame is authenticated either way, so the honest
 * thing is to deliver it and let the caller's matcher reject a shape it did not want — a matcher
 * rejecting a frame is recoverable; a reply deleted here is not, because nothing knows it existed.
 *
 * One of these per connection, and never carried across one, so a partial left over from the last
 * session cannot splice into this one's first reply.
 */
export function reassembler() {
  let buf: Uint8Array | null = null
  let bufCtr: number | null = null
  const next = (n: number) => (n + 1) & 0xffff
  return {
    /** -> the complete plaintext, or null when there is nothing to deliver yet (or ever). */
    push(o: Opened): Uint8Array | null {
      const ctr = o.ctr!
      // A partial is only continued by the VERY NEXT counter; anything else abandons it rather than
      // splicing unrelated bytes into it.
      if (buf && (bufCtr === null || ctr !== next(bufCtr))) buf = null
      if (o.more) {
        buf = buf ? join(buf, o.data) : o.data
        bufCtr = ctr
        return null
      }
      // Delivered whatever the counter says -- see the header before adding a check here.
      const whole = buf ? join(buf, o.data) : o.data
      buf = null
      bufCtr = null
      return whole
    },
    /** Forget any partial — used when a frame fails to open, which proves nothing about the rest. */
    reset() {
      buf = null
      bufCtr = null
    },
  }
}

export type Reassembler = ReturnType<typeof reassembler>
