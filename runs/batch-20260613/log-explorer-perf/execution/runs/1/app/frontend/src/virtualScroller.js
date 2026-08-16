/**
 * VirtualScroller
 *
 * Manages a virtualized list where only the visible rows (+ overscan) exist in the DOM.
 * The scroll container has a spacer element that sets the total scrollable height.
 * Rows are positioned absolutely within the rows container.
 *
 * Architecture:
 * - scrollContainer: the overflow-y:scroll element
 * - spacer: sets total scroll height = total * ROW_HEIGHT
 * - rowsContainer: absolutely positioned, holds only visible rows
 *
 * On scroll, we compute which row indices are visible, fetch that window from the API,
 * and render only those rows.
 *
 * Window alignment strategy:
 * - We fetch FETCH_LIMIT rows per request, aligned to FETCH_LIMIT boundaries.
 * - The visible window (with overscan) is always fully contained within one fetch window
 *   because FETCH_LIMIT (150) >> viewport rows (~20) + 2*OVERSCAN (20).
 * - We center the fetch window on the visible area to minimize boundary effects.
 */

import { fetchLogs } from './api.js';

const ROW_HEIGHT = 36;   // px, must match CSS --row-height
const OVERSCAN = 15;     // extra rows above/below viewport
const FETCH_LIMIT = 150; // rows per API request (well within 200 cap)

const SEVERITY_CLASSES = {
  debug: 'severity-debug',
  info: 'severity-info',
  warn: 'severity-warn',
  error: 'severity-error',
};

export class VirtualScroller {
  constructor({ scrollContainer, spacer, rowsContainer, onStatusChange, onTotalChange }) {
    this.scrollContainer = scrollContainer;
    this.spacer = spacer;
    this.rowsContainer = rowsContainer;
    this.onStatusChange = onStatusChange || (() => {});
    this.onTotalChange = onTotalChange || (() => {});

    // State
    this.total = 0;
    this.severity = '';
    this.q = '';

    // Cache: Map<cacheKey, {rows, total}> — stores fetched windows
    this.cache = new Map();
    this.cacheOrder = []; // LRU order

    // In-flight request controller
    this.abortController = null;

    // Pending scroll animation frame
    this.rafId = null;

    // Last rendered window offset (for re-render on resize)
    this.lastWindowOffset = 0;

    // Bind scroll handler
    this._onScroll = this._onScroll.bind(this);
    this.scrollContainer.addEventListener('scroll', this._onScroll, { passive: true });
  }

  /**
   * Update filters and reset scroll position.
   * Clears cache and re-fetches from offset 0.
   */
  async setFilters({ severity = '', q = '' } = {}) {
    this.severity = severity;
    this.q = q;
    this.cache.clear();
    this.cacheOrder = [];
    // Reset scroll position
    this.scrollContainer.scrollTop = 0;
    // Clear rows immediately
    this.rowsContainer.innerHTML = '';
    this.spacer.style.height = '0px';
    await this._fetchAndRender(0);
  }

  /**
   * Called on scroll events (throttled via rAF).
   */
  _onScroll() {
    if (this.rafId) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      this._handleScroll();
    });
  }

  _handleScroll() {
    const scrollTop = this.scrollContainer.scrollTop;
    const viewportHeight = this.scrollContainer.clientHeight;

    // Center of the visible area
    const centerRow = Math.floor((scrollTop + viewportHeight / 2) / ROW_HEIGHT);

    // Compute fetch window centered on the visible area
    // This ensures the visible rows + overscan are always within the fetched window
    const halfWindow = Math.floor(FETCH_LIMIT / 2);
    let windowStart = Math.max(0, centerRow - halfWindow);

    // Align to FETCH_LIMIT boundaries for cache efficiency
    windowStart = Math.floor(windowStart / FETCH_LIMIT) * FETCH_LIMIT;

    // Check if visible rows are within the current window
    const firstVisible = Math.floor(scrollTop / ROW_HEIGHT);
    const lastVisible = Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT);
    const renderStart = Math.max(0, firstVisible - OVERSCAN);
    const renderEnd = Math.min(this.total - 1, lastVisible + OVERSCAN);

    // If the render range is within the last fetched window, just re-render from cache
    const cacheKey = `${windowStart}:${this.severity}:${this.q}`;
    if (this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey);
      this._render(windowStart, cached.rows, cached.total);
      return;
    }

    this._fetchAndRender(windowStart);
  }

  /**
   * Fetch a window starting at `offset` and render visible rows.
   */
  async _fetchAndRender(offset) {
    // Cancel any in-flight request
    if (this.abortController) {
      this.abortController.abort();
    }
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    // Snapshot filters at time of request
    const severity = this.severity;
    const q = this.q;

    // Check cache first
    const cacheKey = `${offset}:${severity}:${q}`;
    if (this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey);
      this._render(offset, cached.rows, cached.total);
      return;
    }

    this.onStatusChange('loading');

    try {
      const result = await fetchLogs(
        { offset, limit: FETCH_LIMIT, severity, q },
        signal
      );

      // If filters changed while we were fetching, discard this result
      if (severity !== this.severity || q !== this.q) return;

      // Store in cache (LRU, max 30 entries)
      this._cacheSet(cacheKey, result);

      this._render(offset, result.rows, result.total);
      this.onStatusChange('ready');
    } catch (err) {
      if (err.name === 'AbortError') return; // cancelled, ignore
      console.error('Fetch error:', err);
      this.onStatusChange('error: ' + err.message);
    }
  }

  _cacheSet(key, value) {
    if (this.cache.has(key)) {
      // Move to end (most recently used)
      this.cacheOrder = this.cacheOrder.filter(k => k !== key);
    } else if (this.cacheOrder.length >= 30) {
      // Evict least recently used
      const oldest = this.cacheOrder.shift();
      this.cache.delete(oldest);
    }
    this.cache.set(key, value);
    this.cacheOrder.push(key);
  }

  /**
   * Render the visible rows from the fetched window.
   */
  _render(windowOffset, rows, total) {
    // Update total if changed
    if (total !== this.total) {
      this.total = total;
      this.spacer.style.height = `${total * ROW_HEIGHT}px`;
      this.onTotalChange(total);
    }

    this.lastWindowOffset = windowOffset;

    // Determine which rows are visible
    const scrollTop = this.scrollContainer.scrollTop;
    const viewportHeight = this.scrollContainer.clientHeight;

    const firstVisible = Math.floor(scrollTop / ROW_HEIGHT);
    const lastVisible = Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT);

    const renderStart = Math.max(0, firstVisible - OVERSCAN);
    const renderEnd = Math.min(total - 1, lastVisible + OVERSCAN);

    if (total === 0 || renderStart > renderEnd) {
      this.rowsContainer.innerHTML = '';
      if (total === 0) {
        this.rowsContainer.style.top = '0px';
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.textContent = 'No log entries match the current filters.';
        this.rowsContainer.appendChild(empty);
      }
      return;
    }

    // Build fragment — only rows that fall within the fetched window
    const fragment = document.createDocumentFragment();
    let firstRendered = -1;
    let lastRendered = -1;

    for (let i = renderStart; i <= renderEnd; i++) {
      const rowIndex = i - windowOffset;
      if (rowIndex < 0 || rowIndex >= rows.length) continue;

      const row = rows[rowIndex];
      const el = this._createRowElement(row, i);
      fragment.appendChild(el);

      if (firstRendered === -1) firstRendered = i;
      lastRendered = i;
    }

    if (firstRendered === -1) {
      // No rows from this window are in the visible range — this shouldn't happen
      // with proper window centering, but handle gracefully
      this.rowsContainer.innerHTML = '';
      return;
    }

    // Position the rows container at the top of the first rendered row
    const containerTop = firstRendered * ROW_HEIGHT;
    this.rowsContainer.style.top = `${containerTop}px`;

    // Replace DOM content
    this.rowsContainer.innerHTML = '';
    this.rowsContainer.appendChild(fragment);
  }

  /**
   * Create a DOM element for a single log row.
   */
  _createRowElement(row, index) {
    const div = document.createElement('div');
    div.className = 'log-row';

    // Format timestamp: "2024-01-15 14:23:45Z"
    const ts = new Date(row.ts);
    const tsStr = ts.toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');

    const severityClass = SEVERITY_CLASSES[row.severity] || '';

    div.innerHTML = `<div class="col-ts">${escapeHtml(tsStr)}</div><div class="col-severity ${severityClass}">${escapeHtml(row.severity.toUpperCase())}</div><div class="col-service">${escapeHtml(row.service)}</div><div class="col-message">${escapeHtml(row.message)}</div>`;

    return div;
  }

  /**
   * Destroy the scroller (remove event listeners).
   */
  destroy() {
    this.scrollContainer.removeEventListener('scroll', this._onScroll);
    if (this.abortController) this.abortController.abort();
    if (this.rafId) cancelAnimationFrame(this.rafId);
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
