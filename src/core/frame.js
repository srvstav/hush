// Two layers of framing.
//
// Relay frame (what the relay parses):  u32 headerLen | header JSON | opaque body
//   client → relay:  {t:'join', room}  {t:'send', to: peerId | '*'}
//   relay → client:  {t:'welcome', you, peers}  {t:'joined', peer}  {t:'left', peer}
//                    {t:'msg', from}  {t:'error', code, msg}
//
// Envelope (inside body, relay can't read it):  u8 kind | ...
//   HELLO   | dh pub (65)
//   RATCHET | ratchet wire (header || ciphertext)
//   CHUNK   | fileId (16) | index u32 | AES-GCM ciphertext

import { concat, u32, readU32, utf8, fromUtf8, toBytes } from './bytes.js';

export const MAX_HEADER = 1024;

export function encodeFrame(header, body = new Uint8Array()) {
  const h = utf8(JSON.stringify(header));
  if (h.length > MAX_HEADER) throw new RangeError('frame header too large');
  return concat(u32(h.length), h, body);
}

export function decodeFrame(data) {
  const b = toBytes(data);
  if (b.length < 4) throw new Error('short frame');
  const n = readU32(b);
  if (n > MAX_HEADER || 4 + n > b.length) throw new Error('bad frame header length');
  const header = JSON.parse(fromUtf8(b.subarray(4, 4 + n)));
  if (!header || typeof header.t !== 'string') throw new Error('bad frame header');
  return { header, body: b.subarray(4 + n) };
}

export const Kind = Object.freeze({ HELLO: 1, RATCHET: 2, CHUNK: 3 });

export const helloEnvelope = (pub) => concat(Uint8Array.of(Kind.HELLO), pub);
export const ratchetEnvelope = (wire) => concat(Uint8Array.of(Kind.RATCHET), wire);
export const chunkEnvelope = (fileId, index, ct) => concat(Uint8Array.of(Kind.CHUNK), fileId, u32(index), ct);

export function decodeEnvelope(body) {
  if (body.length < 1) throw new Error('empty envelope');
  const kind = body[0];
  const rest = body.subarray(1);
  switch (kind) {
    case Kind.HELLO:
      if (rest.length !== 65) throw new Error('bad hello');
      return { kind, pub: rest.slice() };
    case Kind.RATCHET:
      return { kind, wire: rest };
    case Kind.CHUNK:
      if (rest.length < 20 + 16) throw new Error('bad chunk');
      return { kind, fileId: rest.slice(0, 16), index: readU32(rest, 16), ct: rest.subarray(20) };
    default:
      throw new Error(`unknown envelope kind ${kind}`);
  }
}

// Inner payloads are JSON, padded to fixed buckets so ciphertext length leaks only a coarse size class.
const BUCKETS = [256, 1024, 4096, 16384, 65536, 262144];

export function pad(obj) {
  const json = utf8(JSON.stringify(obj));
  const need = json.length + 4;
  const size = BUCKETS.find((b) => b >= need);
  if (!size) throw new RangeError('payload too large — send it as a file');
  const out = new Uint8Array(size);
  out.set(u32(json.length));
  out.set(json, 4);
  return out;
}

export function unpad(bytes) {
  const n = readU32(bytes);
  if (n + 4 > bytes.length) throw new Error('bad padding');
  return JSON.parse(fromUtf8(bytes.subarray(4, 4 + n)));
}
