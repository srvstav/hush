// The Parley engine: one object per room membership. Transport-agnostic, UI-agnostic,
// runs the same in a browser tab and in Node.
//
//   const p = new Parley({ transport, passphrase, name });
//   p.on('peer', ...); p.on('message', ...); await p.join();
//   await p.say('hi', { tone: 'whisper' });
//
// Group chat = pairwise Double Ratchet sessions with client-side fan-out (like Signal).
// The relay sees: a room id, relay-assigned peer ids, frame sizes (padded), and timing.
// It never sees: the passphrase, names, message content, file names, or file content.

import { Emitter } from './emitter.js';
import { random, b64u, compare, toBytes } from './bytes.js';
import { dhKeyPair, dh, DecryptError } from './primitives.js';
import { deriveRoom, pairSecrets } from './room.js';
import { Ratchet } from './ratchet.js';
import { encodeFrame, decodeFrame, decodeEnvelope, helloEnvelope, ratchetEnvelope, chunkEnvelope, Kind, pad, unpad } from './frame.js';
import { lockRiddle, solveRiddle, sealCapsule, openCapsule, RIDDLE_TRIES, CAPSULE_MAX_MS } from './locks.js';
import { Outgoing, Incoming, newFileSecret, exportSecret, importSecret, MAX_FILE } from './transfer.js';

export const TONES = Object.freeze(['whisper', 'say', 'shout']);
const WHISPER_BURN_S = 20;            // whispers burn by default
const HIGH_WATER = 8 * 1024 * 1024;  // transport buffer before file senders pause
const MAX_TEXT = 32_000;

const newId = () => b64u(random(9));
const isStr = (v, max) => typeof v === 'string' && v.length <= max;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Parley extends Emitter {
  #transport; #passphrase; #iterations;
  #eph = null;
  #timers = new Set();
  #outgoing = new Map();   // fileId → { secret, source, meta, transfers: Map<peerId, Outgoing> }
  #incoming = new Map();   // fileId → { from, offer, secret, transfer?: Incoming }
  #closed = false;

  me = null;
  roomId = null;
  name;
  /** @type {Map<string, Peer>} */
  peers = new Map();
  /** @type {Map<string, object>} message records, own and received */
  messages = new Map();

  /**
   * @param {object} o
   * @param {{open():Promise<void>, send(b:Uint8Array):void, close():void, bufferedAmount:number, onframe:Function, onclose:Function}} o.transport
   * @param {string} o.passphrase
   * @param {string} [o.name]
   * @param {number} [o.iterations]  PBKDF2 rounds for the room key (lower only in tests)
   */
  constructor({ transport, passphrase, name = 'anon', iterations }) {
    super();
    if (!transport) throw new TypeError('transport required');
    this.#transport = transport;
    this.#passphrase = passphrase;
    this.#iterations = iterations;
    this.name = String(name).slice(0, 40) || 'anon';
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  async join() {
    const { roomId, psk } = await deriveRoom(this.#passphrase, this.#iterations);
    this.#passphrase = null; // don't keep it around
    this.roomId = roomId;
    this.psk = psk;
    this.#eph = await dhKeyPair();

    const welcomed = new Promise((resolve, reject) => {
      this.once('_welcome', resolve);
      this.once('disconnected', () => reject(new Error('relay closed before welcome')));
    });
    this.#transport.onframe = (data) => this.#onFrame(data);
    this.#transport.onclose = () => this.#shutdown('relay connection closed');
    await this.#transport.open();
    this.#relay({ t: 'join', room: roomId });
    await welcomed;
    return { me: this.me, roomId };
  }

  leave() { this.#shutdown('left'); }

  #shutdown(reason) {
    if (this.#closed) return;
    this.#closed = true;
    for (const t of this.#timers) clearTimeout(t);
    for (const o of this.#outgoing.values()) for (const tr of o.transfers.values()) tr.cancel(reason);
    for (const f of this.#incoming.values()) f.transfer && !f.transfer.complete && f.transfer.sink.abort?.(reason);
    try { this.#transport.close(); } catch { /* already closed */ }
    this.emit('disconnected', { reason });
  }

  #later(ms, fn) {
    const t = setTimeout(() => { this.#timers.delete(t); fn(); }, Math.max(0, ms));
    this.#timers.add(t);
  }

  // ── wire ───────────────────────────────────────────────────────────────────

  #relay(header, body) {
    if (this.#closed) return;
    this.#transport.send(encodeFrame(header, body));
  }

  #onFrame(data) {
    let frame;
    try { frame = decodeFrame(data); } catch (err) { return this.emit('warning', { reason: `bad relay frame: ${err.message}` }); }
    const { header: h, body } = frame;
    switch (h.t) {
      case 'welcome':
        this.me = h.you;
        for (const id of h.peers) this.#peer(id);
        if (h.peers.length) this.#relay({ t: 'send', to: '*' }, helloEnvelope(this.#eph.pub));
        this.emit('_welcome');
        this.emit('joined', { me: this.me, roomId: this.roomId });
        break;
      case 'joined':
        this.#peer(h.peer);
        this.#relay({ t: 'send', to: h.peer }, helloEnvelope(this.#eph.pub));
        break;
      case 'left': this.#dropPeer(h.peer); break;
      case 'msg': {
        const peer = this.peers.get(h.from) ?? this.#peer(h.from);
        const bytes = body.slice(); // detach from the frame buffer before going async
        // Per-peer queue: order matters (handshake before messages, chunks in sequence),
        // but one slow peer must not stall the others.
        peer.queue = peer.queue.then(() => this.#onEnvelope(peer, bytes)).catch((err) =>
          this.emit('warning', { peer: peer.id, reason: err.message }));
        break;
      }
      case 'error': this.emit('relay-error', { code: h.code, message: h.msg }); break;
      default: this.emit('warning', { reason: `unknown relay frame ${h.t}` });
    }
  }

  #peer(id) {
    if (typeof id !== 'string' || !id || id === this.me) throw new Error('bad peer id');
    let p = this.peers.get(id);
    if (!p) {
      p = { id, name: null, ratchet: null, ready: false, outbox: [], safetyWords: null, queue: Promise.resolve() };
      this.peers.set(id, p);
    }
    return p;
  }

  #dropPeer(id) {
    const p = this.peers.get(id);
    if (!p) return;
    this.peers.delete(id);
    for (const o of this.#outgoing.values()) o.transfers.get(id)?.cancel('peer left');
    for (const [fid, f] of this.#incoming) {
      if (f.from === id) { f.transfer?.complete || f.transfer?.sink.abort?.('peer left'); this.#incoming.delete(fid); }
    }
    this.emit('peer-left', this.#peerView(p));
  }

  async #onEnvelope(peer, body) {
    const env = decodeEnvelope(body);
    if (env.kind === Kind.HELLO) return this.#handshake(peer, env.pub);
    if (env.kind === Kind.CHUNK) return this.#onChunk(peer, env);

    if (!peer.ratchet) throw new Error('message before handshake');
    let pt;
    try { pt = await peer.ratchet.decrypt(env.wire); } catch (err) {
      if (err instanceof DecryptError) return this.emit('warning', { peer: peer.id, reason: err.message });
      throw err;
    }
    if (!peer.ready) {
      peer.ready = true;
      for (const msg of peer.outbox.splice(0)) await this.#sendTo(peer, msg);
      this.emit('peer', this.#peerView(peer));
    }
    return this.#onPayload(peer, unpad(pt));
  }

  async #handshake(peer, theirPub) {
    if (peer.ratchet) return this.emit('warning', { peer: peer.id, reason: 'duplicate hello ignored' });
    const mine = this.#eph.pub;
    const order = compare(mine, theirPub);
    if (order === 0) throw new Error('reflected hello');
    const [lo, hi] = order < 0 ? [mine, theirPub] : [theirPub, mine];
    const { sk, ad, safetyWords } = await pairSecrets(await dh(this.#eph.priv, theirPub), this.psk, lo, hi);
    peer.safetyWords = safetyWords;
    if (order < 0) {
      // Initiator speaks first: the profile message doubles as key confirmation for the responder.
      peer.ratchet = await Ratchet.alice(sk, theirPub, ad);
      peer.ready = true;
      await this.#sendTo(peer, { k: 'profile', name: this.name });
      this.emit('peer', this.#peerView(peer));
    } else {
      peer.ratchet = Ratchet.bob(sk, this.#eph, ad);
      peer.outbox.push({ k: 'profile', name: this.name });
    }
  }

  async #sendTo(peer, payload) {
    if (!peer.ratchet?.canSend) return void peer.outbox.push(payload);
    const wire = await peer.ratchet.encrypt(pad(payload));
    this.#relay({ t: 'send', to: peer.id }, ratchetEnvelope(wire));
  }

  /** Fan out to every peer we have a session with. Returns their ids. */
  async #broadcast(payload) {
    const targets = [...this.peers.values()].filter((p) => p.ratchet);
    await Promise.all(targets.map((p) => this.#sendTo(p, payload)));
    return targets.map((p) => p.id);
  }

  #peerView = (p) => ({ id: p.id, name: p.name ?? 'anon', safetyWords: p.safetyWords, ready: p.ready });

  // ── inbound payloads ───────────────────────────────────────────────────────

  async #onPayload(peer, m) {
    if (!m || typeof m.k !== 'string') throw new Error('bad payload');
    const at = Date.now();
    switch (m.k) {
      case 'profile':
        if (!isStr(m.name, 40)) throw new Error('bad profile');
        peer.name = m.name || 'anon';
        return this.emit('peer', this.#peerView(peer));

      case 'text': {
        if (!isStr(m.id, 16) || !isStr(m.text, MAX_TEXT)) throw new Error('bad text');
        const tone = TONES.includes(m.tone) ? m.tone : 'say';
        const burn = Number.isInteger(m.burn) && m.burn > 0 && m.burn <= 86400 ? m.burn : null;
        return this.#record({ id: m.id, from: peer.id, kind: 'text', at, tone, text: m.text, burn, state: burn ? 'sealed' : 'open' });
      }

      case 'riddle': {
        const r = m.riddle;
        if (!isStr(m.id, 16) || !r || !isStr(r.question, 500) || !isStr(r.ct, MAX_TEXT * 2)) throw new Error('bad riddle');
        return this.#record({ id: m.id, from: peer.id, kind: 'riddle', at, question: r.question, riddle: r, triesLeft: RIDDLE_TRIES, state: 'locked' });
      }

      case 'capsule': {
        if (!isStr(m.id, 16) || !Number.isFinite(m.opensAt) || !m.capsule) throw new Error('bad capsule');
        return this.#record({ id: m.id, from: peer.id, kind: 'capsule', at, opensAt: m.opensAt, capsule: m.capsule, state: 'sealed' });
      }

      case 'capsule-key': {
        const rec = this.messages.get(m.id);
        if (!rec || rec.kind !== 'capsule' || rec.from !== peer.id || rec.state !== 'sealed') return;
        const text = await openCapsule(rec.capsule, m.key); // throws on a broken commitment
        // Our own clock decides too: an early key (clock skew, impatient sender) waits.
        return this.#later(rec.opensAt - Date.now(), () => this.#update(rec, { text, capsule: null, state: 'open' }));
      }

      case 'burned': {
        const rec = this.messages.get(m.id);
        if (!rec || rec.from !== this.me || !rec.recipients?.includes(peer.id)) return;
        rec.burnedBy.add(peer.id);
        if (rec.recipients.every((id) => rec.burnedBy.has(id) || !this.peers.has(id))) this.#burn(rec);
        return;
      }

      case 'knock': return this.emit('knock', { from: peer.id, name: peer.name ?? 'anon' });

      case 'draft': // live typing: ephemeral, never stored
        if (m.text !== null && !isStr(m.text, MAX_TEXT)) throw new Error('bad draft');
        return this.emit('draft', { from: peer.id, name: peer.name ?? 'anon', active: !!m.active, text: m.text ?? null });

      case 'unsay': {
        const rec = this.messages.get(m.id);
        if (!rec || rec.from !== peer.id || rec.state === 'unsaid') return;
        return this.#update(rec, { text: null, riddle: null, capsule: null, question: null, state: 'unsaid' });
      }

      case 'react': {
        const rec = this.messages.get(m.id);
        if (!rec || !(m.emoji === null || isStr(m.emoji, 16))) return;
        return this.#setReaction(rec, peer.id, m.emoji);
      }

      case 'seen': {
        const rec = this.messages.get(m.id);
        if (!rec || rec.from !== this.me || !rec.recipients?.includes(peer.id) || rec.seenBy.has(peer.id)) return;
        rec.seenBy.add(peer.id);
        return this.emit('message-update', this.#view(rec));
      }

      case 'file-offer': return this.#onOffer(peer, m);
      case 'file-accept':
        void this.#startUpload(peer, m.fileId); // runs outside this peer's queue, or its acks would deadlock behind it
        return;
      case 'file-ack': return this.#outgoing.get(m.fileId)?.transfers.get(peer.id)?.ack(m.next);
      case 'file-decline':
      case 'file-cancel': {
        this.#outgoing.get(m.fileId)?.transfers.get(peer.id)?.cancel(m.reason ?? 'declined');
        const inc = this.#incoming.get(m.fileId);
        if (inc?.from === peer.id) {
          inc.transfer?.sink.abort?.('sender cancelled');
          this.#incoming.delete(m.fileId);
          this.emit('file-failed', { fileId: m.fileId, direction: 'in', reason: m.reason ?? 'cancelled' });
        }
        return;
      }
      default:
        return this.emit('warning', { peer: peer.id, reason: `unknown payload ${m.k}` });
    }
  }

  #record(rec) {
    rec.reactions = new Map();
    rec.seenBy = new Set();
    rec.seenSent = false;
    this.messages.set(rec.id, rec);
    this.emit('message', this.#view(rec));
    return this.#view(rec);
  }

  #update(rec, patch) {
    Object.assign(rec, patch);
    this.emit('message-update', this.#view(rec));
  }

  // What the UI gets: no ciphertext blobs, no internal sets.
  #view = (r) => ({
    id: r.id, from: r.from, mine: r.from === this.me, kind: r.kind, at: r.at, tone: r.tone ?? 'say',
    text: r.text ?? null, state: r.state, burn: r.burn ?? null, burnAt: r.burnAt ?? null,
    question: r.question ?? null, triesLeft: r.triesLeft ?? null, opensAt: r.opensAt ?? null,
    reactions: [...r.reactions].map(([from, emoji]) => ({ from, emoji })),
    seenBy: [...r.seenBy],
  });

  #setReaction(rec, who, emoji) {
    if (emoji) rec.reactions.set(who, emoji); else rec.reactions.delete(who);
    this.emit('message-update', this.#view(rec));
  }

  // ── outbound messages ──────────────────────────────────────────────────────

  /** Plain text with a tone. Whispers self-destruct 20s after being read unless `burn` says otherwise. */
  async say(text, { tone = 'say', burn } = {}) {
    if (!isStr(text, MAX_TEXT) || !text.trim()) throw new Error(`text must be 1..${MAX_TEXT} chars`);
    if (!TONES.includes(tone)) throw new Error(`tone must be one of ${TONES.join(', ')}`);
    burn ??= tone === 'whisper' ? WHISPER_BURN_S : undefined;
    if (burn !== undefined && !(Number.isInteger(burn) && burn > 0 && burn <= 86400)) throw new Error('burn must be 1..86400 seconds');
    const id = newId();
    const recipients = await this.#broadcast({ k: 'text', id, text, tone, burn });
    return this.#record({ id, from: this.me, kind: 'text', at: Date.now(), tone, text, burn: burn ?? null, state: 'open', recipients, burnedBy: new Set() });
  }

  /** A message only the person who knows the answer can open. */
  async riddle(text, question, answer) {
    if (!isStr(text, MAX_TEXT) || !text.trim()) throw new Error('riddle text required');
    const id = newId();
    const riddle = await lockRiddle(text, question, answer);
    const recipients = await this.#broadcast({ k: 'riddle', id, riddle });
    return this.#record({ id, from: this.me, kind: 'riddle', at: Date.now(), question, text, state: 'open', recipients });
  }

  /** Try an answer. Returns { ok, triesLeft }. After the last wrong try the riddle crumbles. */
  async solve(id, answer) {
    const rec = this.messages.get(id);
    if (!rec || rec.kind !== 'riddle' || rec.state !== 'locked') throw new Error('no locked riddle with that id');
    const text = await solveRiddle(rec.riddle, answer);
    if (text !== null) {
      this.#update(rec, { text, riddle: null, state: 'open' });
      return { ok: true, triesLeft: rec.triesLeft };
    }
    const triesLeft = rec.triesLeft - 1;
    this.#update(rec, triesLeft > 0 ? { triesLeft } : { triesLeft: 0, riddle: null, state: 'crumbled' });
    return { ok: false, triesLeft };
  }

  /** Sealed now, readable later. The key is held on this device and released at `opensAt`. */
  async capsule(text, { opensInMs }) {
    if (!isStr(text, MAX_TEXT) || !text.trim()) throw new Error('capsule text required');
    if (!(Number.isFinite(opensInMs) && opensInMs > 0 && opensInMs <= CAPSULE_MAX_MS)) throw new Error('opensInMs must be within 7 days');
    const id = newId();
    const opensAt = Date.now() + opensInMs;
    const { capsule, key } = await sealCapsule(text);
    const recipients = await this.#broadcast({ k: 'capsule', id, opensAt, capsule });
    const view = this.#record({ id, from: this.me, kind: 'capsule', at: Date.now(), opensAt, text, state: 'sealed', recipients });
    const rec = this.messages.get(id);
    this.#later(opensInMs, async () => {
      if (rec.state === 'unsaid') return; // taken back before it opened: the key never leaves
      // Only people who got the capsule get the key — late joiners can't open what they never saw.
      for (const pid of recipients) {
        const p = this.peers.get(pid);
        if (p) await this.#sendTo(p, { k: 'capsule-key', id, key }).catch(() => {});
      }
      this.#update(rec, { state: 'open' });
    });
    return view;
  }

  async knock() { await this.#broadcast({ k: 'knock' }); }

  /**
   * Typing presence. With `live`, the other side sees your words as you type them
   * (encrypted, like everything else); without it, only that you're typing.
   * Callers should throttle (the web UI sends at most every 120 ms).
   */
  async draft(text, { live = false } = {}) {
    const active = typeof text === 'string' && text.length > 0;
    if (active && text.length > MAX_TEXT) return;
    await this.#broadcast({ k: 'draft', active, text: live && active ? text : null });
  }

  /** Take back something you said. Everyone's (honest) client drops the content. */
  async unsay(id) {
    const rec = this.messages.get(id);
    if (!rec || rec.from !== this.me || rec.state === 'unsaid') throw new Error('you can only unsay your own messages');
    for (const pid of rec.recipients ?? []) {
      const p = this.peers.get(pid);
      if (p) await this.#sendTo(p, { k: 'unsay', id });
    }
    this.#update(rec, { text: null, question: null, state: 'unsaid' });
  }

  /** React to any message; `null` removes your reaction. Everyone in the room sees it. */
  async react(id, emoji) {
    const rec = this.messages.get(id);
    if (!rec) throw new Error('no message with that id');
    if (emoji !== null && !(isStr(emoji, 16) && emoji.trim())) throw new Error('reaction must be a short string');
    await this.#broadcast({ k: 'react', id, emoji });
    this.#setReaction(rec, this.me, emoji);
  }

  /** Tell the sender you've seen a message (once). Call it when it's actually on screen. */
  markSeen(id) {
    const rec = this.messages.get(id);
    if (!rec || rec.from === this.me || rec.seenSent) return;
    rec.seenSent = true;
    const p = this.peers.get(rec.from);
    if (p) this.#sendTo(p, { k: 'seen', id }).catch(() => {});
  }

  /** The reader opened a burnable message: start its fuse. */
  reveal(id) {
    const rec = this.messages.get(id);
    if (!rec || rec.from === this.me || !rec.burn || rec.burnAt) return rec ? this.#view(rec) : null;
    this.#update(rec, { burnAt: Date.now() + rec.burn * 1000, state: 'open' });
    this.markSeen(id);
    this.#later(rec.burn * 1000, () => {
      this.#burn(rec);
      const p = this.peers.get(rec.from);
      if (p) this.#sendTo(p, { k: 'burned', id }).catch(() => {});
    });
    return this.#view(rec);
  }

  #burn(rec) {
    if (rec.state === 'burned') return;
    this.#update(rec, { text: null, state: 'burned' });
  }

  // ── files ──────────────────────────────────────────────────────────────────

  /**
   * Offer a file to everyone in the room. Streaming starts per person once they accept.
   * @param {{size:number, slice(start:number,end:number):Promise<Uint8Array>}} source
   */
  async sendFile(source, { name, mime = 'application/octet-stream' }) {
    if (!source || !Number.isSafeInteger(source.size) || source.size < 0 || source.size > MAX_FILE) throw new Error('bad file source');
    if (!isStr(name, 255) || !name) throw new Error('file name must be 1..255 chars');
    const secret = newFileSecret();
    const fileId = b64u(secret.fileId);
    this.#outgoing.set(fileId, { secret, source, meta: { name, mime: String(mime).slice(0, 100), size: source.size }, transfers: new Map() });
    const offer = { k: 'file-offer', fileId, name, mime, size: source.size, secret: exportSecret(secret) };
    const recipients = await this.#broadcast(offer);
    return { fileId, recipients };
  }

  async #onOffer(peer, m) {
    if (!isStr(m.fileId, 32) || !isStr(m.name, 255) || !Number.isSafeInteger(m.size) || m.size < 0 || m.size > MAX_FILE) throw new Error('bad file offer');
    const secret = importSecret(m.secret);
    if (b64u(secret.fileId) !== m.fileId || secret.key.length !== 32 || secret.prefix.length !== 8) throw new Error('bad file secret');
    this.#incoming.set(m.fileId, { from: peer.id, secret, offer: { name: m.name, mime: isStr(m.mime, 100) ? m.mime : 'application/octet-stream', size: m.size } });
    this.emit('file-offer', { fileId: m.fileId, from: peer.id, ...this.#incoming.get(m.fileId).offer });
  }

  /** @param {{write(b:Uint8Array):Promise<void>|void, close():Promise<void>|void, abort?(reason:string):void}} sink */
  async acceptFile(fileId, sink) {
    const f = this.#incoming.get(fileId);
    const peer = f && this.peers.get(f.from);
    if (!peer || f.transfer) throw new Error('no pending offer with that id');
    f.transfer = new Incoming({
      secret: f.secret, size: f.offer.size, sink,
      sendAck: (next) => this.#sendTo(peer, { k: 'file-ack', fileId, next }).catch(() => {}),
      onProgress: (bytes) => this.emit('file-progress', { fileId, direction: 'in', peer: peer.id, bytes, size: f.offer.size }),
    });
    await this.#sendTo(peer, { k: 'file-accept', fileId });
  }

  async declineFile(fileId) {
    const f = this.#incoming.get(fileId);
    if (!f) return;
    this.#incoming.delete(fileId);
    const peer = this.peers.get(f.from);
    if (peer) await this.#sendTo(peer, { k: 'file-decline', fileId });
  }

  async #onChunk(peer, { fileId: raw, index, ct }) {
    const fileId = b64u(raw);
    const f = this.#incoming.get(fileId);
    if (!f?.transfer || f.from !== peer.id) return; // unrequested chunks are dropped, not buffered
    try {
      await f.transfer.receive(index, ct);
    } catch (err) {
      this.#incoming.delete(fileId);
      f.transfer.sink.abort?.(err.message);
      await this.#sendTo(peer, { k: 'file-cancel', fileId, reason: 'integrity check failed' }).catch(() => {});
      return this.emit('file-failed', { fileId, direction: 'in', reason: err.message });
    }
    if (f.transfer.complete) {
      this.#incoming.delete(fileId);
      this.emit('file-done', { fileId, direction: 'in', peer: peer.id, ...f.offer });
    }
  }

  async #startUpload(peer, fileId) {
    const o = this.#outgoing.get(fileId);
    if (!o || o.transfers.has(peer.id)) return;
    const t = new Outgoing({
      secret: o.secret, source: o.source,
      sendChunk: async (i, ct) => {
        while (this.#transport.bufferedAmount > HIGH_WATER && !this.#closed) await sleep(5);
        if (!this.peers.has(peer.id)) throw new Error('peer left');
        this.#relay({ t: 'send', to: peer.id }, chunkEnvelope(o.secret.fileId, i, ct));
      },
      onProgress: (bytes) => this.emit('file-progress', { fileId, direction: 'out', peer: peer.id, bytes, size: o.meta.size }),
    });
    o.transfers.set(peer.id, t);
    try {
      await t.run();
      this.emit('file-done', { fileId, direction: 'out', peer: peer.id, ...o.meta });
    } catch (err) {
      this.emit('file-failed', { fileId, direction: 'out', peer: peer.id, reason: err.message });
    }
  }

  cancelFile(fileId) {
    const o = this.#outgoing.get(fileId);
    if (!o) return;
    for (const [pid, t] of o.transfers) {
      t.cancel('cancelled by sender');
      const p = this.peers.get(pid);
      if (p) this.#sendTo(p, { k: 'file-cancel', fileId, reason: 'cancelled by sender' }).catch(() => {});
    }
    this.#outgoing.delete(fileId);
  }
}

/** Wrap a Uint8Array (tests, Node) as a file source. Browsers: see fileSource() in web/app.js. */
export const bytesSource = (bytes) => {
  const b = toBytes(bytes);
  return { size: b.length, slice: async (s, e) => b.subarray(s, e) };
};
