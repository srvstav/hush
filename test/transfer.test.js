import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Outgoing, Incoming, newFileSecret, CHUNK_SIZE, chunkCount } from '../src/core/transfer.js';
import { random, equal, concat } from '../src/core/bytes.js';
import { lockRiddle, solveRiddle, sealCapsule, openCapsule } from '../src/core/locks.js';
import { pad, unpad } from '../src/core/frame.js';

const source = (b) => ({ size: b.length, slice: async (s, e) => b.subarray(s, e) });
const memSink = () => { const parts = []; return { parts, closed: false, write(p) { parts.push(p.slice()); }, close() { this.closed = true; } }; };

function wire(data, { mangle } = {}) {
  const secret = newFileSecret();
  const sink = memSink();
  let out;
  const inc = new Incoming({ secret, size: data.length, sink, sendAck: (n) => out.ack(n) });
  out = new Outgoing({ secret, source: source(data), sendChunk: async (i, ct) => { const r = mangle ? mangle(i, ct) : [[i, ct]]; for (const [j, c] of r) await inc.receive(j, c); } });
  return { out, inc, sink };
}

for (const size of [0, 1, CHUNK_SIZE - 1, CHUNK_SIZE, CHUNK_SIZE * 3 + 17, CHUNK_SIZE * 40]) {
  test(`streams ${size} bytes intact`, async () => {
    const data = new Uint8Array(size).map((_, i) => i * 31 + (i >> 8));
    const { out, sink } = wire(data);
    await out.run();
    assert.ok(sink.closed);
    assert.ok(equal(concat(...sink.parts), data));
    assert.equal(sink.parts.length, chunkCount(size));
  });
}

test('reordered, duplicated, or tampered chunks are rejected', async () => {
  const data = new Uint8Array(CHUNK_SIZE * 3);
  await assert.rejects(wire(data, { mangle: (i, ct) => (i === 1 ? [[2, ct]] : [[i, ct]]) }).out.run(), /out of order/);
  await assert.rejects(wire(data, { mangle: (i, ct) => [[i, ct], [i, ct]] }).out.run(), /out of order/);
  await assert.rejects(wire(data, { mangle: (i, ct) => { ct[5] ^= 1; return [[i, ct]]; } }).out.run(), /decryption failed/);
});

test('riddles open only with the right answer (case/punctuation-insensitive)', async () => {
  const r = await lockRiddle('the treasure is under the oak', 'What has keys but no locks?', 'A piano!', 1000);
  assert.equal(await solveRiddle(r, 'keyboard'), null);
  assert.equal(await solveRiddle(r, '  a PIANO '), 'the treasure is under the oak');
  assert.equal(await solveRiddle({ ...r, question: 'swapped question' }, 'a piano'), null); // question is bound
});

test('capsules verify their commitment', async () => {
  const { capsule, key } = await sealCapsule('see you next year');
  assert.equal(await openCapsule(capsule, key), 'see you next year');
  const { key: other } = await sealCapsule('decoy');
  await assert.rejects(openCapsule(capsule, other), /commitment/);
});

test('padding hides exact length', () => {
  assert.equal(pad({ k: 'text', text: 'hi' }).length, pad({ k: 'text', text: 'hello there friend' }).length);
  assert.deepEqual(unpad(pad({ a: [1, 2] })), { a: [1, 2] });
});
