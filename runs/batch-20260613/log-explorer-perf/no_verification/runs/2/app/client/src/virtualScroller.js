/**
 * VirtualScroller
 *
 * Manages a fixed-height scrollable container where only the visible rows
 * (plus overscan) exist in the DOM. The inner div is sized to represent
 * the full corpus height; the rows-viewport is absolutely positioned to
 * the current scroll offset.
 *
 * Architecture:
 *   - scroller-inner height = total * ROW_HEIGHT  (creates scroll range)
 *   - rows-viewport top     = firstVisibleRow * ROW_HEIGHT
 *   - rows-viewport height  = visibleRowCount * ROW_HEIGHT
 *   - DOM rows              = visibleRowCount elements (recycled in-place)
 *
 * The scroller calls onWindowChange(offset, limit) whenever the visible
 * window moves outside the currently loaded data. The caller fetches data
 * and calls setRows(rows, offset) to update the display.
 */

export const ROW_HEIGHT = 36; // must match --row-height CSS var
const OVERSCAN       = 8;    // extra rows above/below viewport
const FETCH_LIMIT    = 100;  // rows per API request (max 200 per spec)
// Trigger a new fetch when the visible window is within this many rows
// of the edge of the loaded buffer
const PREFETCH_THRESHOLD = 15;

export class VirtualScroller {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.container   - the scrollable container
   * @param {HTMLElement} opts.inner       - the tall inner div
   * @param {HTMLElement} opts.viewport    - the absolutely-positioned row holder
   * @param {function(offset:number, limit:number):void} opts.onWindowChange
   */
  constructor({ container, inner, viewport, onWindowChange }) {
    this.container = container;
    this.inner = inner;
    this.viewport = viewport;
    this.onWindowChange = onWindowChange;

    this.total = 0;
    this.rows = [];          // currently loaded rows
    this.loadedOffset = 0;   // corpus index of rows[0]

    this._pendingFetchOffset = null; // offset of the most recently requested fetch
    this._scrollRAF = null;

    this.container.addEventListener('scroll', this._onScroll.bind(this), { passive: true });
  }

  // ---- Public API ----

  /** Update the total row count (e.g. after a filter change). */
  setTotal(total) {
    this.total = total;
    this.inner.style.height = `${total * ROW_HEIGHT}px`;
  }

  /**
   * Provide a new batch of rows from the API.
   * @param {Array}  rows   - the rows returned by the API
   * @param {number} offset - corpus index of rows[0]
   */
  setRows(rows, offset) {
    this.rows = rows;
    this.loadedOffset = offset;
    this._pendingFetchOffset = null;
    this._render();
  }

  /** Reset scroll to top (call on filter change). */
  scrollToTop() {
    this.container.scrollTop = 0;
    this.rows = [];
    this.loadedOffset = 0;
    this._pendingFetchOffset = null;
  }

  /** Force a re-render + window check at the current scroll position. */
  refresh() {
    this._handleScroll();
  }

  // ---- Private ----

  _onScroll() {
    if (this._scrollRAF) return;
    this._scrollRAF = requestAnimationFrame(() => {
      this._scrollRAF = null;
      this._handleScroll();
    });
  }

  _handleScroll() {
    const scrollTop      = this.container.scrollTop;
    const containerH     = this.container.clientHeight;
    const firstVisible   = Math.floor(scrollTop / ROW_HEIGHT);
    const visibleCount   = Math.ceil(containerH / ROW_HEIGHT);
    const lastVisible    = firstVisible + visibleCount;

    // Determine the ideal fetch window (centered on visible area, with overscan)
    const idealStart = Math.max(0, firstVisible - OVERSCAN);
    const idealEnd   = Math.min(this.total - 1, lastVisible + OVERSCAN);

    // Check if the visible area is covered by the loaded buffer
    const bufferStart = this.loadedOffset;
    const bufferEnd   = this.loadedOffset + this.rows.length - 1;

    const visibleCovered = (
      this.rows.length > 0 &&
      firstVisible >= bufferStart &&
      lastVisible  <= bufferEnd
    );

    // Decide whether to fetch:
    // 1. Visible area not covered at all → fetch immediately
    // 2. Approaching the edge of the buffer → prefetch
    const nearTopEdge    = firstVisible - bufferStart < PREFETCH_THRESHOLD;
    const nearBottomEdge = bufferEnd - lastVisible    < PREFETCH_THRESHOLD;
    const shouldFetch    = !visibleCovered || (visibleCovered && (nearTopEdge || nearBottomEdge));

    if (shouldFetch) {
      // Compute fetch offset: start OVERSCAN rows before the visible area
      const fetchOffset = Math.max(0, idealStart);
      const fetchLimit  = Math.min(FETCH_LIMIT, this.total - fetchOffset);

      // Don't re-request the same offset we already have in flight
      if (fetchOffset !== this._pendingFetchOffset) {
        this._pendingFetchOffset = fetchOffset;
        this.onWindowChange(fetchOffset, Math.max(fetchLimit, FETCH_LIMIT));
      }
    }

    this._render();
  }

  _render() {
    const scrollTop    = this.container.scrollTop;
    const containerH   = this.container.clientHeight;

    if (this.total === 0) {
      this.viewport.style.top    = '0px';
      this.viewport.style.height = '0px';
      this.viewport.innerHTML    = '';
      return;
    }

    const firstVisible = Math.floor(scrollTop / ROW_HEIGHT);
    const visibleCount = Math.ceil(containerH / ROW_HEIGHT) + 1;

    // Render window: visible + overscan, clamped to [0, total)
    const renderStart = Math.max(0, firstVisible - OVERSCAN);
    const renderEnd   = Math.min(this.total - 1, firstVisible + visibleCount + OVERSCAN);
    const renderCount = renderEnd - renderStart + 1;

    // Position the viewport div
    this.viewport.style.top    = `${renderStart * ROW_HEIGHT}px`;
    this.viewport.style.height = `${renderCount * ROW_HEIGHT}px`;

    // Reuse existing child elements where possible to minimize DOM churn
    const existing = this.viewport.children;

    // Ensure we have exactly renderCount children
    while (this.viewport.childElementCount > renderCount) {
      this.viewport.removeChild(this.viewport.lastChild);
    }
    while (this.viewport.childElementCount < renderCount) {
      this.viewport.appendChild(document.createElement('div'));
    }

    // Update each child in-place
    for (let i = 0; i < renderCount; i++) {
      const absIdx = renderStart + i;
      const relIdx = absIdx - this.loadedOffset;
      const row    = (relIdx >= 0 && relIdx < this.rows.length) ? this.rows[relIdx] : null;
      const el     = existing[i];

      if (row) {
        this._updateRowEl(el, row, absIdx);
      } else {
        this._updateSkeletonEl(el, absIdx);
      }
    }
  }

  _updateRowEl(el, row, absIdx) {
    // Only re-render if the row data changed (check by id)
    if (el.dataset.rowId === String(row.id)) return;

    el.dataset.rowId    = String(row.id);
    el.dataset.skeleton = '0'; // clear skeleton flag
    el.dataset.idx      = absIdx;
    el.className        = 'log-row';

    const ts = formatTs(row.ts);

    el.innerHTML = `\
<div class="col-ts">${escapeHtml(ts)}</div>\
<div class="col-severity"><span class="severity-pill ${escapeHtml(row.severity)}">${escapeHtml(row.severity)}</span></div>\
<div class="col-service">${escapeHtml(row.service)}</div>\
<div class="col-message">${escapeHtml(row.message)}</div>`;
  }

  _updateSkeletonEl(el, absIdx) {
    if (el.dataset.skeleton === '1' && el.dataset.idx === String(absIdx)) return; // already a skeleton at this position

    el.dataset.rowId   = '';
    el.dataset.skeleton = '1';
    el.dataset.idx     = absIdx;
    el.className       = 'skeleton-row';
    el.innerHTML = `\
<div class="skeleton-block" style="width:160px"></div>\
<div class="skeleton-block" style="width:50px"></div>\
<div class="skeleton-block" style="width:120px"></div>\
<div class="skeleton-block" style="flex:1"></div>`;
  }
}

// ---- Helpers ----

function formatTs(isoStr) {
  // Fast path: parse ISO string without creating a Date object
  // Input: "2024-01-15T12:34:56.789Z" → "2024-01-15 12:34:56.789"
  if (!isoStr) return '';
  return isoStr.replace('T', ' ').replace('Z', '').slice(0, 23);
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
