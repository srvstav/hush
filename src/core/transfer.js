// Huge-file streaming. A file is never held whole in memory on either side.
//
// - Each file gets a fresh AES-256-GCM key, sent to each recipient through their ratchet.
// - Chunks travel as binary frames (no base64 bloat), encrypted once with that file key.
// - Nonce = 8-byte random prefix || u32 index; AAD binds fileId, index, and total count,
//   so the relay can't reorder, drop, duplicate, truncate, or splice chunks between files.
// - Credit-based flow control: at most WINDOW chunks unacknowledged per recipient.
//   Memory on the relay and receiver stays bounded no matter how big the file is.

import { concat, u32, utf8, random, b64u, fromB64u } from './bytes.js';
import { aesKey, seal, open } from './primitives.js';

export const CHUNK_SIZE = 256 * 1024;
export const WINDOW = 16;       // 4 MiB in flight per recipient
export const ACK_EVERY = 4;
export const MAX_FILE = 2 ** 32 * CHUNK_SIZE - 1; // index is u32 — ~1 PiB, effectively unbounded

const nonce = (prefix, i) => concat(prefix, u32(i));
const aad = (fileId, i, total) => concat(utf8('hush/chunk'), fileId, u32(i), u32(total));
export const chunkCount = (size) => Math.max(1, Math.ceil(size / CHUNK_SIZE));

export function newFileSecret() {
  return { fileId: random(16), key: random(32), prefix: random(8) };
}

export const exportSecret = ({ fileId, key, prefix }) => ({ fileId: b64u(fileId), key: b64u(key), prefix: b64u(prefix) });
export const importSecret = (o) => ({ fileId: fromB64u(o.fileId), key: fromB64u(o.key), prefix: fromB64u(o.prefix) });

/** Streams one file to one recipient. */
export class Outgoing {
  #acked = 0;
  #wake = null;
  #cancelled = null;

  /**
   * @param {object} o
   * @param {{size:number, slice:(start:number,end:number)=>Promise<Uint8Array>}} o.source
   * @param {(index:number, ct:Uint8Array)=>Promise<void>} o.sendChunk  must apply transport backpressure
   * @param {(sent:number)=>void} [o.onProgress]
   */
  constructor({ secret, source, sendChunk, onProgress }) {
    this.secret = secret;
    this.source = source;
    this.total = chunkCount(source.size);
    this.sendChunk = sendChunk;
    this.onProgress = onProgress ?? (() => {});
  }

  ack(next) {
    if (Number.isInteger(next) && next > this.#acked && next <= this.total) this.#acked = next;
    this.#wake?.();
  }

  cancel(reason = 'cancelled') {
    this.#cancelled ??= reason;
    this.#wake?.();
  }

  get done() { return this.#acked === this.total; }

  async run() {
    const { fileId, key: raw, prefix } = this.secret;
    const key = await aesKey(raw);
    for (let i = 0; i < this.total; i++) {
      while (i - this.#acked >= WINDOW && !this.#cancelled) await new Promise((r) => (this.#wake = r));
      if (this.#cancelled) throw new Error(this.#cancelled);
      const start = i * CHUNK_SIZE;
      const pt = await this.source.slice(start, Math.min(start + CHUNK_SIZE, this.source.size));
      await this.sendChunk(i, await seal(key, nonce(prefix, i), pt, aad(fileId, i, this.total)));
      this.onProgress(Math.min((i + 1) * CHUNK_SIZE, this.source.size));
    }
    while (!this.done && !this.#cancelled) await new Promise((r) => (this.#wake = r));
    if (this.#cancelled) throw new Error(this.#cancelled);
  }
}

/** Receives one file into a sink: {write(bytes), close(), abort(reason)}. */
export class Incoming {
  #next = 0;
  #key;
  #received = 0;

  constructor({ secret, size, sink, sendAck, onProgress }) {
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE) throw new Error('bad file size');
    this.secret = secret;
    this.size = size;
    this.total = chunkCount(size);
    this.sink = sink;
    this.sendAck = sendAck;
    this.onProgress = onProgress ?? (() => {});
  }

  get complete() { return this.#next === this.total; }

  /** Chunks must arrive in order: the relay forwards per-connection in order, so a gap is an attack or a bug. */
  async receive(index, ct) {
    if (index !== this.#next) throw new Error(`chunk ${index} out of order (expected ${this.#next})`);
    this.#key ??= await aesKey(this.secret.key);
    const pt = await open(this.#key, nonce(this.secret.prefix, index), ct, aad(this.secret.fileId, index, this.total));
    const expected = index === this.total - 1 ? this.size - index * CHUNK_SIZE : CHUNK_SIZE;
    if (pt.length !== expected) throw new Error('chunk size mismatch');
    await this.sink.write(pt);
    this.#next += 1;
    this.#received += pt.length;
    this.onProgress(this.#received);
    if (this.complete) await this.sink.close();
    if (this.complete || this.#next % ACK_EVERY === 0) this.sendAck(this.#next);
  }
}
