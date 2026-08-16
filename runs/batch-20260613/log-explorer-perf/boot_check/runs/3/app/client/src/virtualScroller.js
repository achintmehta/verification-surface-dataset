/**
 * VirtualScroller
 *
 * Manages a fixed-height scrollable container where only the visible rows
 * (plus overscan) exist in the DOM. Calls `onWindowChange` whenever the
 * visible offset changes, so the caller can fetch and render the new window.
 *
 * Architecture:
 *  - A tall "spacer" div sets the total scrollable height.
 *  - A "viewport" div is absolutely positioned and translated to the current
 *    scroll position, holding only the rendered rows.
 *  - On scroll, we compute the first visible row index and call onWindowChange.
 */

const ROW_HEIGHT   = 36;   // px — must match CSS --row-h
const OVERSCAN     = 10;   // extra rows above and below viewport
const FETCH_LIMIT  = 100;  // rows per API request (≤ 200)

export class VirtualScroller {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.container   - The scrollable container element
   * @param {HTMLElement} opts.spacer      - The spacer element (sets scroll height)
   * @param {HTMLElement} opts.viewport    - The rows container element
   * @param {function}    opts.onWindowChange - Called with (offset, limit) when window changes
   */
  constructor({ container, spacer, viewport, onWindowChange }) {
    this.container = container;
    this.spacer    = spacer;
    this.viewport  = viewport;
    this.onWindowChange = onWindowChange;

    this.total        = 0;   // total filtered rows
    this.currentOffset = -1; // last fetched offset (avoid redundant fetches)
    this.rows         = [];  // currently rendered row data

    this._scrollHandler = this._onScroll.bind(this);
    this.container.addEventListener('scroll', this._scrollHandler, { passive: true });
  }

  /** Update the total row count and resize the spacer. */
  setTotal(total) {
    this.total = total;
    this.spacer.style.height = `${total * ROW_HEIGHT}px`;
  }

  /** Reset scroll to top and clear rendered rows. */
  reset() {
    this.container.scrollTop = 0;
    this.currentOffset = -1;
    this.rows = [];
    this.viewport.innerHTML = '';
    this.viewport.style.transform = 'translateY(0)';
  }

  /** Render a batch of rows at the given offset. */
  renderRows(rows, offset) {
    this.rows = rows;
    this.currentOffset = offset;

    // Position the viewport at the correct scroll position
    const translateY = offset * ROW_HEIGHT;
    this.viewport.style.transform = `translateY(${translateY}px)`;

    // Build DOM
    const fragment = document.createDocumentFragment();
    for (const row of rows) {
      fragment.appendChild(buildRowEl(row));
    }
    this.viewport.innerHTML = '';
    this.viewport.appendChild(fragment);
  }

  /** Show an empty-state message. */
  showEmpty(message = 'No results') {
    this.rows = [];
    this.viewport.style.transform = 'translateY(0)';
    this.viewport.innerHTML = `<div class="empty-state">${message}</div>`;
  }

  /** Compute the row offset that should be at the top of the viewport. */
  getVisibleOffset() {
    const scrollTop = this.container.scrollTop;
    const firstVisible = Math.floor(scrollTop / ROW_HEIGHT);
    const offset = Math.max(0, firstVisible - OVERSCAN);
    return offset;
  }

  /** Compute how many rows to fetch for the current viewport. */
  getWindowSize() {
    const viewportHeight = this.container.clientHeight;
    const visibleRows = Math.ceil(viewportHeight / ROW_HEIGHT);
    return Math.min(FETCH_LIMIT, visibleRows + OVERSCAN * 2);
  }

  _onScroll() {
    const offset = this.getVisibleOffset();
    // Only trigger if we've scrolled far enough to need new data
    if (Math.abs(offset - this.currentOffset) >= Math.floor(OVERSCAN / 2)) {
      this.onWindowChange(offset, this.getWindowSize());
    }
  }

  destroy() {
    this.container.removeEventListener('scroll', this._scrollHandler);
  }
}

// ── Row element builder ────────────────────────────────────────────────────

function formatTs(isoStr) {
  // Fast ISO → "YYYY-MM-DD HH:MM:SS" without locale overhead
  return isoStr.replace('T', ' ').replace(/\.\d+Z$/, '').replace('Z', '');
}

function buildRowEl(row) {
  const el = document.createElement('div');
  el.className = `log-row ${row.severity}`;
  el.style.height = `${ROW_HEIGHT}px`;

  const ts  = document.createElement('div');
  ts.className = 'col-ts';
  ts.textContent = formatTs(row.ts);

  const sev = document.createElement('div');
  sev.className = 'col-sev';
  sev.textContent = row.severity;

  const svc = document.createElement('div');
  svc.className = 'col-svc';
  svc.textContent = row.service;

  const msg = document.createElement('div');
  msg.className = 'col-msg';
  msg.textContent = row.message;

  el.appendChild(ts);
  el.appendChild(sev);
  el.appendChild(svc);
  el.appendChild(msg);

  return el;
}
