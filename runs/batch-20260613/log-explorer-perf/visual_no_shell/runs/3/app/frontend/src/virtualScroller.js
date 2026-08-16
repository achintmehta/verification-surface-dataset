/**
 * VirtualScroller - renders only visible rows in the DOM.
 *
 * Architecture:
 * - A tall spacer div sets the total scroll height (total * ROW_HEIGHT).
 * - A sticky container holds the visible row pool at the top of the viewport.
 * - translateY positions the pool at the correct visual offset.
 * - On scroll, we compute which rows should be visible,
 *   fetch them if needed, and update the DOM pool in-place.
 *
 * The row pool is bounded to OVERSCAN * 2 + viewport rows (~40-50 elements),
 * keeping DOM size constant regardless of corpus size.
 *
 * Cache: windows of FETCH_LIMIT rows keyed by window start offset.
 * Rows spanning two windows are assembled from both.
 */

import { fetchLogs } from './api.js';

const ROW_HEIGHT = 36;    // px, must match CSS --row-height
const OVERSCAN = 8;       // rows above/below viewport to pre-render
const FETCH_LIMIT = 100;  // rows per API request (well within 200 cap)
const MAX_CACHE = 30;     // max cached windows

export class VirtualScroller {
  constructor({ container, spacer, rowsContainer, onStatusChange }) {
    this.container = container;
    this.spacer = spacer;
    this.rowsContainer = rowsContainer;
    this.onStatusChange = onStatusChange || (() => {});

    // Filter state
    this.total = 0;
    this.severity = '';
    this.q = '';

    // Cache: Map<windowStart, row[]>
    this.cache = new Map();
    this.cacheOrder = [];

    // In-flight request tracking (prevents stale overwrites)
    this.pendingAbort = null;
    this.fetchVersion = 0;

    // DOM row pool
    this.rowPool = [];
    this.visibleStartOffset = 0;

    // Scroll state
    this.scrollRAF = null;

    this._bindEvents();
  }

  _bindEvents() {
    this.container.addEventListener('scroll', () => {
      if (this.scrollRAF) return;
      this.scrollRAF = requestAnimationFrame(() => {
        this.scrollRAF = null;
        this._onScroll();
      });
    }, { passive: true });
  }

  /**
   * Update filters and reset scroll position.
   * Cancels any in-flight request and fetches fresh data.
   */
  async setFilters({ severity, q }) {
    this.severity = severity;
    this.q = q;
    this.cache.clear();
    this.cacheOrder = [];
    this.total = 0;

    // Reset scroll
    this.container.scrollTop = 0;
    this.visibleStartOffset = 0;

    // Clear rows while loading
    this._clearRows();
    this.onStatusChange('loading');

    await this._fetchWindow(0, true);
  }

  _onScroll() {
    const scrollTop = this.container.scrollTop;
    const firstVisibleRow = Math.floor(scrollTop / ROW_HEIGHT);
    const startOffset = Math.max(0, firstVisibleRow - OVERSCAN);

    this._renderOrFetch(startOffset);
  }

  /**
   * Render from cache if available, otherwise fetch.
   */
  _renderOrFetch(startOffset) {
    const containerHeight = this.container.clientHeight;
    const visibleCount = Math.ceil(containerHeight / ROW_HEIGHT);
    const endOffset = Math.min(this.total, startOffset + visibleCount + OVERSCAN);

    // Check if all needed windows are cached
    const neededWindows = new Set();
    for (let i = startOffset; i < endOffset; i++) {
      neededWindows.add(Math.floor(i / FETCH_LIMIT) * FETCH_LIMIT);
    }

    const allCached = [...neededWindows].every(w => this.cache.has(w));

    if (allCached) {
      this._renderRows(startOffset);

      // Prefetch adjacent windows proactively
      this._prefetchAdjacent(startOffset, endOffset);
    } else {
      // Find the first uncached window and fetch it
      const firstUncached = [...neededWindows].find(w => !this.cache.has(w));
      if (firstUncached !== undefined) {
        this._fetchWindow(firstUncached, true);
      }
    }
  }

  /**
   * Prefetch windows adjacent to the current view (background, no abort).
   */
  _prefetchAdjacent(startOffset, endOffset) {
    // Prefetch next window
    const lastWindow = Math.floor((endOffset - 1) / FETCH_LIMIT) * FETCH_LIMIT;
    const nextWindow = lastWindow + FETCH_LIMIT;
    if (nextWindow < this.total && !this.cache.has(nextWindow)) {
      this._fetchWindowBackground(nextWindow);
    }

    // Prefetch previous window
    const firstWindow = Math.floor(startOffset / FETCH_LIMIT) * FETCH_LIMIT;
    const prevWindow = firstWindow - FETCH_LIMIT;
    if (prevWindow >= 0 && !this.cache.has(prevWindow)) {
      this._fetchWindowBackground(prevWindow);
    }
  }

  /**
   * Fetch a window, optionally cancelling the current in-flight request.
   * If primary=true, cancels existing request and triggers a render after.
   */
  async _fetchWindow(windowStart, primary = false) {
    const version = ++this.fetchVersion;

    if (primary) {
      if (this.pendingAbort) {
        this.pendingAbort.abort();
      }
      const controller = new AbortController();
      this.pendingAbort = controller;
      this.onStatusChange('loading');

      try {
        const data = await fetchLogs(
          { offset: windowStart, limit: FETCH_LIMIT, severity: this.severity, q: this.q },
          controller.signal
        );

        if (version !== this.fetchVersion) return; // stale
        this.pendingAbort = null;

        // Update total and spacer
        if (data.total !== this.total) {
          this.total = data.total;
          this._updateSpacerHeight();
        }

        this._storeWindow(windowStart, data.rows);

        // Render from current scroll position
        const scrollTop = this.container.scrollTop;
        const firstVisibleRow = Math.floor(scrollTop / ROW_HEIGHT);
        const renderStart = Math.max(0, firstVisibleRow - OVERSCAN);
        this._renderRows(renderStart);

        this.onStatusChange('ready');

        // Prefetch adjacent
        const containerHeight = this.container.clientHeight;
        const visibleCount = Math.ceil(containerHeight / ROW_HEIGHT);
        this._prefetchAdjacent(renderStart, renderStart + visibleCount + OVERSCAN);
      } catch (err) {
        if (err.name === 'AbortError') return;
        console.error('Fetch error:', err);
        this.onStatusChange('error', err.message);
      }
    }
  }

  /**
   * Background prefetch - no abort, no status update.
   */
  async _fetchWindowBackground(windowStart) {
    try {
      const data = await fetchLogs({
        offset: windowStart,
        limit: FETCH_LIMIT,
        severity: this.severity,
        q: this.q,
      });
      this._storeWindow(windowStart, data.rows);
    } catch (err) {
      // Background failures are silent
    }
  }

  _storeWindow(windowStart, rows) {
    if (!this.cache.has(windowStart)) {
      this.cacheOrder.push(windowStart);
    }
    this.cache.set(windowStart, rows);

    // Evict oldest windows if over limit
    while (this.cacheOrder.length > MAX_CACHE) {
      const oldest = this.cacheOrder.shift();
      this.cache.delete(oldest);
    }
  }

  _updateSpacerHeight() {
    this.spacer.style.height = `${this.total * ROW_HEIGHT}px`;
  }

  /**
   * Render the visible rows starting at startOffset.
   * Assembles rows from cache (may span two windows).
   * Uses a DOM pool: creates/reuses row elements.
   */
  _renderRows(startOffset) {
    const containerHeight = this.container.clientHeight;
    const visibleRowCount = Math.ceil(containerHeight / ROW_HEIGHT);
    const renderCount = visibleRowCount + OVERSCAN * 2;

    // Clamp to valid range
    const actualStart = Math.max(0, Math.min(startOffset, Math.max(0, this.total - renderCount)));
    const actualEnd = Math.min(this.total, actualStart + renderCount);
    const actualCount = actualEnd - actualStart;

    this.visibleStartOffset = actualStart;

    // Collect rows from cache
    const rows = new Array(actualCount);
    for (let i = 0; i < actualCount; i++) {
      const globalIdx = actualStart + i;
      const windowStart = Math.floor(globalIdx / FETCH_LIMIT) * FETCH_LIMIT;
      const windowRows = this.cache.get(windowStart);
      if (windowRows) {
        const localIdx = globalIdx - windowStart;
        rows[i] = windowRows[localIdx] || null;
      } else {
        rows[i] = null;
      }
    }

    // Grow pool if needed
    while (this.rowPool.length < actualCount) {
      const el = this._createRowElement();
      this.rowsContainer.appendChild(el);
      this.rowPool.push(el);
    }

    // Hide excess pool elements
    for (let i = actualCount; i < this.rowPool.length; i++) {
      if (this.rowPool[i].style.display !== 'none') {
        this.rowPool[i].style.display = 'none';
      }
    }

    // Position the rows container at the correct visual offset
    const topOffset = actualStart * ROW_HEIGHT;
    this.rowsContainer.style.transform = `translateY(${topOffset}px)`;

    // Update visible pool elements
    for (let i = 0; i < actualCount; i++) {
      const el = this.rowPool[i];
      const row = rows[i];
      if (el.style.display === 'none') el.style.display = 'flex';
      if (row) {
        this._updateRowElement(el, row);
      } else {
        this._setRowLoading(el);
      }
    }
  }

  _clearRows() {
    for (const el of this.rowPool) {
      el.style.display = 'none';
    }
    this.rowsContainer.style.transform = 'translateY(0)';
    this.spacer.style.height = '0px';
  }

  _createRowElement() {
    const el = document.createElement('div');
    el.className = 'log-row';
    // Pre-create child elements for fast updates (avoid innerHTML on each update)
    const tsEl = document.createElement('div');
    tsEl.className = 'row-ts';

    const severityEl = document.createElement('div');
    severityEl.className = 'row-severity';
    const badge = document.createElement('span');
    badge.className = 'severity-badge';
    severityEl.appendChild(badge);

    const serviceEl = document.createElement('div');
    serviceEl.className = 'row-service';

    const messageEl = document.createElement('div');
    messageEl.className = 'row-message';

    el.appendChild(tsEl);
    el.appendChild(severityEl);
    el.appendChild(serviceEl);
    el.appendChild(messageEl);

    return el;
  }

  _updateRowElement(el, row) {
    const severity = row.severity || 'info';

    // Only update className if changed (avoids style recalc)
    const expectedClass = `log-row severity-${severity}`;
    if (el.className !== expectedClass) {
      el.className = expectedClass;
    }

    const tsEl = el.children[0];
    const badge = el.children[1].children[0];
    const serviceEl = el.children[2];
    const messageEl = el.children[3];

    // Format timestamp
    const ts = new Date(row.ts);
    const formatted = this._formatTs(ts);
    if (tsEl.textContent !== formatted) {
      tsEl.textContent = formatted;
      tsEl.title = row.ts;
    }

    const badgeClass = `severity-badge ${severity}`;
    if (badge.className !== badgeClass) badge.className = badgeClass;
    if (badge.textContent !== severity) badge.textContent = severity;

    if (serviceEl.textContent !== row.service) {
      serviceEl.textContent = row.service || '';
      serviceEl.title = row.service || '';
    }

    if (messageEl.textContent !== row.message) {
      messageEl.textContent = row.message || '';
      messageEl.title = row.message || '';
    }
  }

  _setRowLoading(el) {
    if (el.className !== 'log-row loading') el.className = 'log-row loading';
    el.children[0].textContent = '—';
    el.children[1].children[0].textContent = '';
    el.children[2].textContent = '';
    el.children[3].textContent = '···';
  }

  _formatTs(date) {
    if (isNaN(date.getTime())) return '—';
    const y = date.getFullYear();
    const mo = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    const h = String(date.getHours()).padStart(2, '0');
    const mi = String(date.getMinutes()).padStart(2, '0');
    const s = String(date.getSeconds()).padStart(2, '0');
    return `${y}-${mo}-${d} ${h}:${mi}:${s}`;
  }

  getTotal() { return this.total; }
  getVisibleOffset() { return this.visibleStartOffset; }
}
