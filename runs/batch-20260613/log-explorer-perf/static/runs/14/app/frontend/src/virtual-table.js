// Virtualized log table.
//
// Design (Decision 3 + 4):
//  - The scroll container holds a `spacer` sized to total * ROW_H, establishing
//    a real scrollbar for the full (filtered) corpus without materializing rows.
//  - Only rows intersecting the viewport (+ overscan) exist in the DOM. Row
//    elements are pooled and recycled by index rather than created/destroyed.
//  - Data is fetched window-by-window from the server (limit <= WINDOW). A small
//    cache holds recently fetched windows so scrolling doesn't refetch instantly.
//  - Requests are keyed by a monotonically increasing token; only the newest
//    response is applied, so out-of-order responses never overwrite newer data.

import { fetchLogs } from './api.js';

const ROW_H = 28; // must match --row-h in styles.css
const OVERSCAN = 12; // extra rows above/below the viewport
const WINDOW = 200; // server page size (== MAX_LIMIT); windows align to this

const SEV_LABEL = { debug: 'debug', info: 'info', warn: 'warn', error: 'error' };

export class VirtualTable {
  constructor({ scroller, spacer, viewport, onCount }) {
    this.scroller = scroller;
    this.spacer = spacer;
    this.viewport = viewport;
    this.onCount = onCount || (() => {});

    this.total = 0;
    this.filter = { severity: '', q: '' };

    // Fetched windows: Map<windowIndex, rows[]>.
    this.windows = new Map();
    // In-flight window fetches: Map<windowIndex, AbortController>.
    this.inflight = new Map();
    // Row element pool: Map<rowIndex, HTMLElement> for currently mounted rows.
    this.mounted = new Map();

    // Monotonic token so a filter change invalidates all older responses.
    this.epoch = 0;

    this._onScroll = this._onScroll.bind(this);
    this.scroller.addEventListener('scroll', this._onScroll, { passive: true });
    window.addEventListener('resize', () => this.render());
  }

  /**
   * Apply a new filter + known total. Resets scroll and cached windows.
   */
  setFilter({ severity, q, total }) {
    this.filter = { severity: severity || '', q: q || '' };
    this.total = total;
    this.epoch++;
    this._cancelAllInflight();
    this.windows.clear();
    this._clearMounted();
    this.scroller.scrollTop = 0;
    this.spacer.style.height = `${this.total * ROW_H}px`;
    this._emitCount();
    this.render();
  }

  /**
   * Update the total for the current filter (e.g. after a refresh) without
   * resetting scroll.
   */
  setTotal(total) {
    this.total = total;
    this.spacer.style.height = `${this.total * ROW_H}px`;
    this._emitCount();
    this.render();
  }

  _onScroll() {
    // rAF-batch to avoid doing work more than once per frame.
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = null;
      this.render();
    });
  }

  /**
   * Compute the visible row range, ensure the needed windows are fetched, and
   * (re)position the pooled row elements.
   */
  render() {
    const viewH = this.scroller.clientHeight;
    const scrollTop = this.scroller.scrollTop;

    let first = Math.floor(scrollTop / ROW_H) - OVERSCAN;
    let last = Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN;
    first = Math.max(0, first);
    last = Math.min(this.total - 1, last);

    if (this.total === 0) {
      this._clearMounted();
      return;
    }

    // Determine which windows cover [first, last] and request any missing ones.
    const firstWin = Math.floor(first / WINDOW);
    const lastWin = Math.floor(last / WINDOW);
    for (let w = firstWin; w <= lastWin; w++) {
      if (!this.windows.has(w) && !this.inflight.has(w)) {
        this._fetchWindow(w);
      }
    }

    // Recycle rows: unmount those now out of range.
    for (const [idx, el] of this.mounted) {
      if (idx < first || idx > last) {
        this._pool(el);
        this.mounted.delete(idx);
      }
    }

    // Mount/position rows in range.
    for (let idx = first; idx <= last; idx++) {
      let el = this.mounted.get(idx);
      if (!el) {
        el = this._acquire();
        this.mounted.set(idx, el);
      }
      el.style.transform = `translateY(${idx * ROW_H}px)`;
      this._fill(el, idx);
    }
  }

  _fill(el, idx) {
    const w = Math.floor(idx / WINDOW);
    const rows = this.windows.get(w);
    if (!rows) {
      el.className = 'log-row loading-row';
      el.innerHTML = '<span class="col col-ts">…</span><span class="col"></span><span class="col"></span><span class="col col-msg">loading…</span>';
      el.dataset.loaded = '';
      return;
    }
    const row = rows[idx - w * WINDOW];
    if (!row) {
      // Beyond fetched rows within a partial last window.
      el.className = 'log-row loading-row';
      el.innerHTML = '';
      return;
    }
    if (el.dataset.loaded === String(row.id)) return; // already correct
    el.dataset.loaded = String(row.id);
    el.className = 'log-row';
    el.innerHTML =
      `<span class="col col-ts">${formatTs(row.ts)}</span>` +
      `<span class="col col-sev"><span class="sev-badge sev-${row.severity}">${SEV_LABEL[row.severity]}</span></span>` +
      `<span class="col col-svc">${escapeHtml(row.service)}</span>` +
      `<span class="col col-msg">${escapeHtml(row.message)}</span>`;
  }

  async _fetchWindow(w) {
    const controller = new AbortController();
    this.inflight.set(w, controller);
    const epochAtRequest = this.epoch;
    try {
      const { total, rows } = await fetchLogs(
        {
          offset: w * WINDOW,
          limit: WINDOW,
          severity: this.filter.severity,
          q: this.filter.q,
        },
        controller.signal
      );
      // Stale-guard: a newer filter (epoch bump) invalidates this response.
      if (epochAtRequest !== this.epoch) return;

      // Keep total authoritative from the server.
      if (total !== this.total) this.setTotal(total);

      this.windows.set(w, rows);
      this._pruneCache(w);
      // Repaint any mounted rows within this window.
      this.render();
    } catch (err) {
      if (err.name === 'AbortError') return; // expected on filter change
      // eslint-disable-next-line no-console
      console.error('[virtual-table] window fetch failed', w, err);
    } finally {
      this.inflight.delete(w);
    }
  }

  // Keep only windows near the most recently requested one to bound memory.
  _pruneCache(centerWin) {
    const KEEP = 6;
    if (this.windows.size <= KEEP) return;
    for (const w of this.windows.keys()) {
      if (Math.abs(w - centerWin) > KEEP) this.windows.delete(w);
    }
  }

  _cancelAllInflight() {
    for (const c of this.inflight.values()) c.abort();
    this.inflight.clear();
  }

  _acquire() {
    let el = this._freePool && this._freePool.pop();
    if (!el) {
      el = document.createElement('div');
      el.className = 'log-row';
    }
    this.viewport.appendChild(el);
    return el;
  }

  _pool(el) {
    if (!this._freePool) this._freePool = [];
    el.remove();
    el.dataset.loaded = '';
    this._freePool.push(el);
  }

  _clearMounted() {
    for (const [, el] of this.mounted) el.remove();
    this.mounted.clear();
  }

  _emitCount() {
    this.onCount(this.total);
  }
}

function formatTs(iso) {
  // Compact, sortable-looking display: YYYY-MM-DD HH:MM:SS
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
