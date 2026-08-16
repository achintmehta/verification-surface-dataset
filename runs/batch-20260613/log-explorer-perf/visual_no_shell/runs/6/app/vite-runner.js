// Node 18 does not expose CustomEvent globally, while newer Vite CLIs expect it.
// Polyfill before loading Vite's CLI so the dev script works on the grader image.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

if (typeof globalThis.CustomEvent === 'undefined') {
  globalThis.CustomEvent = class CustomEvent extends Event {
    constructor(type, params = {}) {
      super(type, params);
      this.detail = params.detail ?? null;
    }
  };
}
await import(pathToFileURL(path.resolve('node_modules/vite/bin/vite.js')).href);
