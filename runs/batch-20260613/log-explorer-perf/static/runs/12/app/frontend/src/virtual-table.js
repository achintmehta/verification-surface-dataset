// A virtualized, windowed log table.
//
// Responsibilities:
//  - Size a scrollbar to the full filtered `total` (rowHeight * total).
//  - Keep only the visible rows (plus small overscan) in the DOM, recycling
//    DOM nodes as the user scrolls.
//  - Fetch data window-by-window (page-aligned), cache fetched pages, and
//    cancel/ignore stale responses so newer results always win.

import { fetchLogs } from './api.js';

const ROW_HEIGHT = 28;      // must match --row-height in CSS
const OVERSCAN = 12;        // extra rows above/below the viewport
const PAGE_SIZE = 200;      // rows per server request (== MAX_LIMIT)
const MAX_CACHED_PAGES = 40;// bound cache memory

export class VirtualTable {
  constructor({ viewport, spacer, rowsLayer, emptyState, onCount }) {
    this.viewport = viewport;
    this.spacer = spacer;
    this.rowsLayer = rowsLayer;
    this.emptyState = emptyState;
    this.onCount = onCount || (() => {});

    // Current filter state.
    this.filter = { severity: '', q: '' };

    // Known total for the current filter (from the latest response).
    this.total = 0;
    // Whether we've received at least one authoritative response for the
    // current filter (so total === 0 truly means "no matches", not "unknown").
    this.totalKnown = false;

    // Page cache: pageIndex -> array of rows (length up to PAGE_SIZE).
    this.pages = new Map();
    // Track page fetch order for simple LRU eviction.
    this.pageOrder = [];
    // Pages with an in-flight fetch: pageIndex -> AbortController.
    this.inFlight = new Map();

    // Generation token: incremented whenever the filter changes. Responses
    // tagged with an older generation are discarded.
    this.generation = 0;

    // Recycled DOM row pool: index -> element currently showing that row.
    this.rowPool = new Map();

    // Bind + attach scroll handler.
    this.onScroll = this.onScroll.bind(this);
    this.viewport.addEventListener('scroll', this.onScroll, { passive: true });

    // Re-render on resize (viewport height changes visible count).
    this._resizeObserver = new ResizeObserver(() => this.render());
    this._resizeObserver.observe(this.viewport);
  }

  /**
   * Set a new filter. Resets scroll to top, clears caches, and reloads.
   */
  setFilter({ severity, q }) {
    this.filter = { severity: severity || '', q: q || '' };
    this.generation += 1;

    // Abort all in-flight requests from the previous filter.
    for (const controller of this.inFlight.values()) controller.abort();
    this.inFlight.clear();

    // Drop cached data — it belongs to the old filter.
    this.pages.clear();
    this.pageOrder = [];

    // Reset scroll and known total; we'll learn the real total from the first
    // fetched page.
    this.viewport.scrollTop = 0;
    this.total = 0;
    this.totalKnown = false;
    this.setTotalHeight(0);

    // Kick off a load for the top window.
    this.render();
  }

  setTotalHeight(total) {
    this.spacer.style.height = `${Math.max(total * ROW_HEIGHT, 1)}px`;
  }

  onScroll() {
    // Rendering is cheap and synchronous; scroll events are frequent but we
    // only touch the visible DOM window, so this stays responsive.
    this.render();
  }

  /**
   * Compute the currently visible row range (with overscan) and ensure the
   * pages covering it are fetched. Render the rows we have; recycle the rest.
   */
  render() {
    const scrollTop = this.viewport.scrollTop;
    const viewportHeight = this.viewport.clientHeight || 0;

    // When total is not yet known (right after a filter reset), we still want
    // to load the first window so we can discover the total. Assume at least a
    // screenful. Once a response has arrived, trust the real total (which may
    // legitimately be 0 for "no matches").
    const effectiveTotal = this.totalKnown
      ? this.total
      : Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN;

    let startIndex = Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN;
    let endIndex =
      Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN;

    startIndex = Math.max(0, startIndex);
    endIndex = Math.min(effectiveTotal, endIndex);

    // Ensure pages covering [startIndex, endIndex) are available.
    if (endIndex > startIndex) {
      const firstPage = Math.floor(startIndex / PAGE_SIZE);
      const lastPage = Math.floor((endIndex - 1) / PAGE_SIZE);
      for (let pg = firstPage; pg <= lastPage; pg++) {
        this.ensurePage(pg);
      }
    }

    this.paint(startIndex, endIndex);
  }

  /**
   * Ensure a given page is cached or being fetched.
   */
  ensurePage(pageIndex) {
    if (this.pages.has(pageIndex)) return;
    if (this.inFlight.has(pageIndex)) return;

    const gen = this.generation;
    const controller = new AbortController();
    this.inFlight.set(pageIndex, controller);

    fetchLogs({
      offset: pageIndex * PAGE_SIZE,
      limit: PAGE_SIZE,
      severity: this.filter.severity,
      q: this.filter.q,
      signal: controller.signal,
    })
      .then((data) => {
        // Discard stale responses (filter changed since we asked).
        if (gen !== this.generation) return;

        this.inFlight.delete(pageIndex);

        // Learn / update the authoritative total.
        const totalChanged = data.total !== this.total || !this.totalKnown;
        this.totalKnown = true;
        if (totalChanged) {
          this.total = data.total;
          this.setTotalHeight(this.total);
          // Clamp scroll if the corpus shrank below the current position.
          const maxScroll = Math.max(
            0,
            this.total * ROW_HEIGHT - this.viewport.clientHeight
          );
          if (this.viewport.scrollTop > maxScroll) {
            this.viewport.scrollTop = maxScroll;
          }
        }
        // Always report the current total (drives the "N of total" badge).
        this.onCount(this.total);

        this.cachePage(pageIndex, data.rows);
        // New data may cover the current viewport: repaint.
        this.render();
      })
      .catch((err) => {
        this.inFlight.delete(pageIndex);
        if (err.name === 'AbortError') return; // expected on filter change
        // Transient failures: allow a later scroll/render to retry.
        // eslint-disable-next-line no-console
        console.error('[virtual-table] page fetch failed', pageIndex, err);
        this.render();
      });
  }

  cachePage(pageIndex, rows) {
    this.pages.set(pageIndex, rows);
    this.pageOrder = this.pageOrder.filter((p) => p !== pageIndex);
    this.pageOrder.push(pageIndex);

    // LRU-evict pages far from the viewport to bound memory.
    while (this.pageOrder.length > MAX_CACHED_PAGES) {
      const victim = this.pageOrder.shift();
      this.pages.delete(victim);
    }
  }

  getRow(index) {
    const pageIndex = Math.floor(index / PAGE_SIZE);
    const page = this.pages.get(pageIndex);
    if (!page) return undefined;
    return page[index - pageIndex * PAGE_SIZE];
  }

  /**
   * Render rows in [startIndex, endIndex) using a recycled node pool.
   */
  paint(startIndex, endIndex) {
    const needed = new Set();
    for (let i = startIndex; i < endIndex; i++) needed.add(i);

    // Remove/recycle rows no longer visible.
    for (const [index, el] of this.rowPool) {
      if (!needed.has(index)) {
        el.remove();
        this.rowPool.delete(index);
      }
    }

    // Create/update rows in range.
    for (let i = startIndex; i < endIndex; i++) {
      const row = this.getRow(i);
      let el = this.rowPool.get(i);
      if (!el) {
        el = document.createElement('div');
        el.className = 'log-row';
        this.rowsLayer.appendChild(el);
        this.rowPool.set(i, el);
      }
      el.style.transform = `translateY(${i * ROW_HEIGHT}px)`;
      this.fillRow(el, row, i);
    }

    // Empty-state visibility: only once we truly know there are no matches.
    const isEmpty = this.totalKnown && this.total === 0;
    this.emptyState.hidden = !isEmpty;
  }

  fillRow(el, row, index) {
    if (!row) {
      // Placeholder while the page is loading — never a permanently blank
      // region because ensurePage() is triggered for the visible range.
      el.classList.add('pending');
      el.innerHTML = `
        <div class="col col-ts">…</div>
        <div class="col col-sev"></div>
        <div class="col col-svc"></div>
        <div class="col col-msg cell-msg">loading row ${index + 1}…</div>`;
      return;
    }
    el.classList.remove('pending');
    const sev = row.severity;
    el.innerHTML = `
      <div class="col col-ts">${formatTs(row.ts)}</div>
      <div class="col col-sev"><span class="sev-pill sev-${sev}">${sev}</span></div>
      <div class="col col-svc">${escapeHtml(row.service)}</div>
      <div class="col col-msg cell-msg">${escapeHtml(row.message)}</div>`;
  }
}

function formatTs(ts) {
  // ts arrives as an ISO string (Postgres timestamptz serialized to JSON).
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.` +
    `${pad(d.getUTCMilliseconds(), 3)}`
  );
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
