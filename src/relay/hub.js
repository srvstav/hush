// The relay's brain, with no I/O. Node wraps it in a WebSocket server; the browser demo
// runs the very same code inside a SharedWorker so tabs can talk without any server.
//
// It is deliberately dumb: it groups connections by room id, assigns random peer ids,
// and forwards opaque bodies. It enforces limits so one client can't hurt the others.

import { encodeFrame, decodeFrame } from '../core/frame.js';
import { hex, random } from '../core/bytes.js';

export const LIMITS = Object.freeze({
  maxFrame: 1024 * 1024,              // a 256 KiB chunk plus headroom
  maxPeersPerRoom: 16,
  maxRooms: 10_000,
  maxBuffered: 32 * 1024 * 1024,      // per receiving socket; beyond this we refuse to queue more
  framesPerSecond: 800,               // token bucket per connection
  burst: 1600,
});

/**
 * @typedef {{ send(b: Uint8Array): void, close(code?: number, reason?: string): void, readonly bufferedAmount: number }} Conn
 */
export class Hub {
  /** @type {Map<string, Map<string, Client>>} */
  rooms = new Map();

  constructor(limits = {}) { this.limits = { ...LIMITS, ...limits }; }

  /** @param {Conn} conn */
  connect(conn) { return new Client(this, conn); }

  get stats() {
    let peers = 0;
    for (const r of this.rooms.values()) peers += r.size;
    return { rooms: this.rooms.size, peers };
  }
}

class Client {
  id = null;
  room = null;
  #tokens;
  #last = Date.now();

  constructor(hub, conn) {
    this.hub = hub;
    this.conn = conn;
    this.#tokens = hub.limits.burst;
  }

  #emit(header, body) { this.conn.send(encodeFrame(header, body)); }

  #fail(code, msg, fatal = false) {
    this.#emit({ t: 'error', code, msg });
    if (fatal) this.conn.close(1008, code);
  }

  #allow() {
    const now = Date.now();
    const { framesPerSecond, burst } = this.hub.limits;
    this.#tokens = Math.min(burst, this.#tokens + ((now - this.#last) / 1000) * framesPerSecond);
    this.#last = now;
    if (this.#tokens < 1) return false;
    this.#tokens -= 1;
    return true;
  }

  receive(data) {
    if (data.byteLength > this.hub.limits.maxFrame) return this.#fail('too-large', 'frame too large', true);
    if (!this.#allow()) return this.#fail('rate-limit', 'slow down', true);
    let frame;
    try { frame = decodeFrame(data); } catch { return this.#fail('bad-frame', 'malformed frame', true); }
    const { header: h, body } = frame;

    if (h.t === 'join') return this.#join(h.room);
    if (h.t !== 'send') return this.#fail('bad-type', `unknown frame type`, true);
    if (!this.room) return this.#fail('not-joined', 'join first', true);

    const room = this.hub.rooms.get(this.room);
    const out = encodeFrame({ t: 'msg', from: this.id }, body);
    if (h.to === '*') {
      for (const c of room.values()) if (c !== this) c.#deliver(out, this);
    } else {
      const target = typeof h.to === 'string' && room.get(h.to);
      if (!target || target === this) return this.#fail('no-peer', 'no such peer');
      target.#deliver(out, this);
    }
  }

  #deliver(frame, from) {
    // Slow consumer: drop and tell the sender instead of buffering unbounded memory.
    // Parley's own flow control (file acks) keeps well under this in practice.
    if (this.conn.bufferedAmount > this.hub.limits.maxBuffered) return from.#fail('backpressure', `peer ${this.id} is not keeping up`);
    this.conn.send(frame);
  }

  #join(room) {
    if (this.room) return this.#fail('already-joined', 'already in a room', true);
    if (typeof room !== 'string' || !/^[0-9a-f]{32}$/.test(room)) return this.#fail('bad-room', 'room must be 32 hex chars', true);
    let members = this.hub.rooms.get(room);
    if (!members) {
      if (this.hub.rooms.size >= this.hub.limits.maxRooms) return this.#fail('full', 'relay is full', true);
      members = new Map();
      this.hub.rooms.set(room, members);
    }
    if (members.size >= this.hub.limits.maxPeersPerRoom) return this.#fail('room-full', 'room is full', true);

    this.id = hex(random(6));
    this.room = room;
    for (const c of members.values()) c.#emit({ t: 'joined', peer: this.id });
    this.#emit({ t: 'welcome', you: this.id, peers: [...members.keys()] });
    members.set(this.id, this);
  }

  /** Call when the underlying connection closes. */
  close() {
    const members = this.room && this.hub.rooms.get(this.room);
    if (!members?.delete(this.id)) return;
    if (members.size === 0) this.hub.rooms.delete(this.room);
    for (const c of members.values()) c.#emit({ t: 'left', peer: this.id });
  }
}
