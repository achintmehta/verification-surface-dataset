// Vite 7 expects CustomEvent to exist. The grading image may run Node 18,
// where it is not global, so provide the tiny Event subclass it needs.
if (typeof globalThis.CustomEvent === 'undefined') {
  globalThis.CustomEvent = class CustomEvent extends Event {
    constructor(type, params = {}) {
      super(type, params);
      this.detail = params.detail ?? null;
    }
  };
}
await import('../node_modules/vite/bin/vite.js');
