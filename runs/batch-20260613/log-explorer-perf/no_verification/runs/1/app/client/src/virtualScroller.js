/**
 * VirtualScroller
 *
 * Manages a virtualized list where only the visible rows (+ overscan) exist in the DOM.
 *
 * Architecture:
 * - scrollContainer: the overflow-y:scroll element
 * - spacer: absolutely-positioned element whose height = total * ROW_HEIGHT
 * - rowsContainer: absolutely positioned, translated to the current render window top
 * - A pool of DOM row elements is reused; their content is updated in place
 *
 * The scroller calls onWindowChange(offset, limit) whenever the visible window
 * needs new data. The caller fetches data and calls setRows(rows, total, windowOffset).
 *
 * Key invariants:
 * - DOM row count ≤ viewport rows + 2 * OVERSCAN + a few extra (bounded ~100)
 * - Scrolling never blocks: rAF-gated scroll handler
 * - Stale data is never shown: rows are cleared when a new fetch is triggered
 */

const ROW_HEIGHT = 36;      // must match --row-height CSS variable
const OVERSCAN   = 8;       // extra rows above and below viewport
const FETCH_LIMIT = 100;    // rows per API request (≤ 200 cap)

export class VirtualScroller {
  /**
   * @param {Object} opts
   * @param {HTMLElement} opts.scrollContainer
   * @param {HTMLElement} opts.spacer
   * @param {HTMLElement} opts.rowsContainer
   * @param {Function}    opts.onWindowChange  (offset: number, limit: number) => void
   * @param {Function}    opts.renderRow       (element: HTMLElement, row: Object) => void
   */
  constructor({ scrollContainer, spacer, rowsContainer, onWindowChange, renderRow }) {
    this.scrollContainer = scrollContainer;
    this.spacer          = spacer;
    this.rowsContainer   = rowsContainer;
    this.onWindowChange  = onWindowChange;
    this.renderRow       = renderRow;

    // Data state
    this.total        = 0;
    this.rows         = [];   // currently loaded rows
    this.windowOffset = 0;    // logical offset of rows[0]

    // Scroll state
    this.rafPending = false;

    // DOM pool
    this.rowPool = [];

    this._onScroll = this._onScroll.bind(this);
    this.scrollContainer.addEventListener('scroll', this._onScroll, { passive: true });
  }

  // ----------------------------------------------------------
  // Public API
  // ----------------------------------------------------------

  /**
   * Called by the app after a successful fetch.
   * @param {Array}  rows         - fetched rows
   * @param {number} total        - total matching rows
   * @param {number} windowOffset - logical offset of rows[0]
   */
  setRows(rows, total, windowOffset) {
    this.rows         = rows;
    this.windowOffset = windowOffset;
    this.total        = total;
    this._updateSpacer();
    this._render();
  }

  /**
   * Reset to empty state (called when filters change before new data arrives).
   */
  reset() {
    this.rows         = [];
    this.windowOffset = 0;
    this.total        = 0;
    this._updateSpacer();
    this.scrollContainer.scrollTop = 0;
    this._clearPool();
  }

  /**
   * Force a re-render (e.g. after window resize).
   */
  refresh() {
    this._render();
  }

  destroy() {
    this.scrollContainer.removeEventListener('scroll', this._onScroll);
  }

  // ----------------------------------------------------------
  // Internal
  // ----------------------------------------------------------

  _updateSpacer() {
    this.spacer.style.height = `${this.total * ROW_HEIGHT}px`;
  }

  _onScroll() {
    if (this.rafPending) return;
    this.rafPending = true;
    requestAnimationFrame(() => {
      this.rafPending = false;
      this._handleScroll();
    });
  }

  _handleScroll() {
    const scrollTop    = this.scrollContainer.scrollTop;
    const viewportRows = Math.ceil(this.scrollContainer.clientHeight / ROW_HEIGHT);

    // First and last visible row indices (logical)
    const firstVisible = Math.floor(scrollTop / ROW_HEIGHT);
    const lastVisible  = firstVisible + viewportRows - 1;

    // Window we need to have loaded (with overscan)
    const needStart = Math.max(0, firstVisible - OVERSCAN);
    const needEnd   = Math.min(this.total - 1, lastVisible + OVERSCAN);

    // Loaded window
    const loadedStart = this.windowOffset;
    const loadedEnd   = this.windowOffset + this.rows.length - 1;

    const covered = this.rows.length > 0 && needStart >= loadedStart && needEnd <= loadedEnd;

    if (!covered) {
      // Compute a fetch window centered on the visible area, biased slightly forward
      const center     = Math.floor((firstVisible + lastVisible) / 2);
      const fetchStart = Math.max(0, center - Math.floor(FETCH_LIMIT * 0.4));
      const fetchLimit = Math.min(FETCH_LIMIT, this.total - fetchStart);

      if (fetchLimit > 0) {
        this.onWindowChange(fetchStart, fetchLimit);
      }
    } else {
      this._render();
    }
  }

  _render() {
    const scrollTop    = this.scrollContainer.scrollTop;
    const viewportRows = Math.ceil(this.scrollContainer.clientHeight / ROW_HEIGHT);

    if (this.total === 0 || this.rows.length === 0) {
      this._clearPool();
      return;
    }

    const firstVisible = Math.floor(scrollTop / ROW_HEIGHT);
    const lastVisible  = firstVisible + viewportRows - 1;

    // Clamp render range to what is actually loaded
    const renderStart = Math.max(this.windowOffset, firstVisible - OVERSCAN);
    const renderEnd   = Math.min(
      this.windowOffset + this.rows.length - 1,
      lastVisible + OVERSCAN
    );

    if (renderStart > renderEnd) {
      this._clearPool();
      return;
    }

    const count = renderEnd - renderStart + 1;

    // Grow pool if needed (pool never shrinks — elements are just hidden)
    this._ensurePool(count);

    // Translate the rows container to the top of the render window
    this.rowsContainer.style.transform = `translateY(${renderStart * ROW_HEIGHT}px)`;

    // Fill visible pool slots, hide the rest
    for (let i = 0; i < this.rowPool.length; i++) {
      const el = this.rowPool[i];
      if (i < count) {
        const logicalIndex = renderStart + i;
        const dataIndex    = logicalIndex - this.windowOffset;
        const row          = this.rows[dataIndex];
        if (row !== undefined) {
          this.renderRow(el, row);
          el.style.display = '';
        } else {
          el.style.display = 'none';
        }
      } else {
        el.style.display = 'none';
      }
    }
  }

  _ensurePool(count) {
    while (this.rowPool.length < count) {
      const el = document.createElement('div');
      el.className    = 'log-row';
      el.style.height = `${ROW_HEIGHT}px`;
      this.rowsContainer.appendChild(el);
      this.rowPool.push(el);
    }
  }

  _clearPool() {
    for (const el of this.rowPool) {
      el.style.display = 'none';
    }
    this.rowsContainer.style.transform = 'translateY(0px)';
  }
}
