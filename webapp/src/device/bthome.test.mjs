// Hold bthome.js to the PYTHON decoder, on adverts that really came off the air.
//
//   bun run test          (or: node src/device/bthome.test.mjs [fixture.json])
//
// The default fixture is SYNTHETIC, built by `make_fixture.py` with a DUMMY key using
// `ble_chip/mod/bthome_crypto.py` -- the same module the firmware's encrypt side is checked against
// and the scanners decrypt with. So a pass means this decoder and the repo's canonical crypto agree
// byte for byte, and no secret had to be committed to say so. A fixture made from real captured
// adverts can be passed instead; it needs the device's bind key, which is why it is not in the tree.
//
// IT USES ONLY WebCrypto (globalThis.crypto.subtle), which is what a browser has. node's own
// aes-128-ccm would pass here and fail in a page, so testing through it would prove nothing.
//
// THIS TEST IS THE REASON bthome.js IS NOT TYPESCRIPT. It is the evidence that the decoder is
// right; a rewrite for types would put that at risk to gain nothing a `.d.ts` does not already give.
//
// IT IS ITS OWN RUNNER AND ENDS IN process.exit, SO `bun test` MUST NOT PICK IT UP. Bun would load
// this file like any other and the exit would tear down the whole run -- every later test file
// simply never runs, and the output still ends in "0 fail". That is why `package.json` filters bun
// to `.test.ts`/`.test.tsx` rather than pointing it at `src`, and why this file keeps its `.mjs`.
import { readFileSync } from "node:fs";
import { decryptAdvert, decodeObjects, macBytes, unhex, hex, isEncrypted } from "./bthome.js";

const here = new URL(".", import.meta.url).pathname;
const gt = JSON.parse(readFileSync(process.argv[2] ?? here + "bthome_fixture.json", "utf8"));
const key = unhex(gt.key);
const mac = macBytes(gt.mac);

let pass = 0, fail = 0;
for (const a of gt.adverts) {
  const payload = unhex(a.raw);
  if (!a.plaintext) { console.log(`SKIP ${a.raw} (python: ${a.error})`); continue; }
  try {
    const { objects, counter } = await decryptAdvert(key, mac, payload);
    const got = hex(objects);
    const okP = got === a.plaintext;
    const okC = counter === a.counter;
    const dec = decodeObjects(objects);
    console.log(`${okP && okC ? "ok  " : "FAIL"} enc=${isEncrypted(payload)} ctr=${counter}` +
                ` ${got}${okP ? "" : `  != python ${a.plaintext}`}` +
                `${okC ? "" : `  counter != ${a.counter}`}`);
    console.log(`     -> ${JSON.stringify(dec.values)}` +
                (dec.unknown.length ? `  UNKNOWN ids ${dec.unknown.map((x) => "0x" + x.toString(16))}` : ""));
    if (okP && okC) pass++; else fail++;
  } catch (e) {
    console.log(`FAIL ${a.raw}: ${e.message}`);
    fail++;
  }
}

// A wrong key must be REPORTED, not silently decoded into plausible values.
const bad = unhex(gt.key.slice(0, -2) + (gt.key.slice(-2) === "00" ? "01" : "00"));
let rejected = false;
for (const a of gt.adverts) {
  if (!a.plaintext) continue;
  try { await decryptAdvert(bad, mac, unhex(a.raw)); } catch { rejected = true; }
  break;
}
console.log(`${rejected ? "ok  " : "FAIL"} a wrong key is rejected by the tag, not silently decoded`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 && rejected ? 0 : 1);
