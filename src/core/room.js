// A room is a passphrase. PBKDF2 splits it into two unrelated halves:
//   roomId — what the relay sees, used only to group sockets.
//   psk    — mixed into every pairwise handshake. The relay never learns it, so it cannot
//            man-in-the-middle the key exchange without first brute-forcing the passphrase.

import { pbkdf2, hkdf } from './primitives.js';
import { hex, utf8, concat, random } from './bytes.js';
import { WORDS } from './words.js';

export const ROOM_ITERATIONS = 600_000; // OWASP 2023 guidance for PBKDF2-SHA256
const SALT = utf8('parley/room/v1');

export function normalizePassphrase(p) {
  if (typeof p !== 'string') throw new TypeError('passphrase must be a string');
  const n = p.normalize('NFKC').toLowerCase().trim().split(/[\s\-_.,]+/).filter(Boolean).join('-');
  if (n.length < 8) throw new Error('passphrase too short (min 8 chars)');
  return n;
}

export async function deriveRoom(passphrase, iterations = ROOM_ITERATIONS) {
  const out = await pbkdf2(normalizePassphrase(passphrase), SALT, iterations, 48);
  return { roomId: hex(out.subarray(0, 16)), psk: out.slice(16) };
}

/** 8 words × 8 bits = 64 bits. Plenty against a relay that must also pay 600k PBKDF2 rounds per guess. */
export const generatePassphrase = (n = 8) => Array.from(random(n), (b) => WORDS[b]).join('-');

/** Pairwise secrets. `lo`/`hi` are the two hello keys in byte order, so both sides agree. */
export async function pairSecrets(dhOut, psk, lo, hi) {
  const info = (label) => concat(utf8(label), lo, hi);
  const [sk, ad, sas] = await Promise.all([
    hkdf(dhOut, psk, info('parley/sk'), 32),
    hkdf(dhOut, psk, info('parley/ad'), 32),
    hkdf(dhOut, psk, info('parley/sas'), 5),
  ]);
  // Safety words: computed from the shared secret, so a man in the middle gets different words on each side.
  return { sk, ad, safetyWords: Array.from(sas, (b) => WORDS[b]) };
}
