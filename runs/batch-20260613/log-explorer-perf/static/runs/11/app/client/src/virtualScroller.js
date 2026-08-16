// Virtualized log table.
//
// Design:
//  - Fixed row height. Total scroll height = total * ROW_HEIGHT, applied to a
//    spacer element so the native scrollbar reflects the whole (filtered)
//    corpus without any rows existing off-screen.
//  - Only rows intersecting the viewport (plus a small overscan) exist in the
//    DOM. They are absolutely positioned inside the spacer at
//    `index * ROW_HEIGHT`.
//  - Rows are fetched from the server in fixed-size pages and cached by page
//    index. A monotonically increasing request token discards out-of-order /
//    stale responses so a slow older window never overwrites a newer one.
//  - Changing filters bumps a generation counter that invalidates the cache
//    and cancels in-flight requests.

const ROW_HEIGHT = 28; // px, must match CSS .log-row height
const OVERSCAN = 12; // extra rows above/below the viewport
const PAGE_SIZE = 200; // server cap; one fetch fills up to 200 rows

const SEVERITY_ORDER = { debug: 0, info: 1, warn: 2, error: 3 };

export class VirtualScroller {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.viewport   scroll container
   * @param {HTMLElement} opts.spacer     full-height inner element
   * @param {HTMLElement} opts.rowsEl     container for materialized rows
   * @param {(args:{offset:number,limit:number,severity?:string,q?:string,signal:AbortSignal})=>Promise<{total:number,rows:Array}>} opts.fetchPage
   * @param {(visible:number,total:number)=>void} [opts.onCounts]
   * @param {(msg:string)=>void} [opts.onStatus]
   */
  constructor({ viewport, spacer, rowsEl, fetchPage, onCounts, onStatus }) {
    this.viewport = viewport;
    this.spacer = spacer;
    this.rowsEl = rowsEl;
    this.fetchPage = fetchPage;
    this.onCounts = onCounts || (() => {});
    this.onStatus = onStatus || (() => {});

    this.filters = { severity: '', q: '' };
    this.total = 0;

    // page index -> array of rows
    this.pageCache = new Map();
    // page index -> in-flight AbortController
    this.pending = new Map();

    // Generation guards against stale responses across filter changes.
    this.generation = 0;
    // Row element pool keyed by absolute row index currently displayed.
    this.rowPool = new Map(); // index -> HTMLElement

    this._onScroll = this._onScroll.bind(this);
    this.viewport.addEventListener('scroll', this._onScroll, { passive: true });

    // Recompute on resize (viewport height changes the visible window).
    this._resizeObserver = new ResizeObserver(() => this._render());
    this._resizeObserver.observe(this.viewport);
  }

  /**
   * Apply a new filter set: reset scroll, invalidate caches, refetch total and
   * the first window. Safe to call on every keystroke (older work is cancelled).
   * @param {{severity:string, q:string}} filters
   */
  async setFilters(filters) {
    this.filters = { severity: filters.severity || '', q: filters.q || '' };
    this.generation += 1;
    const gen = this.generation;

    // Cancel everything in flight and drop cached windows.
    for (const ctrl of this.pending.values()) ctrl.abort();
    this.pending.clear();
    this.pageCache.clear();

    // Reset scroll to the top for a fresh filter.
    this.viewport.scrollTop = 0;

    // Fetch the first page to learn the exact total and show initial rows.
    try {
      const ctrl = new AbortController();
      this.onStatus('Loading…');
      const { total, rows } = await this.fetchPage({
        offset: 0,
        limit: PAGE_SIZE,
        severity: this.filters.severity || undefined,
        q: this.filters.q || undefined,
        signal: ctrl.signal,
      });
      // A newer filter change happened while we were waiting — discard.
      if (gen !== this.generation) return;

      this.total = total;
      this.pageCache.set(0, rows);
      this._applyHeight();
      this.onStatus('');
      this._render();
    } catch (err) {
      if (err.name === 'AbortError') return;
      if (gen !== this.generation) return;
      this.onStatus('Error: ' + err.message);
    }
  }

  _applyHeight() {
    this.spacer.style.height = `${this.total * ROW_HEIGHT}px`;
  }

  _onScroll() {
    // Scroll handling is cheap: compute the visible window and render. Actual
    // data fetches are async and never block the scroll/input threads.
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

  _pageOf(index) {
    return Math.floor(index / PAGE_SIZE);
  }

  _rowAt(index) {
    const page = this.pageCache.get(this._pageOf(index));
    if (!page) return undefined;
    return page[index % PAGE_SIZE];
  }

  _ensurePage(page) {
    if (this.pageCache.has(page) || this.pending.has(page)) return;

    const gen = this.generation;
    const ctrl = new AbortController();
    this.pending.set(page, ctrl);

    this.fetchPage({
      offset: page * PAGE_SIZE,
      limit: PAGE_SIZE,
      severity: this.filters.severity || undefined,
      q: this.filters.q || undefined,
      signal: ctrl.signal,
    })
      .then(({ total, rows }) => {
        this.pending.delete(page);
        // Stale response guard: a filter change bumped the generation.
        if (gen !== this.generation) return;
        // Keep total authoritative in case it shifted (shouldn't for static
        // corpus, but keeps the scrollbar exact).
        if (total !== this.total) {
          this.total = total;
          this._applyHeight();
        }
        this.pageCache.set(page, rows);
        this._render();
      })
      .catch((err) => {
        this.pending.delete(page);
        if (err.name === 'AbortError') return;
        if (gen !== this.generation) return;
        this.onStatus('Error: ' + err.message);
      });
  }

  _render() {
    const { start, end } = this._visibleRange();

    // Kick off fetches for any pages overlapping the visible range.
    if (this.total > 0) {
      const firstPage = this._pageOf(start);
      const lastPage = this._pageOf(Math.max(start, end - 1));
      for (let pg = firstPage; pg <= lastPage; pg++) this._ensurePage(pg);
    }

    // Recycle: remove pooled rows now outside the range.
    for (const [index, el] of this.rowPool) {
      if (index < start || index >= end) {
        el.remove();
        this.rowPool.delete(index);
      }
    }

    // Materialize / update rows within the range.
    for (let index = start; index < end; index++) {
      let el = this.rowPool.get(index);
      if (!el) {
        el = document.createElement('div');
        el.className = 'log-row';
        el.style.transform = `translateY(${index * ROW_HEIGHT}px)`;
        this.rowsEl.appendChild(el);
        this.rowPool.set(index, el);
      }
      this._paintRow(el, index);
    }

    // Update the "N of total" counter with what's actually visible.
    const visibleCount = Math.max(0, Math.min(end, this.total) - start);
    this.onCounts(visibleCount, this.total);
  }

  _paintRow(el, index) {
    const row = this._rowAt(index);
    if (!row) {
      // Data for this row hasn't arrived yet: show a placeholder (never blank
      // permanently — a fetch is in flight and _render will repaint on arrival).
      if (el.dataset.state !== 'loading') {
        el.dataset.state = 'loading';
        el.innerHTML = `<span class="col col-ts skeleton"></span><span class="col col-sev skeleton"></span><span class="col col-svc skeleton"></span><span class="col col-msg skeleton"></span>`;
      }
      return;
    }
    // Only repaint if this element isn't already showing this row.
    if (el.dataset.rowId === String(row.id) && el.dataset.state === 'ready') return;
    el.dataset.state = 'ready';
    el.dataset.rowId = String(row.id);

    const sev = row.severity;
    el.innerHTML =
      `<span class="col col-ts">${formatTs(row.ts)}</span>` +
      `<span class="col col-sev"><span class="sev sev-${sev}" data-order="${SEVERITY_ORDER[sev] ?? ''}">${sev}</span></span>` +
      `<span class="col col-svc">${escapeHtml(row.service)}</span>` +
      `<span class="col col-msg">${escapeHtml(row.message)}</span>`;
  }

  destroy() {
    this.viewport.removeEventListener('scroll', this._onScroll);
    this._resizeObserver.disconnect();
    for (const ctrl of this.pending.values()) ctrl.abort();
  }
}

function formatTs(iso) {
  // Compact, monospace-friendly timestamp.
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export const _internals = { ROW_HEIGHT, PAGE_SIZE, OVERSCAN };
