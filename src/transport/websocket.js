// WebSocket transport. Works in browsers and in Node >= 22 (global WebSocket).

export class WebSocketTransport {
  #ws = null;
  onframe = () => {};
  onclose = () => {};

  constructor(url) {
    if (!/^wss?:\/\//.test(url)) throw new TypeError('relay url must start with ws:// or wss://');
    this.url = url;
  }

  open() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => { this.#ws = ws; resolve(); };
      ws.onerror = () => reject(new Error(`could not reach relay at ${this.url}`));
      ws.onmessage = (e) => { if (e.data instanceof ArrayBuffer) this.onframe(new Uint8Array(e.data)); };
      ws.onclose = () => { this.#ws = null; this.onclose(); };
    });
  }

  send(bytes) {
    if (this.#ws?.readyState !== WebSocket.OPEN) throw new Error('relay not connected');
    this.#ws.send(bytes);
  }

  get bufferedAmount() { return this.#ws?.bufferedAmount ?? 0; }

  close() { this.#ws?.close(1000); }
}
