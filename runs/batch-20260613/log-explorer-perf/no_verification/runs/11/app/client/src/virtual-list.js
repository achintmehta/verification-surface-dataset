import { fetchLogs } from './api.js';

const ROW_HEIGHT = 28; // must match --row-h in CSS
const OVERSCAN = 12; // extra rows above/below viewport
const WINDOW = 200; // rows fetched per request (server cap)

/**
 * Virtualized, windowed log list.
 *
 * Design:
 *  - The spacer element is sized to `total * ROW_HEIGHT`, giving a real
 *    scrollbar for the whole (filtered) corpus without rendering it.
 *  - Only rows intersecting the viewport (+ overscan) exist in the DOM. They
 *    are drawn from a recycled pool of DOM nodes, so the DOM node count is
 *    bounded (~viewport rows + overscan), independent of corpus size.
 *  - Row data is fetched in aligned windows of WINDOW rows and cached by
 *    window index. Only a bounded set of recent windows is kept.
 *  - Every fetch carries a monotonically increasing request id; stale
 *    responses (older id than the latest applied) are discarded so
 *    out-of-order network results never overwrite newer data.
 */
export class VirtualList {
  constructor({ viewport, spacer, rows, onCount }) {
    this.viewport = viewport;
    this.spacer = spacer;
    this.rows = rows;
    this.onCount = onCount;

    this.total = 0;
    this.filter = { severity: '', q: '' };

    // window index -> array of row objects
    this.cache = new Map();
    // window index -> in-flight AbortController
    this.inflight = new Map();

    // request sequencing to drop stale responses
    this.reqSeq = 0;
    this.lastAppliedSeq = 0;

    // recycled DOM node pool
    this.pool = [];

    this._onScroll = this._onScroll.bind(this);
    this.viewport.addEventListener('scroll', this._onScroll, { passive: true });
    window.addEventListener('resize', () => this._render());
  }

  /** Set/replace the active filter and reset the view to the top. */
  async setFilter(filter) {
    this.filter = { ...filter };
    // Reset caches & scroll — filter change invalidates everything.
    this._abortAll();
    this.cache.clear();
    this.viewport.scrollTop = 0;
    await this.refreshTotalAndRender();
  }

  /** Fetch the total for the current filter (window 0) and render. */
  async refreshTotalAndRender() {
    // A window-0 fetch gives us both total and the first page.
    await this._ensureWindow(0, /*forceTotal*/ true);
    this._render();
  }

  _visibleRange() {
    const scrollTop = this.viewport.scrollTop;
    const height = this.viewport.clientHeight;
    let start = Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN;
    let end = Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN;
    start = Math.max(0, start);
    end = Math.min(this.total, end);
    return { start, end };
  }

  _windowsFor(start, end) {
    const first = Math.floor(start / WINDOW);
    const last = Math.floor(Math.max(start, end - 1) / WINDOW);
    const wins = [];
    for (let w = first; w <= last; w++) wins.push(w);
    return wins;
  }

  _onScroll() {
    // Rendering on scroll is cheap (bounded DOM ops); data fetches are
    // deduped and windowed. Use rAF to coalesce rapid scroll events.
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = null;
      this._render();
    });
  }

  _render() {
    // Keep spacer sized to the full filtered corpus.
    this.spacer.style.height = `${this.total * ROW_HEIGHT}px`;

    if (this.total === 0) {
      this._clearRows();
      this._renderEmpty();
      return;
    }
    this._removeEmpty();

    const { start, end } = this._visibleRange();

    // Kick off fetches for any windows we need but don't have.
    for (const w of this._windowsFor(start, end)) {
      if (!this.cache.has(w) && !this.inflight.has(w)) {
        this._ensureWindow(w, false);
      }
    }

    this._paint(start, end);
  }

  _paint(start, end) {
    const needed = end - start;

    // Grow the pool if necessary.
    while (this.pool.length < needed) {
      const node = document.createElement('div');
      node.className = 'log-row';
      node.innerHTML =
        '<div class="col col-ts"></div>' +
        '<div class="col col-sev"></div>' +
        '<div class="col col-svc"></div>' +
        '<div class="col col-msg"></div>';
      node._cells = {
        ts: node.children[0],
        sev: node.children[1],
        svc: node.children[2],
        msg: node.children[3],
      };
      this.pool.push(node);
      this.rows.appendChild(node);
    }

    // Position the rows container so row `start` sits at its absolute offset.
    this.rows.style.transform = `translateY(${start * ROW_HEIGHT}px)`;

    for (let i = 0; i < this.pool.length; i++) {
      const node = this.pool[i];
      const rowIndex = start + i;
      if (i >= needed || rowIndex >= this.total) {
        node.style.display = 'none';
        continue;
      }
      node.style.display = '';
      const data = this._rowData(rowIndex);
      if (data) {
        this._fillRow(node, data);
        node.dataset.loading = '';
      } else {
        // Data not yet loaded — show a placeholder rather than a blank gap.
        this._fillPlaceholder(node);
        node.dataset.loading = '1';
      }
    }
  }

  _rowData(rowIndex) {
    const w = Math.floor(rowIndex / WINDOW);
    const arr = this.cache.get(w);
    if (!arr) return null;
    return arr[rowIndex - w * WINDOW] || null;
  }

  _fillRow(node, d) {
    node._cells.ts.textContent = formatTs(d.ts);
    node._cells.sev.innerHTML = `<span class="sev-badge sev-${d.severity}">${d.severity}</span>`;
    node._cells.svc.textContent = d.service;
    node._cells.msg.textContent = d.message;
  }

  _fillPlaceholder(node) {
    node._cells.ts.textContent = '…';
    node._cells.sev.innerHTML = '';
    node._cells.svc.textContent = '';
    node._cells.msg.textContent = '';
  }

  async _ensureWindow(w, forceTotal) {
    if (this.inflight.has(w)) return;
    const controller = new AbortController();
    this.inflight.set(w, controller);
    const seq = ++this.reqSeq;

    try {
      const { total, rows } = await fetchLogs({
        offset: w * WINDOW,
        limit: WINDOW,
        severity: this.filter.severity,
        q: this.filter.q,
        signal: controller.signal,
      });

      // Drop stale responses: only apply if this is the newest response
      // we've seen. Newer requests (higher seq) always win.
      if (seq < this.lastAppliedSeq) {
        return;
      }
      this.lastAppliedSeq = seq;

      // total can change per filter; always trust the latest.
      if (this.total !== total) {
        this.total = total;
        this._updateCount();
        // Evict windows that are now out of range.
        for (const key of [...this.cache.keys()]) {
          if (key * WINDOW >= total) this.cache.delete(key);
        }
      } else if (forceTotal) {
        this._updateCount();
      }

      this.cache.set(w, rows);
      this._evictDistantWindows(w);
      this._render();
    } catch (err) {
      if (err.name === 'AbortError') return; // superseded / cancelled
      console.error('[virtual-list] fetch failed', err);
    } finally {
      this.inflight.delete(w);
    }
  }

  _evictDistantWindows(centerWindow) {
    // Keep at most a handful of windows around the current one.
    const KEEP = 6;
    if (this.cache.size <= KEEP) return;
    const keys = [...this.cache.keys()];
    keys.sort((a, b) => Math.abs(a - centerWindow) - Math.abs(b - centerWindow));
    for (const k of keys.slice(KEEP)) this.cache.delete(k);
  }

  _abortAll() {
    for (const c of this.inflight.values()) c.abort();
    this.inflight.clear();
  }

  _updateCount() {
    if (this.onCount) this.onCount(this.total);
  }

  _clearRows() {
    for (const node of this.pool) node.style.display = 'none';
  }

  _renderEmpty() {
    if (this._emptyEl) return;
    this._emptyEl = document.createElement('div');
    this._emptyEl.className = 'empty';
    this._emptyEl.textContent = 'No matching log entries.';
    this.viewport.appendChild(this._emptyEl);
  }

  _removeEmpty() {
    if (this._emptyEl) {
      this._emptyEl.remove();
      this._emptyEl = null;
    }
  }
}

function formatTs(iso) {
  // Compact, sortable display: YYYY-MM-DD HH:MM:SS
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
  );
}
