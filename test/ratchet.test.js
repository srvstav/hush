import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ratchet } from '../src/core/ratchet.js';
import { dhKeyPair } from '../src/core/primitives.js';
import { random, utf8, fromUtf8 } from '../src/core/bytes.js';

async function pair() {
  const sk = random(32), ad = random(32);
  const bobKeys = await dhKeyPair();
  return { alice: await Ratchet.alice(sk, bobKeys.pub, ad), bob: Ratchet.bob(sk, bobKeys, ad) };
}
const txt = (b) => fromUtf8(b);

test('ping-pong across many DH ratchet steps', async () => {
  const { alice, bob } = await pair();
  assert.equal(bob.canSend, false);
  for (let i = 0; i < 20; i++) {
    assert.equal(txt(await bob.decrypt(await alice.encrypt(utf8(`a${i}`)))), `a${i}`);
    assert.equal(txt(await alice.decrypt(await bob.encrypt(utf8(`b${i}`)))), `b${i}`);
  }
});

test('out-of-order and across-ratchet delivery', async () => {
  const { alice, bob } = await pair();
  const a = await Promise.all([0, 1, 2, 3].map((i) => alice.encrypt(utf8(`a${i}`))));
  assert.equal(txt(await bob.decrypt(a[2])), 'a2');
  const b0 = await bob.encrypt(utf8('b0'));
  assert.equal(txt(await alice.decrypt(b0)), 'b0');
  const a4 = await alice.encrypt(utf8('a4')); // new chain; a0,a1,a3 are from the previous one
  assert.equal(txt(await bob.decrypt(a4)), 'a4');
  assert.equal(txt(await bob.decrypt(a[0])), 'a0');
  assert.equal(txt(await bob.decrypt(a[3])), 'a3');
  assert.equal(txt(await bob.decrypt(a[1])), 'a1');
});

test('replays, tampering, and wrong sessions are rejected without corrupting state', async () => {
  const { alice, bob } = await pair();
  const m = await alice.encrypt(utf8('once'));
  await bob.decrypt(m);
  await assert.rejects(bob.decrypt(m), /decryption failed/);

  const t = await alice.encrypt(utf8('tamper'));
  t[t.length - 1] ^= 1;
  await assert.rejects(bob.decrypt(t), /decryption failed/);
  const h = await alice.encrypt(utf8('header'));
  h[70] ^= 1; // flip a counter bit
  await assert.rejects(bob.decrypt(h));

  const other = await pair();
  await assert.rejects(bob.decrypt(await other.alice.encrypt(utf8('x'))));

  assert.equal(txt(await bob.decrypt(await alice.encrypt(utf8('still fine')))), 'still fine');
});

test('a huge counter gap is refused (skip DoS)', async () => {
  const { alice, bob } = await pair();
  const m = await alice.encrypt(utf8('x'));
  m.set([0, 0, 0xff, 0xff], 69); // n = 65535
  await assert.rejects(bob.decrypt(m), /too many skipped/);
});
