/**
 * VirtualScroller
 *
 * Manages a fixed-height scroll container where only the visible rows
 * (plus overscan) exist in the DOM. The total scroll height is set via
 * a spacer element so the scrollbar reflects the full corpus size.
 *
 * Layout:
 *   .virtual-scroll-container  (overflow-y: scroll, fixed height)
 *     .virtual-scroll-spacer   (height = total * ROW_HEIGHT, sets scroll range)
 *     .virtual-rows            (position: absolute, top = windowStart * ROW_HEIGHT)
 *
 * On scroll:
 *   1. Compute which row offset is at the top of the viewport.
 *   2. Fetch that window from the server (with overscan).
 *   3. Position .virtual-rows at the correct pixel offset.
 *   4. Render only the fetched rows, recycling DOM elements.
 */

const ROW_HEIGHT = 36;   // px — must match CSS --row-height
const OVERSCAN = 8;      // extra rows above/below viewport
const FETCH_LIMIT = 100; // rows per API request (well under 200 cap)

export class VirtualScroller {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.container   - The scrollable container
   * @param {HTMLElement} opts.spacer      - The tall spacer div (sets scroll height)
   * @param {HTMLElement} opts.rowsEl      - The absolutely-positioned rows container
   * @param {Function}    opts.fetchWindow - async (offset, limit, signal) => { total, rows }
   * @param {Function}    opts.renderRow   - (el, rowData, rowIndex) => void
   * @param {Function}    [opts.onStatus]  - (msg) => void
   */
  constructor({ container, spacer, rowsEl, fetchWindow, renderRow, onStatus }) {
    this.container = container;
    this.spacer = spacer;
    this.rowsEl = rowsEl;
    this.fetchWindow = fetchWindow;
    this.renderRow = renderRow;
    this.onStatus = onStatus || (() => {});

    this.total = 0;

    // Abort controller for in-flight fetch
    this._abortCtrl = null;

    // Pending scroll RAF handle
    this._rafId = null;

    // Sequence counter to discard stale responses
    this._seq = 0;

    // Pool of recycled row elements
    this._rowPool = [];

    this._onScroll = this._onScroll.bind(this);
    this.container.addEventListener('scroll', this._onScroll, { passive: true });
  }

  /**
   * Reset to a new total (e.g. after filter change).
   * Scrolls back to top and triggers a fresh fetch.
   */
  reset(total) {
    this.total = total;

    // Cancel any in-flight request
    if (this._abortCtrl) {
      this._abortCtrl.abort();
      this._abortCtrl = null;
    }
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }

    // Update spacer height to set total scroll range
    this.spacer.style.height = `${total * ROW_HEIGHT}px`;

    // Scroll to top without triggering our handler
    this.container.removeEventListener('scroll', this._onScroll);
    this.container.scrollTop = 0;
    this.container.addEventListener('scroll', this._onScroll, { passive: true });

    // Clear rows
    this._clearRows();

    if (total > 0) {
      this._fetchAndRender(0);
    }
  }

  _onScroll() {
    // Coalesce rapid scroll events into one RAF
    if (this._rafId) return;
    this._rafId = requestAnimationFrame(() => {
      this._rafId = null;
      const scrollTop = this.container.scrollTop;
      const firstRow = Math.floor(scrollTop / ROW_HEIGHT);
      this._fetchAndRender(firstRow);
    });
  }

  _computeWindow(firstVisibleRow) {
    const containerHeight = this.container.clientHeight || 600;
    const visibleRows = Math.ceil(containerHeight / ROW_HEIGHT);

    const start = Math.max(0, firstVisibleRow - OVERSCAN);
    const end = Math.min(this.total - 1, firstVisibleRow + visibleRows + OVERSCAN);
    const count = Math.max(0, end - start + 1);

    return { start, count: Math.min(count, FETCH_LIMIT) };
  }

  async _fetchAndRender(firstVisibleRow) {
    if (this.total === 0) {
      this._clearRows();
      return;
    }

    const { start, count } = this._computeWindow(firstVisibleRow);
    if (count === 0) return;

    // Abort any in-flight request
    if (this._abortCtrl) {
      this._abortCtrl.abort();
    }
    this._abortCtrl = new AbortController();
    const seq = ++this._seq;

    try {
      const { rows } = await this.fetchWindow(start, count, this._abortCtrl.signal);

      // Discard stale responses
      if (seq !== this._seq) return;

      this._renderRows(start, rows);
    } catch (err) {
      if (err.name === 'AbortError') return;
      if (seq !== this._seq) return;
      console.error('[VirtualScroller] fetch error:', err);
      this.onStatus(`Error: ${err.message}`);
    }
  }

  _renderRows(windowStart, rows) {
    // Position the rows container at the correct pixel offset
    this.rowsEl.style.top = `${windowStart * ROW_HEIGHT}px`;

    const existingEls = Array.from(this.rowsEl.children);
    const needed = rows.length;

    // Remove excess elements back to pool
    for (let i = existingEls.length - 1; i >= needed; i--) {
      const el = existingEls[i];
      this.rowsEl.removeChild(el);
      this._rowPool.push(el);
    }

    // Reuse or create elements
    for (let i = 0; i < needed; i++) {
      let el;
      if (i < existingEls.length) {
        // Reuse existing
        el = existingEls[i];
      } else if (this._rowPool.length > 0) {
        // Reuse from pool
        el = this._rowPool.pop();
        this.rowsEl.appendChild(el);
      } else {
        // Create new
        el = document.createElement('div');
        this.rowsEl.appendChild(el);
      }

      this.renderRow(el, rows[i], windowStart + i);
    }
  }

  _clearRows() {
    while (this.rowsEl.firstChild) {
      const el = this.rowsEl.firstChild;
      this.rowsEl.removeChild(el);
      this._rowPool.push(el);
    }
    this.rowsEl.style.top = '0px';
  }

  destroy() {
    this.container.removeEventListener('scroll', this._onScroll);
    if (this._abortCtrl) this._abortCtrl.abort();
    if (this._rafId) cancelAnimationFrame(this._rafId);
  }
}
