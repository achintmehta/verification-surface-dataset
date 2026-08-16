/**
 * VirtualScroller
 *
 * Manages a virtualized list where only the visible rows (+ overscan) exist
 * in the DOM. The total scroll height is set via a spacer element so the
 * browser's native scrollbar reflects the full corpus size.
 *
 * Architecture:
 *   - A fixed pool of DOM row elements is created once and reused.
 *   - On each scroll event the visible window [startIdx, endIdx] is computed.
 *   - If the window has changed, rows are fetched from the server and the
 *     pool elements are updated in-place (no DOM creation/destruction).
 *   - The rows-container is translated to the correct Y position.
 *
 * The scroller calls onFetch(offset, limit, signal) → Promise<{total, rows}>.
 *
 * Cache strategy:
 *   - A Map<rowIndex, rowData> holds fetched rows.
 *   - Cache is cleared on filter change (via reset()).
 *   - Fetch windows are aligned to FETCH_LIMIT boundaries for cache efficiency.
 *   - Only one fetch is in-flight at a time; stale fetches are aborted.
 */

const ROW_HEIGHT = 36;   // must match CSS --row-height
const OVERSCAN = 15;     // extra rows above/below viewport
const POOL_SIZE = 100;   // DOM rows in pool (viewport ~30 rows + 2×overscan + buffer)
const FETCH_LIMIT = 100; // rows per API request (≤ 200)

export class VirtualScroller {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.scroller   - the scrollable container
   * @param {HTMLElement} opts.spacer     - the height-setting element
   * @param {HTMLElement} opts.container  - where row elements live
   * @param {function}    opts.onFetch    - async (offset, limit, signal) => { total, rows }
   * @param {function}    opts.renderRow  - (element, rowData, rowIndex) => void
   */
  constructor({ scroller, spacer, container, onFetch, renderRow }) {
    this.scroller = scroller;
    this.spacer = spacer;
    this.container = container;
    this.onFetch = onFetch;
    this.renderRow = renderRow;

    this.total = 0;
    this.rowCache = new Map(); // rowIndex → rowData
    this.fetchAbort = null;
    this.pendingRaf = false;
    this.isFetching = false;

    // Build the DOM pool once
    this.pool = [];
    for (let i = 0; i < POOL_SIZE; i++) {
      const el = document.createElement('div');
      el.className = 'log-row';
      el.style.height = `${ROW_HEIGHT}px`;
      el.style.display = 'none';
      this.container.appendChild(el);
      this.pool.push(el);
    }

    // Bind scroll handler (passive for performance)
    this._onScroll = this._scheduleRender.bind(this);
    this.scroller.addEventListener('scroll', this._onScroll, { passive: true });
  }

  /**
   * Reset the scroller for a new filter/total.
   * Clears the cache, scrolls to top, and triggers an initial render.
   */
  reset(total) {
    this.total = total;
    this.rowCache.clear();

    // Cancel any in-flight fetch
    if (this.fetchAbort) {
      this.fetchAbort.abort();
      this.fetchAbort = null;
    }
    this.isFetching = false;

    // Update spacer height
    this.spacer.style.height = `${total * ROW_HEIGHT}px`;

    // Scroll to top
    this.scroller.scrollTop = 0;

    // Clear pool
    for (const el of this.pool) {
      el.style.display = 'none';
    }

    // Render initial window
    this._scheduleRender();
  }

  /**
   * Update total (e.g. after a count query) without resetting scroll.
   */
  updateTotal(total) {
    if (this.total !== total) {
      this.total = total;
      this.spacer.style.height = `${total * ROW_HEIGHT}px`;
    }
  }

  /**
   * Pre-populate the cache with rows from an initial fetch.
   * Call this before reset() to avoid a redundant fetch on first render.
   */
  primeCache(startIdx, rows) {
    for (let i = 0; i < rows.length; i++) {
      this.rowCache.set(startIdx + i, rows[i]);
    }
  }

  _scheduleRender() {
    if (this.pendingRaf) return;
    this.pendingRaf = true;
    requestAnimationFrame(() => {
      this.pendingRaf = false;
      this._render();
    });
  }

  _getVisibleRange() {
    const scrollTop = this.scroller.scrollTop;
    const viewportHeight = this.scroller.clientHeight;

    const firstVisible = Math.floor(scrollTop / ROW_HEIGHT);
    const lastVisible = Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT);

    const start = Math.max(0, firstVisible - OVERSCAN);
    const end = Math.min(this.total, lastVisible + OVERSCAN);

    return { start, end };
  }

  _render() {
    if (this.total === 0) {
      for (const el of this.pool) el.style.display = 'none';
      return;
    }

    const { start, end } = this._getVisibleRange();
    const count = end - start;

    if (count <= 0) return;

    // Check if we need to fetch any rows
    const needsFetch = this._needsFetch(start, end);
    if (needsFetch && !this.isFetching) {
      this._fetchWindow(start, end);
    }

    // Position the container at the start of the visible window
    const containerTop = start * ROW_HEIGHT;
    this.container.style.transform = `translateY(${containerTop}px)`;

    // Render rows from cache into pool elements
    const poolCount = Math.min(count, POOL_SIZE);
    for (let i = 0; i < poolCount; i++) {
      const rowIdx = start + i;
      const el = this.pool[i];
      const rowData = this.rowCache.get(rowIdx);

      if (rowData) {
        el.style.opacity = '1';
        this.renderRow(el, rowData, rowIdx);
        el.style.display = 'flex';
      } else {
        // Placeholder while loading
        el.innerHTML = '<div class="col-ts">Loading...</div>';
        el.style.opacity = '0.3';
        el.style.display = 'flex';
      }
    }

    // Hide unused pool elements
    for (let i = poolCount; i < POOL_SIZE; i++) {
      this.pool[i].style.display = 'none';
    }
  }

  _needsFetch(start, end) {
    for (let i = start; i < end; i++) {
      if (!this.rowCache.has(i)) return true;
    }
    return false;
  }

  async _fetchWindow(start, end) {
    // Cancel any previous in-flight fetch
    if (this.fetchAbort) {
      this.fetchAbort.abort();
    }
    this.fetchAbort = new AbortController();
    const signal = this.fetchAbort.signal;
    this.isFetching = true;

    // Align offset to FETCH_LIMIT boundary for cache efficiency
    const alignedStart = Math.floor(start / FETCH_LIMIT) * FETCH_LIMIT;
    const alignedEnd = Math.min(
      this.total,
      Math.ceil(end / FETCH_LIMIT) * FETCH_LIMIT
    );
    const limit = Math.min(alignedEnd - alignedStart, FETCH_LIMIT);

    try {
      const result = await this.onFetch(alignedStart, limit, signal);

      if (signal.aborted) return;

      this.isFetching = false;

      // Update total if it changed
      if (result.total !== this.total) {
        this.updateTotal(result.total);
      }

      // Store rows in cache
      for (let i = 0; i < result.rows.length; i++) {
        this.rowCache.set(alignedStart + i, result.rows[i]);
      }

      // Re-render now that we have data
      this._render();
    } catch (err) {
      this.isFetching = false;
      if (err.name === 'AbortError') return;
      console.error('[VirtualScroller] fetch error:', err);
    }
  }

  destroy() {
    this.scroller.removeEventListener('scroll', this._onScroll);
    if (this.fetchAbort) this.fetchAbort.abort();
  }
}
