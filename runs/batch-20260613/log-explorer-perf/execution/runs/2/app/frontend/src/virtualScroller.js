/**
 * VirtualScroller — renders only the visible rows in the DOM.
 *
 * Architecture:
 * - A tall spacer div sets the total scroll height (total * ROW_HEIGHT).
 * - A positioned inner div holds the visible row elements, translated to the
 *   correct vertical position via CSS transform.
 * - On scroll, we compute which row offset is at the top of the viewport,
 *   fetch that window from the server, and update the DOM rows in place.
 * - A small overscan (OVERSCAN rows above and below) prevents blank flashes.
 *
 * The scroller calls onWindowChange(offset, limit) when it needs new data,
 * and the caller feeds data back via setData(rows, total).
 */

const ROW_HEIGHT = 36; // px — must match CSS --row-height
const OVERSCAN = 5;    // extra rows above/below viewport

export class VirtualScroller {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.container   - The scrollable container
   * @param {HTMLElement} opts.spacer      - The tall spacer div
   * @param {HTMLElement} opts.rowsEl      - The positioned rows container
   * @param {function}    opts.onWindowChange - Called with (offset, limit) when viewport changes
   * @param {function}    opts.renderRow   - Called with (row) → HTMLElement
   */
  constructor({ container, spacer, rowsEl, onWindowChange, renderRow }) {
    this.container = container;
    this.spacer = spacer;
    this.rowsEl = rowsEl;
    this.onWindowChange = onWindowChange;
    this.renderRow = renderRow;

    this.total = 0;
    this.rows = [];          // current data window
    this.windowOffset = 0;   // offset of first row in this.rows
    this.windowLimit = 100;  // how many rows we fetch at once

    this._pendingScroll = false;
    this._lastScrollTop = 0;
    this._rafId = null;

    this.container.addEventListener('scroll', this._onScroll.bind(this), { passive: true });
  }

  /** Update total row count and re-render spacer height */
  setTotal(total) {
    this.total = total;
    this.spacer.style.height = `${total * ROW_HEIGHT}px`;
  }

  /** Feed new data from the server into the scroller */
  setData(rows, total, windowOffset) {
    this.rows = rows;
    this.windowOffset = windowOffset;
    this.setTotal(total);
    this._render();
  }

  /** Reset scroll position to top (call when filters change) */
  resetScroll() {
    this.container.scrollTop = 0;
    this._lastScrollTop = 0;
  }

  /** Compute how many rows fit in the viewport */
  _visibleCount() {
    return Math.ceil(this.container.clientHeight / ROW_HEIGHT) + OVERSCAN * 2;
  }

  /** Compute the row offset at the top of the viewport */
  _topRowOffset() {
    const scrollTop = this.container.scrollTop;
    return Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  }

  _onScroll() {
    if (this._rafId) return; // already scheduled
    this._rafId = requestAnimationFrame(() => {
      this._rafId = null;
      this._checkWindow();
    });
  }

  /** Check if the current scroll position is outside the fetched window */
  _checkWindow() {
    const topOffset = this._topRowOffset();
    const visCount = this._visibleCount();
    const bottomOffset = Math.min(this.total - 1, topOffset + visCount);

    const windowStart = this.windowOffset;
    const windowEnd = this.windowOffset + this.rows.length - 1;

    // If the visible range is fully within the current window, just re-render
    if (topOffset >= windowStart && bottomOffset <= windowEnd) {
      this._render();
      return;
    }

    // Need to fetch a new window
    const fetchOffset = Math.max(0, topOffset - OVERSCAN);
    const fetchLimit = Math.min(200, visCount + OVERSCAN * 4);
    this.onWindowChange(fetchOffset, fetchLimit);
  }

  /** Trigger an immediate window check (e.g. after filter change) */
  refresh() {
    this._checkWindow();
  }

  /** Render the visible rows into the DOM */
  _render() {
    if (this.total === 0) {
      this.rowsEl.innerHTML = '';
      return;
    }

    const scrollTop = this.container.scrollTop;
    const viewportHeight = this.container.clientHeight;

    // Compute which rows are visible
    const firstVisible = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const lastVisible = Math.min(
      this.total - 1,
      Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN
    );

    // Clamp to what we have in our data window
    const renderStart = Math.max(firstVisible, this.windowOffset);
    const renderEnd = Math.min(lastVisible, this.windowOffset + this.rows.length - 1);

    if (renderStart > renderEnd) {
      this.rowsEl.innerHTML = '';
      return;
    }

    // Build fragment
    const fragment = document.createDocumentFragment();
    for (let i = renderStart; i <= renderEnd; i++) {
      const row = this.rows[i - this.windowOffset];
      if (!row) continue;
      const el = this.renderRow(row, i);
      fragment.appendChild(el);
    }

    // Position the rows container at the correct vertical offset
    const translateY = renderStart * ROW_HEIGHT;
    this.rowsEl.style.transform = `translateY(${translateY}px)`;

    // Replace DOM content
    this.rowsEl.innerHTML = '';
    this.rowsEl.appendChild(fragment);
  }
}
