/**
 * VirtualScroller
 *
 * Manages a pool of DOM row elements. Only rows intersecting the viewport
 * (plus overscan) exist in the DOM. The scroll spacer sets the total
 * scrollable height; each row is absolutely positioned at its correct
 * vertical offset within the scroll container.
 *
 * Architecture:
 *  - scrollContainer: overflow-y:scroll, position:relative
 *  - spacer: position:absolute, width:1px, height = total * ROW_HEIGHT
 *  - each pool row: position:absolute, top = rowIndex * ROW_HEIGHT
 *
 * On each scroll event:
 *  1. Compute firstVisibleRow = Math.floor(scrollTop / ROW_HEIGHT)
 *  2. Compute window [renderStart, renderEnd] with overscan
 *  3. If the loaded data covers the window → render immediately
 *  4. Otherwise → fetch the window from the server, then render
 *
 * Stale-response safety: each fetch carries a monotonic sequence number;
 * responses that arrive after a newer fetch has been issued are discarded.
 */

const ROW_HEIGHT = 36;   // must match CSS --row-height
const OVERSCAN   = 8;    // extra rows above/below viewport
const FETCH_LIMIT = 100; // rows per API request (≤ server MAX_LIMIT)

export class VirtualScroller {
  /**
   * @param {Object} opts
   * @param {HTMLElement} opts.scrollContainer  - the overflow-y:scroll element
   * @param {HTMLElement} opts.spacer           - absolute element for virtual height
   * @param {HTMLElement} opts.rowsContainer    - container for pool elements (can be same as scrollContainer)
   * @param {Function}   opts.fetchWindow       - async (offset, limit, signal) => {total, rows}
   * @param {Function}   opts.renderRow         - (element, rowData, rowIndex) => void
   * @param {Function}   opts.onTotalChange     - (total) => void
   */
  constructor({ scrollContainer, spacer, rowsContainer, fetchWindow, renderRow, onTotalChange }) {
    this.scrollContainer = scrollContainer;
    this.spacer          = spacer;
    this.rowsContainer   = rowsContainer;
    this.fetchWindow     = fetchWindow;
    this.renderRow       = renderRow;
    this.onTotalChange   = onTotalChange;

    // Virtual state
    this.total        = 0;
    this.loadedOffset = 0;   // row-index of first element in this.rows
    this.rows         = [];  // currently loaded rows from server

    // DOM pool
    this.pool     = [];
    this.poolSize = 0;

    // Fetch sequencing
    this._fetchSeq      = 0;
    this._abortCtrl     = null;
    this._lastFetchOff  = -1;

    // Scroll handler (throttled via rAF)
    this._rafPending = false;
    this._scrollHandler = () => {
      if (!this._rafPending) {
        this._rafPending = true;
        requestAnimationFrame(() => {
          this._rafPending = false;
          this._onScroll();
        });
      }
    };
    this.scrollContainer.addEventListener('scroll', this._scrollHandler, { passive: true });

    // Resize observer to grow pool when viewport grows
    this._ro = new ResizeObserver(() => this._ensurePool());
    this._ro.observe(this.scrollContainer);
    this._ensurePool();
  }

  // ─── Pool management ────────────────────────────────────────────────────────

  _ensurePool() {
    const viewportH  = this.scrollContainer.clientHeight || 600;
    const visibleRows = Math.ceil(viewportH / ROW_HEIGHT);
    const needed     = visibleRows + OVERSCAN * 2 + 4;

    while (this.pool.length < needed) {
      const el = document.createElement('div');
      el.className = 'log-row';
      el.style.cssText = `
        position: absolute;
        left: 0; right: 0;
        height: ${ROW_HEIGHT}px;
        display: none;
      `;
      this.rowsContainer.appendChild(el);
      this.pool.push(el);
    }
    this.poolSize = this.pool.length;
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Reset for a new filter/query. Scrolls to top and fetches offset 0.
   */
  reset() {
    this._cancelFetch();

    this.total        = 0;
    this.rows         = [];
    this.loadedOffset = 0;
    this._lastFetchOff = -1;

    // Hide all pool elements
    for (const el of this.pool) el.style.display = 'none';

    // Reset scroll & spacer
    this.scrollContainer.scrollTop = 0;
    this.spacer.style.height = '0px';

    this._fetchAt(0);
  }

  destroy() {
    this.scrollContainer.removeEventListener('scroll', this._scrollHandler);
    this._ro.disconnect();
    this._cancelFetch();
  }

  // ─── Scroll handling ────────────────────────────────────────────────────────

  _onScroll() {
    const scrollTop     = this.scrollContainer.scrollTop;
    const firstVisible  = Math.floor(scrollTop / ROW_HEIGHT);
    const viewportRows  = Math.ceil(this.scrollContainer.clientHeight / ROW_HEIGHT);

    const wantStart = Math.max(0, firstVisible - OVERSCAN);
    const wantEnd   = Math.min(this.total, firstVisible + viewportRows + OVERSCAN);

    const haveStart = this.loadedOffset;
    const haveEnd   = this.loadedOffset + this.rows.length;

    if (wantStart >= haveStart && wantEnd <= haveEnd) {
      // All needed rows are already loaded — render immediately
      this._render(wantStart, wantEnd);
    } else {
      // Need to fetch. Center the fetch window around the visible area.
      const fetchOffset = Math.max(0, firstVisible - OVERSCAN);
      if (fetchOffset !== this._lastFetchOff) {
        this._fetchAt(fetchOffset);
      }
    }
  }

  // ─── Fetch ──────────────────────────────────────────────────────────────────

  _cancelFetch() {
    if (this._abortCtrl) {
      this._abortCtrl.abort();
      this._abortCtrl = null;
    }
  }

  async _fetchAt(offset) {
    this._cancelFetch();
    this._abortCtrl   = new AbortController();
    this._lastFetchOff = offset;

    const seq    = ++this._fetchSeq;
    const signal = this._abortCtrl.signal;

    try {
      const result = await this.fetchWindow(offset, FETCH_LIMIT, signal);

      // Discard stale responses
      if (signal.aborted || seq !== this._fetchSeq) return;

      this.total        = result.total;
      this.rows         = result.rows;
      this.loadedOffset = offset;

      // Update virtual height
      this.spacer.style.height = `${this.total * ROW_HEIGHT}px`;
      this.onTotalChange(this.total);

      // Render the current viewport
      const scrollTop    = this.scrollContainer.scrollTop;
      const firstVisible = Math.floor(scrollTop / ROW_HEIGHT);
      const viewportRows = Math.ceil(this.scrollContainer.clientHeight / ROW_HEIGHT);
      const wantStart    = Math.max(0, Math.min(offset, firstVisible - OVERSCAN));
      const wantEnd      = Math.min(this.total, wantStart + this.rows.length);

      this._render(wantStart, wantEnd);
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.error('[VirtualScroller] fetch error:', err);
    }
  }

  // ─── Render ─────────────────────────────────────────────────────────────────

  _render(wantStart, wantEnd) {
    const haveStart = this.loadedOffset;
    const haveEnd   = this.loadedOffset + this.rows.length;

    // Clamp to what we actually have
    const renderStart = Math.max(wantStart, haveStart);
    const renderEnd   = Math.min(wantEnd, haveEnd);
    const count       = Math.max(0, renderEnd - renderStart);

    // Grow pool if needed (e.g. after resize)
    while (this.pool.length < count) {
      const el = document.createElement('div');
      el.className = 'log-row';
      el.style.cssText = `position:absolute;left:0;right:0;height:${ROW_HEIGHT}px;display:none;`;
      this.rowsContainer.appendChild(el);
      this.pool.push(el);
    }

    // Render visible rows
    for (let i = 0; i < count; i++) {
      const rowIndex = renderStart + i;
      const dataIdx  = rowIndex - haveStart;
      const rowData  = this.rows[dataIdx];
      const el       = this.pool[i];

      el.style.top     = `${rowIndex * ROW_HEIGHT}px`;
      el.style.display = 'flex';

      this.renderRow(el, rowData, rowIndex);
    }

    // Hide unused pool slots
    for (let i = count; i < this.pool.length; i++) {
      this.pool[i].style.display = 'none';
    }
  }
}
