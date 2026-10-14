# How hush works

End-to-end encrypted group chat over WebSockets, built on one rule: **the server is the enemy.**

A room is just a passphrase. The relay in the middle forwards bytes and learns almost nothing: not the
passphrase, not your names, not your words, not your file names, not your files.

```
npm install
npm start            # http://localhost:8080 — open it in two tabs, or on two machines with HOST=0.0.0.0
npm test             # 24 tests: ratchet, file streaming, a real relay with three clients
```

## What's different

| | |
| --- | --- |
| **Passphrase rooms** | No accounts, no phone numbers. PBKDF2 (600k rounds) splits the passphrase into a *room id* the relay sees and a *pre-shared key* it never sees. Every key exchange mixes in that key, so the relay can't sit in the middle without first cracking the passphrase. |
| **Safety words** | Each pair of people gets 5 words drawn from their shared secret. Read them aloud. Match = nobody in between, even if someone else knows the passphrase. |
| **Double Ratchet** | Signal's algorithm, per pair. Each message has its own key, deleted after use. Steal a phone today and you still can't read yesterday; the next reply heals the session. |
| **Tones** | `whisper` (burns 20s after it's read, on *both* sides), `say`, `SHOUT`. |
| **Riddles** | A message locked with an answer instead of just a key. Even the recipient's own device can't open it until they answer. 5 wrong guesses and it crumbles. |
| **Capsules** | Sent now, readable later. The ciphertext and a hash of its key go out at once. The key follows at the open time and is checked against the hash, so the sender can't change the message afterwards. If the sender disappears first, it stays sealed forever. |
| **Huge files** | Streamed in 256 KiB encrypted chunks, never held whole in memory. Credit-based flow control keeps at most 4 MiB in flight per recipient, however big the file. Chromium browsers write straight to disk. Chunks are bound to their file, position, and count, so they can't be reordered, dropped, or spliced. ~190 MiB/s through a local relay. |
| **Live typing** | Tick "type live" and the other side watches your words appear as you type them, still end-to-end encrypted. Untick it and they only see that you're typing. |
| **Unsay, reactions, seen** | Take back a message (an unsaid capsule never releases its key). React with an emoji. See who has actually seen your message on a visible screen. |
| **Padding** | Messages are padded to fixed sizes, so the relay sees only a size class, not your exact length. |
| **No server needed for the demo** | The relay logic (`src/relay/hub.js`) has no I/O. Node runs it behind WebSockets; the browser runs *the same code* in a SharedWorker so tabs can talk with nothing but static hosting. |

## Shape

```
src/core/       the engine: runs unchanged in browsers and Node
  primitives.js   WebCrypto only: P-256 ECDH, HKDF, HMAC, AES-256-GCM, PBKDF2
  room.js         passphrase → room id + pre-shared key; pair secrets; safety words
  ratchet.js      Double Ratchet
  frame.js        relay frames, envelopes, padding
  locks.js        riddles, capsules
  transfer.js     chunked file streaming + flow control
  engine.js       Hush: handshakes, fan-out, messages, files — emits events
src/relay/      hub.js (pure routing + limits), server.js (ws + static files)
src/transport/  websocket.js, tabs.js + hub-worker.js (SharedWorker)
web/            a thin UI over the engine
```

### Handshake

```
join   → relay assigns a random id, tells you who's here
hello  → each side sends a fresh P-256 public key (fresh every time you join)
secret = HKDF(ECDH(mine, theirs), salt = psk, info = label ‖ lowKey ‖ highKey)
         → ratchet root key, associated data, safety words
the side with the lower key starts the ratchet; its first message (your encrypted name)
proves to the other side that both hold the same secret
```

### Use the engine directly

```js
import { Hush, bytesSource } from './src/core/engine.js';
import { WebSocketTransport } from './src/transport/websocket.js';

const p = new Hush({ transport: new WebSocketTransport('ws://localhost:8080/ws'), passphrase: 'lantern-otter-quartz-river', name: 'ada' });
p.on('peer', (peer) => console.log(peer.name, peer.safetyWords));
p.on('message', (m) => console.log(m.from, m.text));
p.on('file-offer', (o) => p.acceptFile(o.fileId, { write: (b) => {}, close: () => {} }));
await p.join();
await p.say('hi', { tone: 'whisper' });
await p.riddle('the key is under the mat', 'What has keys but no locks?', 'a piano');
await p.capsule('happy new year', { opensInMs: 60_000 });
await p.draft('typing this live…', { live: true });
const m = await p.say('pizza?'); await p.react(m.id, '🍕'); await p.unsay(m.id);
await p.sendFile(bytesSource(new Uint8Array(1e9)), { name: 'big.bin' });
```

## What it does not protect (read this)

- **Not audited.** It uses only standard WebCrypto primitives, but the way they're composed has not been reviewed by anyone but its authors. Don't bet your life on it.
- **Web apps trust whoever serves the code.** If GitHub Pages or your server ships altered JavaScript, the encryption is moot. Run it yourself from source if that matters.
- **Metadata.** The relay sees who is in a room (by random id), when, how often, and coarse sizes. Ratchet counters are visible (no header encryption yet).
- **Weak passphrases.** The relay knows the room id, so it can guess passphrases offline. Each guess costs 600k PBKDF2 rounds; the generated 8-word passphrases (64 bits) make that hopeless. "password1" does not.
- **Burn, riddles, and capsules are enforced by honest clients.** A modified client can screenshot a whisper or keep guessing a riddle. The crypto makes riddle guessing slow and makes capsules impossible to open early; it can't make people forget.
- **No history.** Close the tab and it's gone. That's on purpose for now.

## Deploying

- **Static (GitHub Pages):** push to `main`; `.github/workflows/pages.yml` runs the tests and publishes `web/` + the engine. Turn on *Settings → Pages → Source: GitHub Actions*. With no server, tabs in one browser can talk; enter a `wss://` relay URL to talk across devices.
- **Relay:** any Node 22+ host. `HOST=0.0.0.0 PORT=8080 ALLOWED_ORIGINS=https://you.github.io npm start`, behind TLS (Caddy, Fly, Render, a VPS). The relay holds nothing worth stealing.

MIT
