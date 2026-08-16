/**
 * VirtualScroller
 *
 * Manages a fixed-height scrollable container where only the visible rows
 * (plus overscan) exist in the DOM. The inner div is sized to total * ROW_HEIGHT
 * so the native scrollbar reflects the full corpus. The rows-viewport is
 * translated to the correct position via CSS transform.
 *
 * Usage:
 *   const vs = new VirtualScroller(containerEl, innerEl, viewportEl, {
 *     rowHeight: 36,
 *     overscan: 10,
 *     onWindowChange: ({ startIndex, endIndex, offset }) => { ... }
 *   });
 *   vs.setTotal(100000);
 *   vs.scrollToTop();
 */

export class VirtualScroller {
  /**
   * @param {HTMLElement} container  - the scrollable element (overflow-y: scroll)
   * @param {HTMLElement} inner      - the tall inner div (height = total * rowHeight)
   * @param {HTMLElement} viewport   - the absolutely-positioned rows container
   * @param {object}      opts
   * @param {number}      opts.rowHeight
   * @param {number}      [opts.overscan=8]
   * @param {function}    opts.onWindowChange  called with { startIndex, endIndex, offset }
   */
  constructor(container, inner, viewport, opts) {
    this._container = container;
    this._inner = inner;
    this._viewport = viewport;
    this._rowHeight = opts.rowHeight;
    this._overscan = opts.overscan ?? 8;
    this._onWindowChange = opts.onWindowChange;

    this._total = 0;
    this._lastStartIndex = -1;
    this._lastEndIndex = -1;
    this._ticking = false;

    this._handleScroll = this._handleScroll.bind(this);
    this._container.addEventListener('scroll', this._handleScroll, { passive: true });
  }

  /**
   * Update the total number of rows (e.g. after a filter change).
   * Resets scroll position to top and re-triggers onWindowChange.
   */
  setTotal(total) {
    this._total = total;
    const totalHeight = total * this._rowHeight;
    this._inner.style.height = `${totalHeight}px`;
    // Force a re-render of the current scroll position
    this._lastStartIndex = -1;
    this._compute();
  }

  /**
   * Update the total without resetting scroll position.
   * Re-computes the visible window (which may expand if total grew).
   * Used when the total is refined by a data response (not a filter change).
   */
  updateTotal(total) {
    this._total = total;
    const totalHeight = total * this._rowHeight;
    this._inner.style.height = `${totalHeight}px`;
    // Reset lastStartIndex so _compute() will fire onWindowChange with the
    // correct endIndex for the new total.
    this._lastStartIndex = -1;
    this._compute();
  }

  /** Programmatically scroll to the top and force a window refresh. */
  scrollToTop() {
    this._container.scrollTop = 0;
    // Reset so _compute() always fires onWindowChange (even if already at top)
    this._lastStartIndex = -1;
    this._lastEndIndex   = -1;
    this._compute();
  }

  /** Programmatically scroll to a specific row index. */
  scrollToIndex(index) {
    const clampedIndex = Math.max(0, Math.min(index, this._total - 1));
    this._container.scrollTop = clampedIndex * this._rowHeight;
    this._compute();
  }

  /** Get the current visible start index. */
  get startIndex() {
    return this._lastStartIndex;
  }

  destroy() {
    this._container.removeEventListener('scroll', this._handleScroll);
  }

  _handleScroll() {
    if (this._ticking) return;
    this._ticking = true;
    requestAnimationFrame(() => {
      this._ticking = false;
      this._compute();
    });
  }

  _compute() {
    const scrollTop = this._container.scrollTop;
    const viewportHeight = this._container.clientHeight;
    const rowHeight = this._rowHeight;
    const overscan = this._overscan;
    const total = this._total;

    if (total === 0) {
      this._viewport.style.transform = 'translateY(0px)';
      if (this._lastStartIndex !== 0 || this._lastEndIndex !== 0) {
        this._lastStartIndex = 0;
        this._lastEndIndex = 0;
        this._onWindowChange({ startIndex: 0, endIndex: 0, offset: 0 });
      }
      return;
    }

    // First visible row
    const firstVisible = Math.floor(scrollTop / rowHeight);
    // Last visible row
    const lastVisible = Math.min(
      total - 1,
      Math.ceil((scrollTop + viewportHeight) / rowHeight)
    );

    // Apply overscan
    const startIndex = Math.max(0, firstVisible - overscan);
    const endIndex   = Math.min(total - 1, lastVisible + overscan);

    // Only trigger callback if the window actually changed
    if (startIndex === this._lastStartIndex && endIndex === this._lastEndIndex) {
      return;
    }

    this._lastStartIndex = startIndex;
    this._lastEndIndex   = endIndex;

    // Position the rows-viewport at the correct offset
    const translateY = startIndex * rowHeight;
    this._viewport.style.transform = `translateY(${translateY}px)`;

    this._onWindowChange({ startIndex, endIndex, offset: startIndex });
  }
}
