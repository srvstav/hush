// In-browser transport: tabs of the same origin talk through a SharedWorker running the relay hub.
// Messages are still end-to-end encrypted — the worker is just as untrusted as a real relay.

export class TabsTransport {
  #port = null;
  onframe = () => {};
  onclose = () => {};

  static get supported() { return typeof SharedWorker !== 'undefined'; }

  async open() {
    if (!TabsTransport.supported) throw new Error('this browser has no SharedWorker — use a WebSocket relay instead');
    const worker = new SharedWorker(new URL('./hub-worker.js', import.meta.url), { type: 'module', name: 'parley-hub' });
    worker.onerror = (e) => console.error('[parley] hub worker failed', e);
    this.#port = worker.port;
    this.#port.onmessage = ({ data }) => {
      if (data === 'closed') return this.#closed();
      if (data instanceof Uint8Array) this.onframe(data);
    };
    this.#port.start();
    addEventListener('pagehide', () => this.close(), { once: true });
  }

  send(bytes) {
    if (!this.#port) throw new Error('not connected');
    const copy = bytes.slice(); // transfer a private copy; the caller may reuse its buffer
    this.#port.postMessage(copy, [copy.buffer]);
  }

  get bufferedAmount() { return 0; }

  close() {
    this.#port?.postMessage('bye');
    this.#closed();
  }

  #closed() {
    if (!this.#port) return;
    this.#port.close();
    this.#port = null;
    this.onclose();
  }
}
