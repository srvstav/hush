// Thin WebCrypto wrappers. Everything here is standard: P-256 ECDH, HKDF/HMAC-SHA-256,
// AES-256-GCM, PBKDF2. No custom crypto — only custom composition.

import { concat, utf8 } from './bytes.js';

const subtle = globalThis.crypto?.subtle;
if (!subtle) throw new Error('WebCrypto unavailable (needs a secure context: https or localhost)');

const ECDH = { name: 'ECDH', namedCurve: 'P-256' };
const ZERO32 = new Uint8Array(32);

export async function dhKeyPair() {
  const kp = await subtle.generateKey(ECDH, false, ['deriveBits']); // private key never extractable
  const pub = new Uint8Array(await subtle.exportKey('raw', kp.publicKey));
  return { priv: kp.privateKey, pub };
}

export async function dh(priv, theirPub) {
  if (theirPub.length !== 65 || theirPub[0] !== 4) throw new Error('bad P-256 public key');
  const pub = await subtle.importKey('raw', theirPub, ECDH, false, []); // rejects off-curve points
  return new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: pub }, priv, 256));
}

export async function hkdf(ikm, salt, info, length) {
  const k = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: salt ?? ZERO32, info: typeof info === 'string' ? utf8(info) : info },
    k, length * 8);
  return new Uint8Array(bits);
}

export async function hmac(key, data) {
  const k = await subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle.sign('HMAC', k, data));
}

export const sha256 = async (...parts) => new Uint8Array(await subtle.digest('SHA-256', concat(...parts)));

export async function pbkdf2(secret, salt, iterations, length) {
  const k = await subtle.importKey('raw', utf8(secret), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, k, length * 8));
}

export const aesKey = (raw) => subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);

export async function seal(key, iv, pt, aad) {
  const k = key instanceof Uint8Array ? await aesKey(key) : key;
  return new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad ?? new Uint8Array() }, k, pt));
}

export async function open(key, iv, ct, aad) {
  const k = key instanceof Uint8Array ? await aesKey(key) : key;
  try {
    return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad ?? new Uint8Array() }, k, ct));
  } catch {
    throw new DecryptError();
  }
}

export class DecryptError extends Error {
  constructor(msg = 'decryption failed (tampered, replayed, or wrong key)') { super(msg); this.name = 'DecryptError'; }
}
