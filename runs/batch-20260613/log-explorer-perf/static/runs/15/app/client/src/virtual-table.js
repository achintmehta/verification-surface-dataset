import { fetchLogs } from './api.js';

const ROW_HEIGHT = 28; // px, fixed row height for simple offset math
const OVERSCAN = 12; // rows above/below viewport
const PAGE_LIMIT = 200; // server cap; we fetch windows of this size
const MAX_SCROLL_HEIGHT = 15_000_000; // browser-safe max spacer height

/**
 * VirtualTable: renders only the rows intersecting the viewport (plus
 * overscan). Total scroll height reflects the filtered `total`. Row windows
 * are fetched on demand and cached briefly; stale (out-of-order / cancelled)
 * responses never overwrite newer state.
 */
export class VirtualTable {
  constructor({ viewport, spacer, rowsEl, emptyEl, onCount }) {
    this.viewport = viewport;
    this.spacer = spacer;
    this.rowsEl = rowsEl;
    this.emptyEl = emptyEl;
    this.onCount = onCount;

    this.total = 0;
    this.severity = null;
    this.q = null;

    // Row cache keyed by absolute row index.
    this.cache = new Map();
    // Window start offsets that have completed loading (even if partial).
    this.loaded = new Set();
    // Windows currently being fetched, keyed by window start offset.
    this.inflight = new Map();
    // Monotonic token; only responses matching the current filter generation
    // are allowed to touch cache/render.
    this.generation = 0;
    // Abort controllers for in-flight fetches of the current generation.
    this.controllers = new Set();

    // scale factor when total*rowHeight exceeds browser limits.
    this.scale = 1;

    this._onScroll = this._onScroll.bind(this);
    this.viewport.addEventListener('scroll', this._onScroll, { passive: true });
    window.addEventListener('resize', () => this.render());
  }

  /** Apply a new filter set. Resets scroll, cache and total, then reloads. */
  async setFilter({ severity, q }) {
    this.severity = severity || null;
    this.q = q || null;
    return this.reload();
  }

  async reload() {
    // Invalidate everything in flight.
    this.generation += 1;
    const gen = this.generation;
    this._abortAll();
    this.cache.clear();
    this.loaded.clear();
    this.inflight.clear();

    // Reset scroll to top on filter change.
    this.viewport.scrollTop = 0;

    // Fetch the first window; its `total` sizes the scrollbar.
    let data;
    try {
      data = await this._fetchWindow(0, gen);
    } catch (err) {
      if (err.name === 'AbortError') return;
      throw err;
    }
    if (gen !== this.generation || !data) return;

    this.total = data.total;
    this._resize();
    this._updateCount();
    this.render();
  }

  _abortAll() {
    for (const c of this.controllers) c.abort();
    this.controllers.clear();
  }

  _resize() {
    const rawHeight = this.total * ROW_HEIGHT;
    if (rawHeight > MAX_SCROLL_HEIGHT) {
      this.scale = rawHeight / MAX_SCROLL_HEIGHT;
      this.spacer.style.height = `${MAX_SCROLL_HEIGHT}px`;
    } else {
      this.scale = 1;
      this.spacer.style.height = `${rawHeight}px`;
    }
    this.emptyEl.hidden = this.total !== 0;
  }

  _updateCount() {
    if (this.onCount) this.onCount(this.total, this.severity, this.q);
  }

  // Map scrollTop -> first visible row index (accounting for scaling).
  _firstVisibleRow() {
    const scrollTop = this.viewport.scrollTop * this.scale;
    return Math.floor(scrollTop / ROW_HEIGHT);
  }

  _visibleRowCount() {
    return Math.ceil(this.viewport.clientHeight / ROW_HEIGHT);
  }

  _onScroll() {
    // rAF-throttle to keep scrolling smooth.
    if (this._rafPending) return;
    this._rafPending = true;
    requestAnimationFrame(() => {
      this._rafPending = false;
      this.render();
    });
  }

  async _fetchWindow(windowStart, gen) {
    if (this.inflight.has(windowStart)) {
      return this.inflight.get(windowStart);
    }
    const controller = new AbortController();
    this.controllers.add(controller);
    const p = (async () => {
      try {
        const data = await fetchLogs({
          offset: windowStart,
          limit: PAGE_LIMIT,
          severity: this.severity,
          q: this.q,
          signal: controller.signal,
        });
        if (gen !== this.generation) return null;
        // Populate cache.
        data.rows.forEach((row, i) => {
          this.cache.set(windowStart + i, row);
        });
        this.loaded.add(windowStart);
        return data;
      } finally {
        this.controllers.delete(controller);
        this.inflight.delete(windowStart);
      }
    })();
    this.inflight.set(windowStart, p);
    return p;
  }

  _ensureWindowFor(rowIndex) {
    const windowStart = Math.floor(rowIndex / PAGE_LIMIT) * PAGE_LIMIT;
    if (this.loaded.has(windowStart) || this.inflight.has(windowStart)) return;
    const gen = this.generation;
    this._fetchWindow(windowStart, gen)
      .then((data) => {
        if (data && gen === this.generation) this.render();
      })
      .catch((err) => {
        if (err.name !== 'AbortError') console.error(err);
      });
  }

  render() {
    if (this.total === 0) {
      this.rowsEl.innerHTML = '';
      return;
    }
    const first = Math.max(0, this._firstVisibleRow() - OVERSCAN);
    const visible = this._visibleRowCount();
    const last = Math.min(this.total - 1, first + visible + OVERSCAN * 2);

    // Ensure every data window covering [first, last] is fetched.
    const firstWin = Math.floor(first / PAGE_LIMIT) * PAGE_LIMIT;
    const lastWin = Math.floor(last / PAGE_LIMIT) * PAGE_LIMIT;
    for (let w = firstWin; w <= lastWin; w += PAGE_LIMIT) {
      this._ensureWindowFor(w);
    }

    // Build the visible rows. Position rows absolutely inside the spacer.
    const frag = document.createDocumentFragment();
    for (let i = first; i <= last; i++) {
      const row = this.cache.get(i);
      const el = this._renderRow(i, row);
      frag.appendChild(el);
    }
    this.rowsEl.replaceChildren(frag);
  }

  _rowTop(i) {
    // When scaled, place rows relative to the current scroll offset so the
    // visible window aligns even though absolute geometry is compressed.
    if (this.scale === 1) return i * ROW_HEIGHT;
    // Position visible rows relative to the (unscaled) first visible row,
    // then add the actual scrollTop so they sit under the viewport.
    const firstVisible = this._firstVisibleRow();
    return this.viewport.scrollTop + (i - firstVisible) * ROW_HEIGHT;
  }

  _renderRow(i, row) {
    const el = document.createElement('div');
    el.className = 'log-row';
    el.style.top = `${this._rowTop(i)}px`;
    el.style.height = `${ROW_HEIGHT}px`;
    if (!row) {
      el.classList.add('loading');
      el.innerHTML = `<span class="cell idx">#${i}</span><span class="cell msg">…</span>`;
      return el;
    }
    const ts = new Date(row.ts).toISOString().replace('T', ' ').replace('.000Z', 'Z');
    el.innerHTML = `
      <span class="cell idx">${i}</span>
      <span class="cell ts">${ts}</span>
      <span class="cell sev sev-${row.severity}">${row.severity}</span>
      <span class="cell svc">${escapeHtml(row.service)}</span>
      <span class="cell msg">${escapeHtml(row.message)}</span>
    `;
    return el;
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
