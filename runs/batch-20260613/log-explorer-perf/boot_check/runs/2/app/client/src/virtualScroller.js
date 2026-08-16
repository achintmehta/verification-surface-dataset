/**
 * VirtualScroller
 *
 * Manages a fixed-height scrollable container where only the visible rows
 * (plus overscan) exist in the DOM. Rows are recycled as the user scrolls.
 *
 * Architecture:
 * - The scroller element has `overflow-y: scroll` and a fixed height.
 * - A tall "spacer" div inside the scroller sets the total scroll height.
 * - A "rows-container" div is absolutely positioned within the spacer,
 *   translated to the correct vertical offset for the current window.
 * - On each scroll event (via rAF), we compute which row-window is needed,
 *   fetch it if necessary, and re-render only the visible rows.
 *
 * Key invariants:
 * - At most WINDOW_SIZE rows exist in the DOM at any time.
 * - Stale responses are discarded via a monotonic request counter.
 * - Scroll position maps exactly to row offset: row K is at y = K * ROW_HEIGHT.
 */

import { fetchLogs } from './api.js';

const ROW_HEIGHT = 36;       // px — must match CSS --row-height
const WINDOW_SIZE = 100;     // rows fetched per request (≤ 200 cap)
const OVERSCAN = 8;          // extra rows above/below viewport

export class VirtualScroller {
  constructor({ scrollerEl, spacerEl, containerEl, onStatusChange, onCountChange }) {
    this.scrollerEl = scrollerEl;
    this.spacerEl = spacerEl;
    this.containerEl = containerEl;
    this.onStatusChange = onStatusChange || (() => {});
    this.onCountChange = onCountChange || (() => {});

    // State
    this.total = 0;
    this.filters = { severity: '', q: '' };
    this.windowOffset = -1;   // offset of the currently loaded window
    this.windowRows = [];     // rows in the current window
    this.requestSeq = 0;      // monotonic counter to detect stale responses
    this.rafId = null;
    this.isLoading = false;

    // Bind handlers
    this._onScroll = this._onScroll.bind(this);
    this.scrollerEl.addEventListener('scroll', this._onScroll, { passive: true });
  }

  /**
   * Update filters and reset scroll position.
   * Triggers a fresh fetch from offset 0.
   */
  async setFilters(filters) {
    this.filters = { severity: filters.severity || '', q: filters.q || '' };
    this.windowOffset = -1;
    this.windowRows = [];
    this.total = 0;

    // Reset scroll to top without triggering a scroll event
    this.scrollerEl.scrollTop = 0;

    // Update spacer to 0 height while loading
    this.spacerEl.style.height = '0px';
    this.containerEl.innerHTML = '';

    await this._loadWindow(0);
  }

  /**
   * Compute the window-aligned offset that covers a given row index.
   * Windows are aligned to WINDOW_SIZE boundaries.
   */
  _windowOffsetFor(rowIndex) {
    return Math.floor(rowIndex / WINDOW_SIZE) * WINDOW_SIZE;
  }

  /**
   * Load a window starting at the given offset.
   * Uses a monotonic sequence number to discard stale responses.
   */
  async _loadWindow(windowOffset) {
    const seq = ++this.requestSeq;
    const requestFilters = { ...this.filters };

    this.isLoading = true;
    this.onStatusChange('loading');

    try {
      const data = await fetchLogs(
        {
          offset: windowOffset,
          limit: WINDOW_SIZE,
          severity: requestFilters.severity,
          q: requestFilters.q,
        }
        // No AbortController here — we use seq to discard stale results.
        // AbortController would cancel the XHR but we still need the seq guard
        // for filter changes that happen before the request is sent.
      );

      // Discard if a newer request has been issued
      if (seq !== this.requestSeq) return;

      this.total = data.total;
      this.windowOffset = windowOffset;
      this.windowRows = data.rows;
      this.isLoading = false;

      // Update spacer height to reflect total rows
      this.spacerEl.style.height = `${this.total * ROW_HEIGHT}px`;

      // Notify count change
      this.onCountChange(this.total, requestFilters);

      this._render();
      this.onStatusChange('ready');
    } catch (err) {
      if (seq !== this.requestSeq) return; // stale
      console.error('[VirtualScroller] Fetch error:', err);
      this.isLoading = false;
      this.onStatusChange('error');
    }
  }

  /**
   * Scroll event handler — coalesced via rAF.
   */
  _onScroll() {
    if (this.rafId !== null) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      this._handleScroll();
    });
  }

  _handleScroll() {
    const scrollTop = this.scrollerEl.scrollTop;
    const viewportHeight = this.scrollerEl.clientHeight;

    // Compute visible row range
    const firstVisible = Math.floor(scrollTop / ROW_HEIGHT);
    const lastVisible = Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT);

    // With overscan
    const firstNeeded = Math.max(0, firstVisible - OVERSCAN);
    const lastNeeded = Math.min(this.total - 1, lastVisible + OVERSCAN);

    if (this.total === 0) return;

    // Which window covers firstNeeded?
    const neededWindowOffset = this._windowOffsetFor(firstNeeded);

    // Does the current window cover the entire needed range?
    const windowEnd = this.windowOffset + this.windowRows.length - 1;
    const covered =
      this.windowOffset !== -1 &&
      this.windowOffset <= firstNeeded &&
      windowEnd >= lastNeeded;

    if (!covered && !this.isLoading) {
      // Load the window that covers the top of the needed range
      this._loadWindow(neededWindowOffset);
    } else {
      // Current window is sufficient — just re-render at new position
      this._render();
    }
  }

  /**
   * Render the visible rows from the current window into the DOM.
   * The rows-container is absolutely positioned at the correct offset.
   */
  _render() {
    const scrollTop = this.scrollerEl.scrollTop;
    const viewportHeight = this.scrollerEl.clientHeight;

    if (this.total === 0) {
      this.containerEl.innerHTML =
        '<div class="empty-state">No log entries match the current filters.</div>';
      this.containerEl.style.transform = 'translateY(0px)';
      return;
    }

    // Compute visible range with overscan
    const firstVisible = Math.floor(scrollTop / ROW_HEIGHT);
    const lastVisible = Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT);
    const firstRow = Math.max(0, firstVisible - OVERSCAN);
    const lastRow = Math.min(this.total - 1, lastVisible + OVERSCAN);

    // Intersect with current window
    const winStart = this.windowOffset;
    const winEnd = winStart + this.windowRows.length - 1;
    const renderStart = Math.max(firstRow, winStart);
    const renderEnd = Math.min(lastRow, winEnd);

    if (renderStart > renderEnd || this.windowOffset === -1) {
      // No overlap — show loading placeholder
      this.containerEl.innerHTML =
        '<div class="empty-state"><span class="loading-indicator"></span>Loading...</div>';
      this.containerEl.style.transform = `translateY(${firstRow * ROW_HEIGHT}px)`;
      return;
    }

    // Build HTML for the renderable rows
    const parts = [];
    for (let rowIdx = renderStart; rowIdx <= renderEnd; rowIdx++) {
      const row = this.windowRows[rowIdx - winStart];
      if (row) parts.push(renderRow(row));
    }

    this.containerEl.innerHTML = parts.join('');
    // Position the container so row renderStart appears at y = renderStart * ROW_HEIGHT
    this.containerEl.style.transform = `translateY(${renderStart * ROW_HEIGHT}px)`;
  }

  destroy() {
    this.scrollerEl.removeEventListener('scroll', this._onScroll);
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
  }
}

// ── Row rendering ─────────────────────────────────────────────────────────────

function renderRow(row) {
  const ts = formatTimestamp(row.ts);
  const sev = escapeHtml((row.severity || '').toLowerCase());
  const service = escapeHtml(row.service || '');
  const message = escapeHtml(row.message || '');

  return `<div class="log-row">` +
    `<div class="col-ts">${ts}</div>` +
    `<div class="col-severity ${sev}">${sev.toUpperCase()}</div>` +
    `<div class="col-service">${service}</div>` +
    `<div class="col-message">${message}</div>` +
    `</div>`;
}

function formatTimestamp(ts) {
  if (!ts) return '';
  try {
    const d = new Date(ts);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mi = String(d.getUTCMinutes()).padStart(2, '0');
    const ss = String(d.getUTCSeconds()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss} UTC`;
  } catch {
    return String(ts);
  }
}

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (c) => ESC_MAP[c]);
}
