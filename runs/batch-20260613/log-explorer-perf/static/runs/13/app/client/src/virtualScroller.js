import { fetchLogs } from './api.js';

const ROW_HEIGHT = 28;
const PAGE_SIZE = 200; // matches server cap; one fetch = one page
const OVERSCAN_ROWS = 10; // rows above/below the viewport kept in the DOM

/**
 * A virtualized, windowed log table.
 *
 * Design:
 *  - Total scroll height = filteredTotal * ROW_HEIGHT (a spacer element).
 *  - Only the rows intersecting the viewport (+ overscan) exist as DOM nodes.
 *    DOM row nodes are pooled/recycled, never grown beyond what a viewport needs.
 *  - Data is fetched in fixed PAGE_SIZE windows and cached by page index.
 *    The visible slice is assembled from whatever pages are resident; missing
 *    pages are fetched (with stale-request cancellation) and rendered on arrival.
 */
export class VirtualScroller {
  constructor({ scroller, rowsEl, spacerEl, onCount }) {
    this.scroller = scroller;
    this.rowsEl = rowsEl;
    this.spacerEl = spacerEl;
    this.onCount = onCount;

    this.total = 0;
    this.filter = { severity: '', q: '' };

    // page index -> array of row objects
    this.pages = new Map();
    // page index -> AbortController for an in-flight fetch
    this.inflight = new Map();
    // Monotonic token: filter changes bump this so late responses for an old
    // filter can be discarded.
    this.filterToken = 0;

    // Pool of reusable DOM row elements.
    this.pool = [];

    this._onScroll = this._onScroll.bind(this);
    this.scroller.addEventListener('scroll', this._onScroll, { passive: true });
    window.addEventListener('resize', () => this._render());
  }

  /** Apply a new filter: reset scroll, clear caches, refetch. */
  async setFilter(filter) {
    this.filter = { severity: filter.severity || '', q: filter.q || '' };
    this.filterToken += 1;
    // cancel all in-flight
    for (const ctrl of this.inflight.values()) ctrl.abort();
    this.inflight.clear();
    this.pages.clear();
    this.scroller.scrollTop = 0;

    await this._loadTotalAndFirstPage();
  }

  async _loadTotalAndFirstPage() {
    const token = this.filterToken;
    const ctrl = new AbortController();
    try {
      const { total, rows } = await fetchLogs({
        offset: 0,
        limit: PAGE_SIZE,
        severity: this.filter.severity,
        q: this.filter.q,
        signal: ctrl.signal,
      });
      if (token !== this.filterToken) return; // stale
      this.total = total;
      this.pages.set(0, rows);
      this._updateSpacer();
      this._emitCount();
      this._render();
    } catch (err) {
      if (err.name === 'AbortError') return;
      // eslint-disable-next-line no-console
      console.error('load failed', err);
    }
  }

  _updateSpacer() {
    this.spacerEl.style.height = `${this.total * ROW_HEIGHT}px`;
  }

  _emitCount() {
    if (this.onCount) this.onCount(this.total);
  }

  _visibleRange() {
    const scrollTop = this.scroller.scrollTop;
    const viewportH = this.scroller.clientHeight;
    let first = Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN_ROWS;
    let count = Math.ceil(viewportH / ROW_HEIGHT) + OVERSCAN_ROWS * 2;
    first = Math.max(0, first);
    let last = Math.min(this.total, first + count);
    return { first, last };
  }

  _pagesForRange(first, last) {
    if (last <= first) return [];
    const startPage = Math.floor(first / PAGE_SIZE);
    const endPage = Math.floor((last - 1) / PAGE_SIZE);
    const out = [];
    for (let p = startPage; p <= endPage; p++) out.push(p);
    return out;
  }

  _ensurePages(pageIndices) {
    for (const p of pageIndices) {
      if (this.pages.has(p) || this.inflight.has(p)) continue;
      this._fetchPage(p);
    }
  }

  _fetchPage(pageIndex) {
    const token = this.filterToken;
    const ctrl = new AbortController();
    this.inflight.set(pageIndex, ctrl);
    fetchLogs({
      offset: pageIndex * PAGE_SIZE,
      limit: PAGE_SIZE,
      severity: this.filter.severity,
      q: this.filter.q,
      signal: ctrl.signal,
    })
      .then(({ rows }) => {
        this.inflight.delete(pageIndex);
        if (token !== this.filterToken) return; // stale filter
        this.pages.set(pageIndex, rows);
        // Only re-render if this page is still relevant to the viewport.
        const { first, last } = this._visibleRange();
        if (this._pagesForRange(first, last).includes(pageIndex)) {
          this._render();
        }
      })
      .catch((err) => {
        this.inflight.delete(pageIndex);
        if (err.name === 'AbortError') return;
        // eslint-disable-next-line no-console
        console.error('page fetch failed', err);
      });
  }

  _getRow(globalIndex) {
    const pageIndex = Math.floor(globalIndex / PAGE_SIZE);
    const page = this.pages.get(pageIndex);
    if (!page) return null;
    return page[globalIndex - pageIndex * PAGE_SIZE] || null;
  }

  _onScroll() {
    this._render();
  }

  _render() {
    const { first, last } = this._visibleRange();
    const needed = this._pagesForRange(first, last);
    this._ensurePages(needed);
    // Prefetch adjacent pages for smoother scrolling.
    if (needed.length) {
      const prefetch = [needed[0] - 1, needed[needed.length - 1] + 1].filter(
        (p) => p >= 0 && p * PAGE_SIZE < this.total
      );
      this._ensurePages(prefetch);
    }

    const visibleCount = last - first;
    // Grow the pool to the needed size; never shrink (bounded by viewport).
    while (this.pool.length < visibleCount) {
      const el = this._createRowEl();
      this.pool.push(el);
      this.rowsEl.appendChild(el);
    }
    // Hide extra pooled rows.
    for (let i = 0; i < this.pool.length; i++) {
      const el = this.pool[i];
      if (i < visibleCount) {
        const globalIndex = first + i;
        this._paintRow(el, globalIndex);
        el.style.display = '';
        el.style.transform = `translateY(${globalIndex * ROW_HEIGHT}px)`;
      } else {
        el.style.display = 'none';
      }
    }
  }

  _createRowEl() {
    const el = document.createElement('div');
    el.className = 'row log-row';
    el.style.position = 'absolute';
    el.style.left = '0';
    el.style.right = '0';
    el.style.top = '0';
    el.innerHTML =
      '<span class="c-ts"></span><span class="c-sev"></span>' +
      '<span class="c-svc"></span><span class="c-msg"></span>';
    return el;
  }

  _paintRow(el, globalIndex) {
    const row = this._getRow(globalIndex);
    const [ts, sev, svc, msg] = el.children;
    if (!row) {
      el.classList.add('loading');
      sev.className = 'c-sev';
      ts.textContent = '…';
      sev.textContent = '';
      svc.textContent = '';
      msg.textContent = '';
      return;
    }
    el.classList.remove('loading');
    ts.textContent = formatTs(row.ts);
    sev.textContent = row.severity;
    sev.className = `c-sev sev-${row.severity}`;
    svc.textContent = row.service;
    msg.textContent = row.message;
  }
}

function formatTs(iso) {
  // Compact ISO-ish display: 2024-01-05 12:34:56
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}
