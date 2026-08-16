/**
 * VirtualScroller
 *
 * Manages a fixed-height virtual list backed by server-side windowed data.
 *
 * Architecture:
 *  - scroller-inner height = total * ROW_HEIGHT  (creates the scrollbar)
 *  - rows-viewport is absolutely positioned and translated to the render offset
 *  - Only VISIBLE_ROWS + 2*OVERSCAN rows exist in the DOM at any time
 *  - On scroll, we compute which row offset is at the top of the viewport,
 *    fetch that window from the server, and update the DOM rows in place
 *
 * Window alignment:
 *  - Fetch windows are aligned to FETCH_SIZE boundaries so that small scrolls
 *    within the same window reuse cached data without a new request.
 *  - When the visible region spans two aligned windows, we fetch the window
 *    containing the top visible row (the primary window). The secondary window
 *    is fetched lazily on the next scroll event.
 *
 * Stale response prevention:
 *  - Each fetch is tagged with a monotonically increasing sequence number.
 *  - Responses with a sequence number less than the current are discarded.
 *  - In-flight requests are aborted when a newer request is issued.
 */

import { fetchLogs } from './api.js';

const ROW_HEIGHT  = 36;   // px — must match CSS --row-height
const OVERSCAN    = 8;    // extra rows above/below viewport
const FETCH_SIZE  = 150;  // rows per API request (≤ 200 cap)
const SCROLL_DEBOUNCE_MS = 60; // ms to debounce scroll events

export class VirtualScroller {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.container   - the scrollable container
   * @param {HTMLElement} opts.inner       - the tall inner div (sets scroll height)
   * @param {HTMLElement} opts.viewport    - the absolutely-positioned row container
   * @param {function}    opts.onStatus    - callback(string) for status bar updates
   * @param {function}    opts.onRowCount  - callback(rendered, total) for header count
   */
  constructor({ container, inner, viewport, onStatus, onRowCount }) {
    this.container  = container;
    this.inner      = inner;
    this.viewport   = viewport;
    this.onStatus   = onStatus   || (() => {});
    this.onRowCount = onRowCount || (() => {});

    // Current filter state
    this.severity = '';
    this.q        = '';

    // Current data state
    this.total        = 0;
    this.windowOffset = -1;   // offset of the first row in the cached window (-1 = empty)
    this.windowRows   = [];   // cached rows from last successful fetch

    // Inflight request management
    this._fetchController = null;
    this._fetchSeq        = 0;  // monotonically increasing; responses with lower seq are dropped

    // Scroll debounce
    this._scrollTimer = null;

    // DOM row pool (recycled)
    this._domRows = [];

    this._bindScroll();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Apply new filters and reset scroll to top.
   * Returns a promise that resolves when the first window is loaded.
   */
  async setFilters({ severity = '', q = '' } = {}) {
    this.severity     = severity;
    this.q            = q;
    this.windowOffset = -1;
    this.windowRows   = [];
    this.total        = 0;

    // Reset scroll position synchronously before fetching
    this.container.scrollTop = 0;

    // Clear existing DOM rows
    this._clearViewport();

    // Update scroll height to 0 while loading
    this.inner.style.height = '0px';

    await this._fetchWindow(0);
  }

  // -------------------------------------------------------------------------
  // Scroll handling
  // -------------------------------------------------------------------------

  _bindScroll() {
    this.container.addEventListener('scroll', () => {
      if (this._scrollTimer !== null) clearTimeout(this._scrollTimer);
      this._scrollTimer = setTimeout(() => {
        this._scrollTimer = null;
        this._onScroll();
      }, SCROLL_DEBOUNCE_MS);
    }, { passive: true });
  }

  _onScroll() {
    const scrollTop    = this.container.scrollTop;
    const topRowOffset = Math.floor(scrollTop / ROW_HEIGHT);
    const clampedOffset = Math.max(0, Math.min(topRowOffset, Math.max(0, this.total - 1)));

    // Determine the aligned fetch window for this position.
    // We align to FETCH_SIZE boundaries but bias the window to start slightly
    // before the visible area so overscan rows above the viewport are covered.
    const windowStart = Math.max(0, clampedOffset - OVERSCAN);
    const fetchOffset = Math.floor(windowStart / FETCH_SIZE) * FETCH_SIZE;

    if (fetchOffset !== this.windowOffset) {
      // Need new data — fetch and then render
      this._fetchWindow(fetchOffset);
    } else {
      // Data already cached — just re-render
      this._renderRows(clampedOffset);
    }
  }

  // -------------------------------------------------------------------------
  // Fetch
  // -------------------------------------------------------------------------

  async _fetchWindow(fetchOffset) {
    // Abort any in-flight request
    if (this._fetchController) {
      this._fetchController.abort();
    }
    this._fetchController = new AbortController();
    const seq    = ++this._fetchSeq;
    const signal = this._fetchController.signal;

    this._setSpinner(true);

    try {
      const result = await fetchLogs({
        offset:   fetchOffset,
        limit:    FETCH_SIZE,
        severity: this.severity,
        q:        this.q,
        signal,
      });

      // Discard stale responses
      if (seq !== this._fetchSeq) return;

      this.total        = result.total;
      this.windowOffset = fetchOffset;
      this.windowRows   = result.rows;

      // Update scroll height to reflect new total
      this._updateScrollHeight();

      // Render at the current scroll position
      const scrollTop    = this.container.scrollTop;
      const topRowOffset = Math.floor(scrollTop / ROW_HEIGHT);
      this._renderRows(topRowOffset);

      const from = fetchOffset + 1;
      const to   = fetchOffset + result.rows.length;
      this.onStatus(
        `Rows ${from.toLocaleString()}–${to.toLocaleString()} of ${result.total.toLocaleString()} total`
      );
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.error('[VirtualScroller] fetch error:', err);
      this.onStatus(`Error loading rows: ${err.message}`);
    } finally {
      if (seq === this._fetchSeq) {
        this._setSpinner(false);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  _renderRows(topRowOffset) {
    if (this.total === 0) {
      this._clearViewport();
      this._showEmptyState();
      this.onRowCount(0, 0);
      return;
    }

    const containerHeight = this.container.clientHeight || 600;
    const visibleCount    = Math.ceil(containerHeight / ROW_HEIGHT);

    // Compute render range with overscan
    const renderStart = Math.max(0, topRowOffset - OVERSCAN);
    const renderEnd   = Math.min(this.total - 1, topRowOffset + visibleCount + OVERSCAN);
    const renderCount = renderEnd - renderStart + 1;

    // Position the viewport div at the render start
    this.viewport.style.transform = `translateY(${renderStart * ROW_HEIGHT}px)`;

    // Ensure we have enough DOM row elements (grow pool as needed, never shrink)
    this._ensureDomRows(renderCount);

    // Hide excess rows from a previous larger render
    for (let i = renderCount; i < this._domRows.length; i++) {
      this._domRows[i].style.display = 'none';
    }

    // Fill rows from the cached window
    for (let i = 0; i < renderCount; i++) {
      const absoluteIdx = renderStart + i;
      const windowIdx   = absoluteIdx - this.windowOffset;

      const domRow = this._domRows[i];
      domRow.style.display = '';

      if (this.windowOffset >= 0 && windowIdx >= 0 && windowIdx < this.windowRows.length) {
        this._fillRow(domRow, this.windowRows[windowIdx]);
      } else {
        // Row is outside the cached window — show placeholder
        // (a new fetch will have been triggered by _onScroll)
        this._fillRowPlaceholder(domRow);
      }
    }

    this.onRowCount(renderCount, this.total);
  }

  // -------------------------------------------------------------------------
  // DOM row pool
  // -------------------------------------------------------------------------

  _ensureDomRows(count) {
    while (this._domRows.length < count) {
      const row = this._createDomRow();
      this.viewport.appendChild(row);
      this._domRows.push(row);
    }
  }

  _createDomRow() {
    const row = document.createElement('div');
    row.className = 'log-row';
    // Pre-create child elements for fast updates
    const ts  = document.createElement('div');
    ts.className = 'col col-ts';
    const sev = document.createElement('div');
    sev.className = 'col col-severity';
    const svc = document.createElement('div');
    svc.className = 'col col-service';
    const msg = document.createElement('div');
    msg.className = 'col col-message';
    row.appendChild(ts);
    row.appendChild(sev);
    row.appendChild(svc);
    row.appendChild(msg);
    return row;
  }

  _fillRow(domRow, data) {
    const [tsEl, sevEl, svcEl, msgEl] = domRow.children;
    tsEl.textContent  = formatTs(data.ts);
    sevEl.textContent = data.severity;
    sevEl.className   = `col col-severity sev-${data.severity}`;
    svcEl.textContent = data.service;
    msgEl.textContent = data.message;
  }

  _fillRowPlaceholder(domRow) {
    const [tsEl, sevEl, svcEl, msgEl] = domRow.children;
    tsEl.textContent  = '…';
    sevEl.textContent = '';
    sevEl.className   = 'col col-severity';
    svcEl.textContent = '';
    msgEl.textContent = 'Loading…';
  }

  _clearViewport() {
    // Hide all DOM rows
    for (const row of this._domRows) {
      row.style.display = 'none';
    }
    // Remove any empty-state element
    const empty = this.viewport.querySelector('.empty-state');
    if (empty) empty.remove();
  }

  _showEmptyState() {
    if (!this.viewport.querySelector('.empty-state')) {
      const el = document.createElement('div');
      el.className = 'empty-state';
      el.textContent = 'No log entries match the current filters.';
      this.viewport.appendChild(el);
    }
    this.viewport.style.transform = 'translateY(0)';
  }

  // -------------------------------------------------------------------------
  // Scroll height
  // -------------------------------------------------------------------------

  _updateScrollHeight() {
    const totalHeight = Math.max(0, this.total) * ROW_HEIGHT;
    this.inner.style.height = `${totalHeight}px`;
  }

  // -------------------------------------------------------------------------
  // Spinner
  // -------------------------------------------------------------------------

  _setSpinner(active) {
    const spinner = document.getElementById('search-spinner');
    if (spinner) spinner.classList.toggle('active', active);
  }
}

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

/**
 * Format an ISO timestamp string to "YYYY-MM-DD HH:mm:ss" without creating a Date object.
 */
function formatTs(isoString) {
  if (!isoString) return '';
  // ISO format: "2024-01-31T12:34:56.789Z" or "2024-01-31T12:34:56+00:00"
  // We want: "2024-01-31 12:34:56"
  try {
    // Replace T with space, strip fractional seconds and timezone
    return isoString.slice(0, 10) + ' ' + isoString.slice(11, 19);
  } catch {
    return isoString;
  }
}
