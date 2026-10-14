// Double Ratchet (Signal spec, https://signal.org/docs/specifications/doubleratchet/)
// over P-256 + HKDF/HMAC-SHA-256 + AES-256-GCM.
//
// Every message gets a fresh key that is deleted after use (forward secrecy), and every
// round trip mixes in a fresh DH (post-compromise security: a stolen state heals itself).
// Wire: header(dh 65 | pn u32 | n u32) || AES-GCM ciphertext. Header is authenticated, not hidden.
// TODO(debt): header encryption (spec §4) would hide message counters from the relay.

import { concat, u32, readU32, equal, hex } from './bytes.js';
import { dhKeyPair, dh, hkdf, hmac, seal, open, DecryptError } from './primitives.js';

const HEADER_LEN = 73;
const MAX_SKIP = 2000;     // max keys derived for one gap — stops a "n = 2^32" DoS
const MAX_STORED = 4000;   // total skipped keys kept; oldest evicted first

async function kdfRk(rk, dhOut) {
  const out = await hkdf(dhOut, rk, 'hush/rk', 64);
  return [out.slice(0, 32), out.slice(32)];
}

async function kdfCk(ck) {
  const [mk, next] = await Promise.all([hmac(ck, Uint8Array.of(1)), hmac(ck, Uint8Array.of(2))]);
  return [mk, next];
}

async function msgKey(mk) {
  const out = await hkdf(mk, null, 'hush/msg', 44);
  return [out.slice(0, 32), out.slice(32)];
}

const encodeHeader = (pub, pn, n) => concat(pub, u32(pn), u32(n));

function decodeHeader(wire) {
  if (wire.length < HEADER_LEN + 16) throw new DecryptError('message too short');
  return { dh: wire.slice(0, 65), pn: readU32(wire, 65), n: readU32(wire, 69), raw: wire.subarray(0, HEADER_LEN) };
}

export class Ratchet {
  #s;
  #ad;
  #q = Promise.resolve(); // serialize: decrypt mutates state across awaits

  constructor(state, ad) { this.#s = state; this.#ad = ad; }

  /** Initiator: knows the other side's ratchet public key, can send immediately. */
  static async alice(sk, bobPub, ad) {
    const DHs = await dhKeyPair();
    const [RK, CKs] = await kdfRk(sk, await dh(DHs.priv, bobPub));
    return new Ratchet({ DHs, DHr: bobPub, RK, CKs, CKr: null, Ns: 0, Nr: 0, PN: 0, skipped: new Map() }, ad);
  }

  /** Responder: must receive once before it can send. */
  static bob(sk, bobPair, ad) {
    return new Ratchet({ DHs: bobPair, DHr: null, RK: sk, CKs: null, CKr: null, Ns: 0, Nr: 0, PN: 0, skipped: new Map() }, ad);
  }

  get canSend() { return this.#s.CKs !== null; }

  encrypt(pt) {
    return this.#serial(async () => {
      const s = this.#s;
      if (!s.CKs) throw new Error('ratchet cannot send before first receive');
      const [mk, CKs] = await kdfCk(s.CKs);
      const header = encodeHeader(s.DHs.pub, s.PN, s.Ns);
      this.#s = { ...s, CKs, Ns: s.Ns + 1 };
      const [key, iv] = await msgKey(mk);
      return concat(header, await seal(key, iv, pt, concat(this.#ad, header)));
    });
  }

  decrypt(wire) {
    return this.#serial(async () => {
      const h = decodeHeader(wire);
      const ct = wire.subarray(HEADER_LEN);
      // Work on a copy; commit only if the AEAD tag verifies (forged messages can't corrupt state).
      const s = { ...this.#s, skipped: new Map(this.#s.skipped) };

      const id = `${hex(h.dh)}:${h.n}`;
      const stored = s.skipped.get(id);
      if (stored) {
        s.skipped.delete(id);
        const pt = await this.#open(stored, h.raw, ct);
        this.#s = s;
        return pt;
      }

      if (!s.DHr || !equal(h.dh, s.DHr)) {
        await skip(s, h.pn);
        s.PN = s.Ns; s.Ns = 0; s.Nr = 0; s.DHr = h.dh;
        [s.RK, s.CKr] = await kdfRk(s.RK, await dh(s.DHs.priv, s.DHr));
        s.DHs = await dhKeyPair();
        [s.RK, s.CKs] = await kdfRk(s.RK, await dh(s.DHs.priv, s.DHr));
      }
      await skip(s, h.n);
      const [mk, CKr] = await kdfCk(s.CKr);
      s.CKr = CKr; s.Nr += 1;
      const pt = await this.#open(mk, h.raw, ct);
      this.#s = s;
      return pt;
    });
  }

  async #open(mk, header, ct) {
    const [key, iv] = await msgKey(mk);
    return open(key, iv, ct, concat(this.#ad, header));
  }

  #serial(fn) {
    const run = this.#q.then(fn, fn);
    this.#q = run.catch(() => {});
    return run;
  }
}

async function skip(s, until) {
  if (!s.CKr) return;
  if (until - s.Nr > MAX_SKIP) throw new DecryptError('too many skipped messages');
  const tag = hex(s.DHr);
  while (s.Nr < until) {
    const [mk, ck] = await kdfCk(s.CKr);
    s.skipped.set(`${tag}:${s.Nr}`, mk);
    s.CKr = ck; s.Nr += 1;
    if (s.skipped.size > MAX_STORED) s.skipped.delete(s.skipped.keys().next().value);
  }
}
