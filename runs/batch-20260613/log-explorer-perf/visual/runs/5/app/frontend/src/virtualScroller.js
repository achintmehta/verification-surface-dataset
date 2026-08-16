/**
 * VirtualScroller — fixed-height row virtualization
 *
 * Architecture:
 * - A tall "spacer" div sets the scrollable height = total * rowHeight
 * - A "rows container" is absolutely positioned and translated to the
 *   current window's top offset via CSS transform
 * - Only (viewport / rowHeight + 2*overscan) DOM elements exist at any time
 * - On scroll, we check if the visible window has moved outside the cached
 *   data range; if so, we fetch a new window from the server
 * - A DOM element pool is reused (no create/destroy per scroll event)
 */
export class VirtualScroller {
  /**
   * @param {Object} opts
   * @param {HTMLElement} opts.container       Scrollable container
   * @param {HTMLElement} opts.spacer          Tall spacer (sets scroll height)
   * @param {HTMLElement} opts.rowsContainer   Absolutely-positioned row host
   * @param {number}      opts.rowHeight       Fixed row height in px
   * @param {number}      [opts.overscan=8]    Extra rows above/below viewport
   * @param {number}      [opts.fetchLimit=100] Rows per API fetch
   * @param {Function}    opts.fetchWindow     async (offset, limit, signal) => {total, rows}
   * @param {Function}    opts.renderRow       (rowData, domElement) => void
   * @param {Function}    [opts.onStatus]      (message: string) => void
   * @param {Function}    [opts.onOffsetChange] (firstVisible: number, total: number) => void
   */
  constructor(opts) {
    this.container = opts.container;
    this.spacer = opts.spacer;
    this.rowsContainer = opts.rowsContainer;
    this.rowHeight = opts.rowHeight;
    this.overscan = opts.overscan ?? 8;
    this.fetchLimit = opts.fetchLimit ?? 100;
    this.fetchWindow = opts.fetchWindow;
    this.renderRow = opts.renderRow;
    this.onStatus = opts.onStatus ?? (() => {});
    this.onOffsetChange = opts.onOffsetChange ?? (() => {});

    // State
    this.total = 0;
    this.cache = [];          // rows from last fetch
    this.cacheOffset = -1;   // row index of cache[0]
    this.cacheSize = 0;      // cache.length

    // Inflight fetch tracking
    this._fetchAC = null;    // AbortController for current fetch
    this._fetchingOffset = -1;

    // DOM pool
    this._pool = [];

    // RAF handle
    this._raf = null;

    // Bind scroll
    this.container.addEventListener('scroll', this._onScroll.bind(this), { passive: true });
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /** Set total row count and resize the spacer */
  setTotal(total) {
    this.total = total;
    this.spacer.style.height = `${total * this.rowHeight}px`;
  }

  /** Reset to top, clear cache, re-render */
  reset() {
    this.container.scrollTop = 0;
    this._invalidateCache();
    this._scheduleRender();
  }

  /** Invalidate cache and re-render at current scroll position */
  invalidate() {
    this._invalidateCache();
    this._scheduleRender();
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  _invalidateCache() {
    this.cache = [];
    this.cacheOffset = -1;
    this.cacheSize = 0;
  }

  _onScroll() {
    this._scheduleRender();
  }

  _scheduleRender() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = null;
      this._render();
    });
  }

  async _render() {
    const scrollTop = this.container.scrollTop;
    const viewportH = this.container.clientHeight;
    const rh = this.rowHeight;
    const total = this.total;

    if (total === 0) {
      this._hideAll();
      return;
    }

    // Visible row range
    const firstVisible = Math.floor(scrollTop / rh);
    const lastVisible = Math.min(total - 1, Math.ceil((scrollTop + viewportH) / rh));

    // Window with overscan
    const winStart = Math.max(0, firstVisible - this.overscan);
    const winEnd = Math.min(total - 1, lastVisible + this.overscan);

    this.onOffsetChange(firstVisible, total);

    // Check if we need to fetch
    const cacheCoversWindow =
      this.cacheOffset >= 0 &&
      winStart >= this.cacheOffset &&
      winEnd < this.cacheOffset + this.cacheSize;

    if (!cacheCoversWindow) {
      // Compute fetch range: center the fetch window around the visible area
      // Use a larger fetch window to reduce fetch frequency while scrolling
      const fetchSize = this.fetchLimit;
      const center = Math.floor((winStart + winEnd) / 2);
      const fetchStart = Math.max(0, center - Math.floor(fetchSize / 2));
      const fetchEnd = Math.min(total - 1, fetchStart + fetchSize - 1);
      const actualFetchSize = fetchEnd - fetchStart + 1;

      await this._fetch(fetchStart, actualFetchSize);
      // After fetch, re-render (scroll may have moved, but we render what we have)
    }

    this._renderWindow(winStart, winEnd);
  }

  async _fetch(offset, limit) {
    // Cancel any in-flight fetch
    if (this._fetchAC) {
      this._fetchAC.abort();
    }
    this._fetchAC = new AbortController();
    const signal = this._fetchAC.signal;
    this._fetchingOffset = offset;

    this.onStatus(`Loading rows ${offset + 1}–${offset + limit}…`);

    try {
      const result = await this.fetchWindow(offset, limit, signal);

      if (signal.aborted) return;

      this.cache = result.rows;
      this.cacheOffset = offset;
      this.cacheSize = result.rows.length;

      // Update total if server reports a different count (filter changed)
      if (result.total !== this.total) {
        this.setTotal(result.total);
      }

      this.onStatus(
        `Rows ${offset + 1}–${offset + result.rows.length} of ${result.total.toLocaleString()}`
      );
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.error('[VirtualScroller] fetch error:', err);
      this.onStatus(`Error: ${err.message}`);
    }
  }

  _renderWindow(winStart, winEnd) {
    const count = winEnd - winStart + 1;
    if (count <= 0) {
      this._hideAll();
      return;
    }

    // Grow pool if needed
    while (this._pool.length < count) {
      const el = document.createElement('div');
      el.className = 'log-row';
      this.rowsContainer.appendChild(el);
      this._pool.push(el);
    }

    // Position the rows container at the start of the window
    this.rowsContainer.style.transform = `translateY(${winStart * this.rowHeight}px)`;

    // Fill visible rows
    for (let i = 0; i < count; i++) {
      const rowIdx = winStart + i;
      const el = this._pool[i];
      const cacheIdx = rowIdx - this.cacheOffset;

      if (cacheIdx >= 0 && cacheIdx < this.cacheSize) {
        this.renderRow(this.cache[cacheIdx], el);
        el.style.display = '';
      } else {
        // Placeholder while loading
        el.className = 'log-row';
        el.innerHTML =
          '<div class="col-ts">…</div>' +
          '<div class="col-severity"></div>' +
          '<div class="col-service"></div>' +
          '<div class="col-message" style="color:var(--text-dim)">Loading…</div>';
        el.style.display = '';
      }
    }

    // Hide unused pool elements
    for (let i = count; i < this._pool.length; i++) {
      this._pool[i].style.display = 'none';
    }
  }

  _hideAll() {
    for (const el of this._pool) {
      el.style.display = 'none';
    }
  }
}
