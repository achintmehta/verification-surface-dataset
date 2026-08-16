import { fetchLogs } from './api.js';

const ROW_HEIGHT = 32; // must match --row-h in style.css
const WINDOW = 200; // rows per API request (server cap)
const OVERSCAN = 20; // extra rows above/below the viewport
// Browsers cap element height (~33.5M px in Chrome). At 32px/row, 100k rows is
// 3.2M px which is well under the cap, so a direct 1:1 spacer is safe here.

const SEVERITIES = ['debug', 'info', 'warn', 'error'];

function fmtTs(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}

/**
 * VirtualTable renders only the rows intersecting the viewport (plus overscan),
 * recycling DOM nodes as the user scrolls. It fetches the corpus window-by-
 * window from the server and guards against out-of-order responses.
 */
export class VirtualTable {
  constructor({ viewport, spacer, rowsEl, onCount, onStatus }) {
    this.viewport = viewport;
    this.spacer = spacer;
    this.rowsEl = rowsEl;
    this.onCount = onCount;
    this.onStatus = onStatus;

    this.total = 0;
    this.filters = { severity: '', q: '' };

    // rowCache maps absolute row index -> row object.
    this.rowCache = new Map();
    // Which windows have been requested/loaded, keyed by window start index.
    this.loadedWindows = new Set();
    this.pendingWindows = new Map(); // start -> AbortController

    // Monotonic token: every filter change bumps this. Any in-flight request
    // tagged with a stale token has its result discarded, so out-of-order or
    // superseded responses never overwrite newer state.
    this.queryToken = 0;

    // Pool of reusable row DOM nodes.
    this.pool = [];

    this.viewport.addEventListener('scroll', () => this.render(), { passive: true });
    window.addEventListener('resize', () => this.render());
  }

  /** Set/replace filters. Resets scroll, cache, and the virtual height. */
  async setFilters({ severity, q }) {
    this.filters = { severity: severity || '', q: q || '' };
    this.queryToken++;
    const token = this.queryToken;

    // Abort any in-flight window fetches from the previous filter state.
    for (const ctrl of this.pendingWindows.values()) ctrl.abort();
    this.pendingWindows.clear();
    this.rowCache.clear();
    this.loadedWindows.clear();

    this.viewport.scrollTop = 0;

    // Fetch the first window to learn `total` and prime the top of the list.
    await this.loadWindow(0, token, /* primary */ true);
  }

  /** Compute which absolute row range is currently visible (with overscan). */
  visibleRange() {
    const scrollTop = this.viewport.scrollTop;
    const height = this.viewport.clientHeight;
    const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const visibleCount = Math.ceil(height / ROW_HEIGHT) + OVERSCAN * 2;
    const last = Math.min(this.total, first + visibleCount);
    return { first, last };
  }

  /** Snap a row index down to the start of its window. */
  windowStartFor(index) {
    return Math.floor(index / WINDOW) * WINDOW;
  }

  /** Ensure all windows covering [first,last) are loaded, then render. */
  ensureWindows(first, last, token) {
    if (this.total === 0) return;
    const startWin = this.windowStartFor(first);
    const endWin = this.windowStartFor(Math.max(first, last - 1));
    for (let w = startWin; w <= endWin; w += WINDOW) {
      if (w >= this.total) break;
      if (this.loadedWindows.has(w) || this.pendingWindows.has(w)) continue;
      this.loadWindow(w, token, false);
    }
  }

  async loadWindow(start, token, primary) {
    const ctrl = new AbortController();
    this.pendingWindows.set(start, ctrl);
    if (primary) this.setStatus('loading', 'loading…');

    try {
      const { total, rows } = await fetchLogs({
        offset: start,
        limit: WINDOW,
        severity: this.filters.severity,
        q: this.filters.q,
        signal: ctrl.signal,
      });

      // Discard stale results: a newer filter change happened while we waited.
      if (token !== this.queryToken) return;

      this.total = total;
      for (let i = 0; i < rows.length; i++) {
        this.rowCache.set(start + i, rows[i]);
      }
      this.loadedWindows.add(start);

      if (primary) {
        this.updateSpacer();
        this.emitCount();
      }
      this.setStatus('', '');
      this.render();
    } catch (err) {
      if (err.name === 'AbortError') return; // superseded, expected
      if (token !== this.queryToken) return;
      this.setStatus('error', 'error');
      console.error('window load failed', err);
    } finally {
      // Only clear if this controller is still the registered one.
      if (this.pendingWindows.get(start) === ctrl) {
        this.pendingWindows.delete(start);
      }
    }
  }

  updateSpacer() {
    this.spacer.style.height = `${this.total * ROW_HEIGHT}px`;
  }

  emitCount() {
    if (this.onCount) this.onCount(this.total);
  }

  setStatus(cls, text) {
    if (this.onStatus) this.onStatus(cls, text);
  }

  /** Render the visible window, recycling pooled row nodes. */
  render() {
    const token = this.queryToken;
    const { first, last } = this.visibleRange();

    this.ensureWindows(first, last, token);

    const needed = Math.max(0, last - first);

    // Grow the pool if needed.
    while (this.pool.length < needed) {
      this.pool.push(this.makeRow());
    }

    // Position and fill each pooled node for its absolute index.
    for (let i = 0; i < needed; i++) {
      const index = first + i;
      const node = this.pool[i];
      const row = this.rowCache.get(index);
      this.paintRow(node, index, row);
      node.style.display = '';
      if (!node.parentNode) this.rowsEl.appendChild(node);
    }
    // Hide surplus pooled nodes (recycled, not destroyed).
    for (let i = needed; i < this.pool.length; i++) {
      this.pool[i].style.display = 'none';
    }

    // Offset the row container so absolute-positioned rows land at the right
    // scroll position without holding 100k nodes.
    this.rowsEl.style.transform = `translateY(${first * ROW_HEIGHT}px)`;
  }

  makeRow() {
    const el = document.createElement('div');
    el.className = 'log-row';
    el.innerHTML =
      '<div class="col col-ts"></div>' +
      '<div class="col col-sev"><span class="sev-badge"></span></div>' +
      '<div class="col col-svc"></div>' +
      '<div class="col col-msg"></div>';
    el._ts = el.children[0];
    el._sev = el.children[1].firstChild;
    el._svc = el.children[2];
    el._msg = el.children[3];
    return el;
  }

  paintRow(node, index, row) {
    if (!row) {
      // Not yet loaded — show a placeholder rather than a blank gap. The
      // window is being fetched; render() will repaint when it arrives.
      node.classList.add('placeholder');
      node._ts.textContent = '…';
      node._sev.textContent = '';
      node._sev.className = 'sev-badge';
      node._svc.textContent = '';
      node._msg.textContent = '';
      return;
    }
    node.classList.remove('placeholder');
    node._ts.textContent = fmtTs(row.ts);
    node._sev.textContent = row.severity;
    node._sev.className = `sev-badge sev-${row.severity}`;
    node._svc.textContent = row.service;
    node._msg.textContent = row.message;
  }
}

export { SEVERITIES, ROW_HEIGHT };
