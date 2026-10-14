// Thin UI over the engine. All the interesting parts live in src/core.
// Rule here: user-supplied strings only ever go through textContent, never innerHTML.

import { Psst } from './src/core/engine.js';
import { generatePassphrase } from './src/core/room.js';
import { WebSocketTransport } from './src/transport/websocket.js';
import { TabsTransport } from './src/transport/tabs.js';

const $ = (s) => document.querySelector(s);
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids.filter((k) => k != null));
  return n;
};
const fmtBytes = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KiB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MiB` : `${(n / 1073741824).toFixed(2)} GiB`;

let psst = null;
const rows = new Map();   // message id → <li>
const drafts = new Map(); // peer id → { text, timer } — what they're typing right now
const REACTIONS = ['👍', '😂', '😮', '❤️', '🍕'];
const fileRows = new Map(); // fileId → { li, bar, label }

// ── gate ────────────────────────────────────────────────────────────────────

const fromHash = new URLSearchParams(location.hash.slice(1)).get('room');
$('#pass').value = fromHash ?? '';
$('#name').value = localStorageGet('psst:name') ?? '';
$('#gen').onclick = () => { $('#pass').value = generatePassphrase(); };
$('#relay').onchange = () => { $('#relay-url').hidden = $('#relay').value !== 'custom'; };

// Served by our Node relay? Then default to it; otherwise (GitHub Pages) default to in-browser tabs.
fetch(new URL('health', location.href)).then((r) => (r.ok ? r.json() : null)).catch(() => null).then((s) => {
  if (s && 'rooms' in s) $('#relay').value = 'server';
  else $('#relay').querySelector('[value=server]').disabled = true;
});

$('#join-form').onsubmit = async (e) => {
  e.preventDefault();
  const status = $('#gate-status');
  $('#join-btn').disabled = true;
  try {
    status.textContent = 'stretching the passphrase (600k PBKDF2 rounds)…';
    localStorageSet('psst:name', $('#name').value);
    psst = new Psst({ transport: makeTransport(), passphrase: $('#pass').value, name: $('#name').value || 'anon' });
    wire(psst);
    const pass = $('#pass').value;
    const { roomId } = await psst.join();
    history.replaceState(null, '', `#room=${encodeURIComponent(pass)}`);
    $('#room-id').textContent = roomId.slice(0, 8);
    $('#gate').hidden = true;
    $('#room').hidden = false;
    sys(`you are in. ${$('#relay').value === 'tabs' ? 'open this page in another tab to talk to yourself, securely.' : 'share the invite link.'}`);
    $('#text').focus();
  } catch (err) {
    status.textContent = err.message;
    psst = null;
  } finally {
    $('#join-btn').disabled = false;
  }
};

function makeTransport() {
  const mode = $('#relay').value;
  if (mode === 'tabs') return new TabsTransport();
  if (mode === 'server') { const u = new URL('ws', location.href); u.protocol = u.protocol.replace('http', 'ws'); return new WebSocketTransport(u.href); }
  return new WebSocketTransport($('#relay-url').value.trim());
}

// ── engine events → DOM ─────────────────────────────────────────────────────

function wire(p) {
  p.on('peer', renderPeers);
  p.on('peer-left', (peer) => { renderPeers(); sys(`${peer.name} left`); });
  p.on('message', (m) => renderMessage(m));
  p.on('message-update', (m) => renderMessage(m));
  p.on('knock', ({ name }) => { sys(`${name} knocked`); document.body.classList.remove('knocked'); void document.body.offsetWidth; document.body.classList.add('knocked'); });
  p.on('file-offer', renderOffer);
  p.on('file-progress', ({ fileId, bytes, size }) => { const r = fileRows.get(fileId); if (r) { r.bar.value = bytes / size; r.label.textContent = `${fmtBytes(bytes)} / ${fmtBytes(size)}`; } });
  p.on('file-done', ({ fileId, direction, name }) => { const r = fileRows.get(fileId); if (r) r.label.textContent = direction === 'in' ? 'received — verified, chunk by chunk' : `delivered: ${name}`; });
  p.on('file-failed', ({ fileId, reason }) => { const r = fileRows.get(fileId); if (r) r.label.textContent = `failed: ${reason}`; });
  p.on('relay-error', ({ message }) => sys(`relay: ${message}`));
  p.on('disconnected', ({ reason }) => sys(`disconnected: ${reason}`));
  p.on('warning', (w) => console.warn('[psst]', w));
  p.on('draft', ({ from, active, text }) => {
    clearTimeout(drafts.get(from)?.timer);
    if (!active) drafts.delete(from);
    else drafts.set(from, { text, timer: setTimeout(() => { drafts.delete(from); renderPeers(); }, 6000) });
    renderPeers();
  });
}

function renderPeers() {
  const list = $('#peers');
  list.replaceChildren(...[...psst.peers.values()].map((p) => el('li', {},
    el('div', { textContent: `${p.name ?? '…'}${p.ready ? '' : ' (handshaking)'}` }),
    el('div', { className: 'words', textContent: p.safetyWords?.join(' · ') ?? '' }),
    drafts.has(p.id) ? el('div', { className: 'draft', textContent: drafts.get(p.id).text ? `✎ ${drafts.get(p.id).text}` : '✎ typing…' }) : null)));
  if (!psst.peers.size) list.replaceChildren(el('li', { className: 'hint', textContent: 'nobody else here yet' }));
}

const nameOf = (id) => id === psst.me ? 'you' : psst.peers.get(id)?.name ?? 'someone';

function sys(text) { scrollAppend(el('li', { className: 'sys', textContent: text })); }

function scrollAppend(li) {
  const log = $('#log');
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.append(li);
  if (atBottom) log.scrollTop = log.scrollHeight;
}

function renderMessage(m) {
  const li = rows.get(m.id) ?? el('li');
  li.className = `${m.mine ? 'mine' : ''} tone-${m.tone}`;
  li.replaceChildren(el('div', { className: 'who', textContent: `${nameOf(m.from)} · ${m.kind === 'text' ? m.tone : m.kind}` }), bodyFor(m), footFor(m));
  if (!rows.has(m.id)) { rows.set(m.id, li); scrollAppend(li); }
  // Burnable messages count as seen when revealed; everything else when it's on a visible screen.
  if (!m.mine && !m.burn && document.visibilityState === 'visible') psst.markSeen(m.id);
}

function footFor(m) {
  if (m.state === 'unsaid' || m.state === 'burned') return null;
  const foot = el('div', { className: 'foot' });
  const counts = new Map();
  for (const { emoji } of m.reactions) counts.set(emoji, (counts.get(emoji) ?? 0) + 1);
  const mineR = m.reactions.find((r) => r.from === psst.me)?.emoji;
  for (const e of REACTIONS) {
    const n = counts.get(e) ?? 0;
    const b = el('button', { className: `react${mineR === e ? ' on' : ''}${n ? ' has' : ''}`, textContent: n ? `${e}${n}` : e, type: 'button' });
    b.onclick = () => psst.react(m.id, mineR === e ? null : e);
    foot.append(b);
  }
  if (m.mine) {
    if (m.seenBy.length) foot.append(el('span', { className: 'seen', textContent: `seen by ${m.seenBy.map(nameOf).join(', ')}` }));
    const un = el('button', { className: 'react', textContent: 'unsay', type: 'button' });
    un.onclick = () => psst.unsay(m.id);
    foot.append(un);
  }
  return foot;
}

function bodyFor(m) {
  if (m.state === 'unsaid') return el('div', { className: 'body burned', textContent: 'unsaid' });
  if (m.state === 'burned') return el('div', { className: 'body burned', textContent: 'burned' });
  if (m.state === 'crumbled') return el('div', { className: 'body burned', textContent: `riddle crumbled: "${m.question}"` });

  if (m.kind === 'riddle' && m.state === 'locked') {
    const input = el('input', { placeholder: `answer (${m.triesLeft} tries)` });
    const form = el('form', { className: 'row' }, input, el('button', { textContent: 'try' }));
    form.onsubmit = async (e) => { e.preventDefault(); input.disabled = true; await psst.solve(m.id, input.value); };
    return el('div', { className: 'body' }, el('div', { textContent: `🔒 ${m.question}` }), form);
  }
  if (m.kind === 'capsule' && m.state === 'sealed') {
    const span = el('span', { className: 'sealed' });
    const tick = (first) => {
      const left = Math.max(0, m.opensAt - Date.now());
      span.textContent = `${m.mine ? `"${m.text}" — ` : ''}sealed capsule · opens in ${Math.ceil(left / 1000)}s`;
      if (left > 0 && (first || span.isConnected)) setTimeout(tick, 1000); // stop once re-rendered away
    };
    tick(true);
    return el('div', { className: 'body' }, span);
  }
  if (m.burn && !m.mine && !m.burnAt) {
    const s = el('span', { className: 'sealed', textContent: `tap to read — burns ${m.burn}s after` });
    s.onclick = () => psst.reveal(m.id);
    return el('div', { className: 'body' }, s);
  }
  const body = el('div', { className: 'body', textContent: m.text ?? '' });
  if (m.burnAt) {
    const fuse = el('span', { className: 'fuse' });
    const tick = (first) => { const left = m.burnAt - Date.now(); fuse.textContent = ` 🔥${Math.max(0, Math.ceil(left / 1000))}s`; if (left > 0 && (first || fuse.isConnected)) setTimeout(tick, 250); };
    tick(true);
    body.append(fuse);
  }
  return body;
}

// ── composer ────────────────────────────────────────────────────────────────

const mode = () => document.querySelector('[name=mode]:checked').value;
for (const r of document.querySelectorAll('[name=mode]')) r.onchange = renderExtra;
function renderExtra() {
  const extra = $('#extra');
  if (mode() === 'riddle') extra.replaceChildren(el('input', { id: 'q', placeholder: 'question they must answer' }), el('input', { id: 'a', placeholder: 'the answer' }));
  else if (mode() === 'capsule') extra.replaceChildren(el('label', { textContent: 'opens in ' }, el('input', { id: 'mins', type: 'number', min: '0.1', max: '10080', step: '0.1', value: '1' })), el('span', { textContent: ' minutes' }));
  else extra.replaceChildren();
}

// Typing presence, throttled. "live" sends the actual words as you type them.
let draftTimer = null;
$('#text').oninput = () => {
  if (draftTimer) return;
  draftTimer = setTimeout(() => { draftTimer = null; psst.draft($('#text').value, { live: $('#live').checked }).catch(() => {}); }, 120);
};
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && psst) for (const m of psst.messages.values()) if (!m.burn && m.from !== psst.me) psst.markSeen(m.id);
});

$('#text').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#composer').requestSubmit(); } };
$('#composer').onsubmit = async (e) => {
  e.preventDefault();
  const text = $('#text').value;
  if (!text.trim()) return;
  try {
    const m = mode();
    if (m === 'riddle') await psst.riddle(text, $('#q').value, $('#a').value);
    else if (m === 'capsule') await psst.capsule(text, { opensInMs: Number($('#mins').value) * 60_000 });
    else await psst.say(text, { tone: m });
    $('#text').value = '';
    psst.draft('').catch(() => {});
  } catch (err) { sys(`not sent: ${err.message}`); }
};
$('#knock').onclick = () => psst.knock();
$('#leave').onclick = () => { psst.leave(); history.replaceState(null, '', location.pathname); location.reload(); };
$('#invite').onclick = async () => { await navigator.clipboard.writeText(location.href); sys('invite link copied. the passphrase is in the #fragment, which browsers never send to servers.'); };

// ── files ───────────────────────────────────────────────────────────────────

const fileSource = (file) => ({ size: file.size, slice: async (s, e) => new Uint8Array(await file.slice(s, e).arrayBuffer()) });

$('#file').onchange = async (e) => {
  for (const file of e.target.files) {
    if (!psst.peers.size) { sys('nobody here to send to'); break; }
    const { fileId } = await psst.sendFile(fileSource(file), { name: file.name, mime: file.type || undefined });
    const cancel = el('button', { textContent: 'cancel', type: 'button' });
    fileRow(fileId, `you offered ${file.name} (${fmtBytes(file.size)})`, 'waiting for someone to accept…', el('div', { className: 'row' }, cancel));
    cancel.onclick = () => { psst.cancelFile(fileId); cancel.remove(); fileRows.get(fileId).label.textContent = 'cancelled'; };
  }
  e.target.value = '';
};

function fileRow(fileId, title, status, actions) {
  const bar = el('progress', { max: 1, value: 0 });
  const label = el('span', { textContent: status });
  const li = el('li', {}, el('div', { className: 'file' }, el('div', { textContent: title }), bar, label, actions));
  fileRows.set(fileId, { li, bar, label });
  scrollAppend(li);
}

function renderOffer({ fileId, from, name, size, mime }) {
  const accept = el('button', { textContent: 'accept' });
  const decline = el('button', { textContent: 'decline' });
  const actions = el('div', { className: 'row' }, accept, decline);
  fileRow(fileId, `${nameOf(from)} offers ${name} (${fmtBytes(size)})`, 'not downloading', actions);
  decline.onclick = () => { psst.declineFile(fileId); actions.remove(); fileRows.get(fileId).label.textContent = 'declined'; };
  accept.onclick = async () => {
    actions.remove();
    try { await psst.acceptFile(fileId, await makeSink(name, mime, fileId)); }
    catch (err) { fileRows.get(fileId).label.textContent = `not accepted: ${err.message}`; }
  };
}

// Big files go straight to disk when the browser allows it (Chromium); otherwise they
// collect into a Blob, which browsers page to disk on their own for large sizes.
async function makeSink(name, mime, fileId) {
  if ('showSaveFilePicker' in window) {
    const handle = await window.showSaveFilePicker({ suggestedName: name });
    const w = await handle.createWritable();
    return { write: (b) => w.write(b), close: () => w.close(), abort: () => w.abort() };
  }
  const parts = [];
  return {
    write: (b) => void parts.push(b),
    close: () => {
      const url = URL.createObjectURL(new Blob(parts, { type: mime }));
      parts.length = 0;
      const r = fileRows.get(fileId);
      r?.li.querySelector('.file').append(el('a', { href: url, download: name, textContent: `save ${name}` }));
    },
    abort: () => { parts.length = 0; },
  };
}

function localStorageGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function localStorageSet(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } }
