// Two extra locks that live *inside* the ratchet layer.
//
// Riddle: the message key is PBKDF2(answer). Even the recipient's own device can't read it
//         without the answer. The engine allows a few guesses, then destroys the ciphertext.
//         (A modified client could keep guessing offline — PBKDF2 makes each guess cost ~0.2s.)
//
// Capsule: commit now, reveal later. Ciphertext + SHA-256(key) go out immediately; the key
//          follows at the open time. The recipient can check the key matches the commitment,
//          so the sender can't swap the message after the fact. If the sender vanishes
//          before the open time, the capsule stays sealed forever.

import { pbkdf2, seal, open, sha256 } from './primitives.js';
import { random, utf8, fromUtf8, b64u, fromB64u, equal } from './bytes.js';

export const RIDDLE_ITERATIONS = 300_000;
export const RIDDLE_TRIES = 5;
export const CAPSULE_MAX_MS = 7 * 24 * 3600_000;

const normalizeAnswer = (a) => String(a).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

export async function lockRiddle(text, question, answer, iterations = RIDDLE_ITERATIONS) {
  if (!question?.trim()) throw new Error('a riddle needs a question');
  if (!normalizeAnswer(answer)) throw new Error('a riddle needs an answer');
  const salt = random(16), iv = random(12);
  const key = await pbkdf2(normalizeAnswer(answer), salt, iterations, 32);
  const ct = await seal(key, iv, utf8(text), utf8(`psst/riddle\n${question}`));
  return { question, iterations, salt: b64u(salt), iv: b64u(iv), ct: b64u(ct) };
}

/** Returns the text, or null for a wrong answer. */
export async function solveRiddle(r, answer) {
  const iterations = Math.min(Math.max(r.iterations | 0, 1), 2_000_000);
  const key = await pbkdf2(normalizeAnswer(answer), fromB64u(r.salt), iterations, 32);
  try {
    return fromUtf8(await open(key, fromB64u(r.iv), fromB64u(r.ct), utf8(`psst/riddle\n${r.question}`)));
  } catch {
    return null;
  }
}

export async function sealCapsule(text) {
  const key = random(32), iv = random(12);
  const ct = await seal(key, iv, utf8(text), utf8('psst/capsule'));
  return { capsule: { iv: b64u(iv), ct: b64u(ct), commit: b64u(await sha256(key)) }, key: b64u(key) };
}

/** Throws if the key doesn't match the commitment or doesn't decrypt. */
export async function openCapsule(capsule, keyB64) {
  const key = fromB64u(keyB64);
  if (!equal(await sha256(key), fromB64u(capsule.commit))) throw new Error('capsule key does not match commitment');
  return fromUtf8(await open(key, fromB64u(capsule.iv), fromB64u(capsule.ct), utf8('psst/capsule')));
}
