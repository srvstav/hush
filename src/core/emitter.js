export class Emitter {
  #handlers = new Map();

  on(event, fn) {
    if (!this.#handlers.has(event)) this.#handlers.set(event, new Set());
    this.#handlers.get(event).add(fn);
    return () => this.#handlers.get(event)?.delete(fn);
  }

  once(event, fn) {
    const off = this.on(event, (v) => { off(); fn(v); });
    return off;
  }

  emit(event, value) {
    for (const fn of this.#handlers.get(event) ?? []) {
      try { fn(value); } catch (err) { console.error(`[parley] ${event} handler threw`, err); }
    }
  }
}
