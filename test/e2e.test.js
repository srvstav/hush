// Full stack: real relay server, real WebSockets, three engines in one room.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startRelay } from '../src/relay/server.js';
import { WebSocketTransport } from '../src/transport/websocket.js';
import { Psst, bytesSource } from '../src/core/engine.js';
import { concat, equal, random } from '../src/core/bytes.js';
import { encodeFrame, decodeFrame } from '../src/core/frame.js';

let relay, url;
before(async () => { relay = await startRelay({ port: 0 }); url = `ws://127.0.0.1:${relay.port}/ws`; });
after(() => relay.close());

const ITER = 1000; // fast PBKDF2 for tests only
const next = (p, ev, pred = () => true) => new Promise((ok) => { const off = p.on(ev, (v) => { if (pred(v)) { off(); ok(v); } }); });

async function room(names, passphrase = 'lantern-otter-quartz-river-violet') {
  const ps = [];
  for (const name of names) {
    const p = new Psst({ transport: new WebSocketTransport(url), passphrase, name, iterations: ITER });
    // wait until this member has a ready, named session with everyone already there
    const others = ps.length;
    const ready = others === 0 ? Promise.resolve() : new Promise((ok) => {
      const off = p.on('peer', () => { if ([...p.peers.values()].filter((x) => x.ready && x.name).length === others) { off(); ok(); } });
    });
    await p.join();
    await ready;
    ps.push(p);
  }
  // and everyone has a named, ready session with everyone else
  await Promise.all(ps.map((p) => new Promise((ok) => {
    const check = () => [...p.peers.values()].filter((x) => x.ready && x.name).length === ps.length - 1;
    if (check()) return ok();
    const off = p.on('peer', () => check() && (off(), ok()));
  })));
  return ps;
}

test('three people: safety words match pairwise, names arrive encrypted', async () => {
  const [a, b, c] = await room(['ada', 'bo', 'cy']);
  const ab = a.peers.get(b.me).safetyWords, ba = b.peers.get(a.me).safetyWords;
  assert.equal(ab.length, 5);
  assert.deepEqual(ab, ba);
  assert.notDeepEqual(ab, a.peers.get(c.me).safetyWords);
  assert.equal(c.peers.get(a.me).name, 'ada');
  [a, b, c].forEach((p) => p.leave());
});

test('text with tones reaches everyone; whispers burn on both sides after reading', async () => {
  const [a, b, c] = await room(['ada', 'bo', 'cy']);
  const gotB = next(b, 'message'), gotC = next(c, 'message');
  await a.say('HELLO', { tone: 'shout' });
  assert.equal((await gotB).text, 'HELLO');
  assert.equal((await gotC).tone, 'shout');

  const wb = next(b, 'message'), wc = next(c, 'message');
  const sent = await a.say('psst', { tone: 'whisper', burn: 1 });
  const [gb, gc] = await Promise.all([wb, wc]);
  assert.equal(gb.burn, 1);
  assert.equal(gb.state, 'sealed');
  const burnedB = next(b, 'message-update', (m) => m.state === 'burned');
  const burnedA = next(a, 'message-update', (m) => m.id === sent.id && m.state === 'burned');
  b.reveal(gb.id);
  c.reveal(gc.id);
  assert.equal((await burnedB).text, null);
  assert.equal((await burnedA).text, null); // sender's copy burns once every recipient burned theirs
  [a, b, c].forEach((p) => p.leave());
});

test('riddles: wrong answers count down, then it crumbles; right answer opens', async () => {
  const [a, b] = await room(['ada', 'bo']);
  const m1 = next(b, 'message');
  await a.riddle('meet at dawn', 'What has a neck but no head?', 'a bottle');
  const r1 = await m1;
  assert.equal(r1.state, 'locked');
  assert.equal(r1.text, null);
  assert.deepEqual(await b.solve(r1.id, 'giraffe'), { ok: false, triesLeft: 4 });
  assert.equal((await b.solve(r1.id, 'Bottle!')).ok, false); // "bottle" ≠ "a bottle"
  assert.equal((await b.solve(r1.id, 'A Bottle')).ok, true);
  assert.equal(b.messages.get(r1.id).text, 'meet at dawn');

  const m2 = next(b, 'message');
  await a.riddle('gone', 'q?', 'right');
  const r2 = await m2;
  for (let i = 0; i < 5; i++) await b.solve(r2.id, 'wrong');
  assert.equal(b.messages.get(r2.id).state, 'crumbled');
  await assert.rejects(b.solve(r2.id, 'right'));
  [a, b].forEach((p) => p.leave());
});

test('capsules stay sealed until their time, then open with a verified key', async () => {
  const [a, b] = await room(['ada', 'bo']);
  const m = next(b, 'message');
  const t0 = Date.now();
  await a.capsule('future you says hi', { opensInMs: 400 });
  const cap = await m;
  assert.equal(cap.state, 'sealed');
  assert.equal(cap.text, null);
  const opened = await next(b, 'message-update', (u) => u.id === cap.id && u.state === 'open');
  assert.equal(opened.text, 'future you says hi');
  assert.ok(Date.now() - t0 >= 390);
  [a, b].forEach((p) => p.leave());
});

test('a 48 MiB file streams to two recipients with bounded flow control', async () => {
  const [a, b, c] = await room(['ada', 'bo', 'cy']);
  const size = 48 * 1024 * 1024 + 12345;
  const data = new Uint8Array(size);
  for (let i = 0; i < size; i += 65536) data.set(random(Math.min(65536, size - i)), i);

  const sinks = {};
  for (const p of [b, c]) {
    const parts = [];
    sinks[p.me] = parts;
    p.on('file-offer', (o) => {
      assert.equal(o.name, 'big.bin');
      p.acceptFile(o.fileId, { write: (x) => void parts.push(x.slice()), close: () => {} });
    });
  }
  const doneB = next(b, 'file-done'), doneC = next(c, 'file-done');
  const t0 = performance.now();
  await a.sendFile(bytesSource(data), { name: 'big.bin' });
  await Promise.all([doneB, doneC]);
  const secs = (performance.now() - t0) / 1000;
  console.log(`  48 MiB × 2 recipients in ${secs.toFixed(2)}s (${((2 * size) / secs / 1048576).toFixed(0)} MiB/s through the relay)`);
  for (const parts of Object.values(sinks)) assert.ok(equal(concat(...parts), data));
  [a, b, c].forEach((p) => p.leave());
});

test('declined files never stream; peers leaving are noticed', async () => {
  const [a, b] = await room(['ada', 'bo']);
  b.on('file-offer', (o) => b.declineFile(o.fileId));
  let chunks = 0;
  b.on('file-progress', () => chunks++);
  await a.sendFile(bytesSource(new Uint8Array(1e6)), { name: 'nope.bin' });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(chunks, 0);
  const left = next(a, 'peer-left');
  b.leave();
  assert.equal((await left).id, b.me);
  a.leave();
});

test('different passphrases never meet; the relay only ever sees ciphertext', async () => {
  const [a] = await room(['ada'], 'one-secret-room-here');
  const [z] = await room(['zed'], 'another-secret-room');
  assert.notEqual(a.roomId, z.roomId);
  assert.equal(a.peers.size, 0);

  // Spy on the relay hub: record every body it forwards, then look for plaintext.
  const [p, q] = await room(['ada', 'bo'], 'spy-on-me-please-relay');
  const seen = [];
  const members = relay.hub.rooms.get(p.roomId);
  for (const client of members.values()) {
    const orig = client.conn.send;
    client.conn.send = (b) => { seen.push(decodeFrame(b).body.slice()); orig(b); };
  }
  const got = next(q, 'message');
  await p.say('the eagle lands at midnight');
  await got;
  const hay = new TextDecoder().decode(concat(...seen));
  assert.ok(seen.length > 0);
  assert.ok(!hay.includes('eagle'));
  assert.ok(!hay.includes('ada'));
  [a, z, p, q].forEach((x) => x.leave());
});

test('live typing, reactions, seen receipts, and unsay', async () => {
  const [a, b, c] = await room(['ada', 'bo', 'cy']);

  const live = next(b, 'draft');
  await a.draft('hel', { live: true });
  assert.deepEqual(await live, { from: a.me, name: 'ada', active: true, text: 'hel' });
  const quiet = next(b, 'draft');
  await a.draft('hello', { live: false });
  assert.equal((await quiet).text, null); // presence only — the words stay home

  const got = next(b, 'message'), gotC = next(c, 'message');
  const sent = await a.say('vote: pizza?');
  const [mb, mc] = await Promise.all([got, gotC]);

  const reactSeenByA = next(a, 'message-update', (m) => m.reactions.length === 1);
  const reactSeenByC = next(c, 'message-update', (m) => m.reactions.length === 1);
  await b.react(mb.id, '🍕');
  assert.deepEqual((await reactSeenByA).reactions, [{ from: b.me, emoji: '🍕' }]);
  assert.equal((await reactSeenByC).reactions[0].emoji, '🍕');

  const seen = next(a, 'message-update', (m) => m.seenBy.length === 2);
  b.markSeen(mb.id); b.markSeen(mb.id); c.markSeen(mc.id);
  assert.deepEqual((await seen).seenBy.sort(), [b.me, c.me].sort());

  const unB = next(b, 'message-update', (m) => m.state === 'unsaid'), unC = next(c, 'message-update', (m) => m.state === 'unsaid');
  await a.unsay(sent.id);
  assert.equal((await unB).text, null);
  assert.equal((await unC).text, null);
  await assert.rejects(b.unsay(mb.id), /own messages/);
  [a, b, c].forEach((p) => p.leave());
});

test('an unsaid capsule never releases its key', async () => {
  const [a, b] = await room(['ada', 'bo']);
  const m = next(b, 'message');
  const cap = await a.capsule('regret', { opensInMs: 200 });
  const got = await m;
  await a.unsay(cap.id);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(b.messages.get(got.id).state, 'unsaid');
  assert.equal(b.messages.get(got.id).text, null);
  [a, b].forEach((p) => p.leave());
});

async function rawSocket() {
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  await new Promise((r) => (ws.onopen = r));
  const frames = [];
  ws.onmessage = (e) => frames.push(decodeFrame(e.data).header);
  const closed = new Promise((r) => (ws.onclose = r));
  return { ws, frames, closed };
}

test('relay rejects junk: bad rooms, sends before join, oversized frames', async () => {
  const bad = await rawSocket();
  bad.ws.send(encodeFrame({ t: 'join', room: '../../etc' }));
  await bad.closed;
  assert.equal(bad.frames[0]?.code, 'bad-room');

  const early = await rawSocket();
  early.ws.send(encodeFrame({ t: 'send', to: '*' }, new Uint8Array(10)));
  await early.closed;
  assert.equal(early.frames[0]?.code, 'not-joined');

  const big = await rawSocket();
  big.ws.send(new Uint8Array(2 * 1024 * 1024));
  await big.closed; // ws maxPayload kills the socket before the hub ever parses it
});
