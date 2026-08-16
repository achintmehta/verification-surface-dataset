/**
 * VirtualScroller
 *
 * Manages a fixed-height scroll container where only the visible rows
 * (plus overscan) exist in the DOM. Rows are fetched in windows from
 * the server and cached by window index.
 *
 * Architecture:
 * - The scroll container has a tall spacer div that gives it the correct
 *   total scroll height (total * ROW_HEIGHT).
 * - A sticky "virtual-rows" div sits at top:0 and is translated via
 *   CSS transform to appear at the correct scroll position.
 * - On scroll, we compute which rows are visible, fetch the window if
 *   not cached, and render only those rows.
 */

import { fetchLogs } from './api.js';

const ROW_HEIGHT = 36;       // must match --row-height in CSS
const WINDOW_SIZE = 100;     // rows per server fetch
const OVERSCAN = 5;          // extra rows above/below viewport
const CACHE_MAX_WINDOWS = 20; // LRU cache size (windows)

function formatTs(isoString) {
  // Format: 2024-01-15 14:32:07.123
  const d = new Date(isoString);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ` +
         `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
         `.${pad(d.getMilliseconds(), 3)}`;
}

function createRowEl() {
  const row = document.createElement('div');
  row.className = 'log-row';
  row.innerHTML = `
    <div class="cell-ts"></div>
    <div class="cell-severity"><span class="severity-badge"></span></div>
    <div class="cell-service"></div>
    <div class="cell-message"></div>
  `;
  return row;
}

function updateRowEl(el, data) {
  el.className = `log-row severity-${data.severity}`;
  el.querySelector('.cell-ts').textContent = formatTs(data.ts);
  const badge = el.querySelector('.severity-badge');
  badge.className = `severity-badge ${data.severity}`;
  badge.textContent = data.severity;
  el.querySelector('.cell-service').textContent = data.service;
  el.querySelector('.cell-message').textContent = data.message;
}

/**
 * Simple LRU cache keyed by window index.
 * Each entry: { rows: Array, promise: Promise|null }
 */
class WindowCache {
  constructor(maxSize) {
    this.maxSize = maxSize;
    this.map = new Map(); // key -> { rows, accessTime }
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return null;
    entry.accessTime = Date.now();
    return entry.rows;
  }

  set(key, rows) {
    if (this.map.has(key)) {
      this.map.get(key).rows = rows;
      this.map.get(key).accessTime = Date.now();
      return;
    }
    // Evict LRU if at capacity
    if (this.map.size >= this.maxSize) {
      let oldest = null;
      let oldestTime = Infinity;
      for (const [k, v] of this.map) {
        if (v.accessTime < oldestTime) {
          oldestTime = v.accessTime;
          oldest = k;
        }
      }
      if (oldest !== null) this.map.delete(oldest);
    }
    this.map.set(key, { rows, accessTime: Date.now() });
  }

  clear() {
    this.map.clear();
  }
}

export class VirtualScroller {
  constructor({ container, spacer, rowsContainer, onLoadingChange }) {
    this.container = container;
    this.spacer = spacer;
    this.rowsContainer = rowsContainer;
    this.onLoadingChange = onLoadingChange || (() => {});

    this.total = 0;
    this.severity = '';
    this.q = '';

    this.cache = new WindowCache(CACHE_MAX_WINDOWS);
    this.pendingFetches = new Map(); // windowIdx -> AbortController
    this.currentFetchController = null; // for the active render fetch

    // Pool of DOM row elements
    this.rowPool = [];
    this.renderedRows = []; // { el, rowIdx }

    // Scroll state
    this.lastScrollTop = 0;
    this.rafPending = false;
    this.renderVersion = 0; // incremented on filter change

    this._onScroll = this._onScroll.bind(this);
    container.addEventListener('scroll', this._onScroll, { passive: true });
  }

  /**
   * Update filters and total. Resets scroll position and clears cache.
   */
  setParams({ total, severity, q }) {
    this.total = total;
    this.severity = severity;
    this.q = q;
    this.renderVersion++;

    // Cancel all pending fetches
    for (const ctrl of this.pendingFetches.values()) {
      ctrl.abort();
    }
    this.pendingFetches.clear();

    this.cache.clear();

    // Reset scroll
    this.container.scrollTop = 0;
    this.lastScrollTop = 0;

    // Update spacer height
    this.spacer.style.height = `${this.total * ROW_HEIGHT}px`;

    // Render immediately
    this._scheduleRender();
  }

  _onScroll() {
    this.lastScrollTop = this.container.scrollTop;
    this._scheduleRender();
  }

  _scheduleRender() {
    if (this.rafPending) return;
    this.rafPending = true;
    requestAnimationFrame(() => {
      this.rafPending = false;
      this._render();
    });
  }

  _getViewport() {
    const scrollTop = this.container.scrollTop;
    const viewportHeight = this.container.clientHeight;
    const firstVisible = Math.floor(scrollTop / ROW_HEIGHT);
    const lastVisible = Math.min(
      Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT),
      this.total - 1
    );
    const firstRow = Math.max(0, firstVisible - OVERSCAN);
    const lastRow = Math.min(this.total - 1, lastVisible + OVERSCAN);
    return { scrollTop, firstRow, lastRow };
  }

  _windowIdxFor(rowIdx) {
    return Math.floor(rowIdx / WINDOW_SIZE);
  }

  _windowOffset(windowIdx) {
    return windowIdx * WINDOW_SIZE;
  }

  async _fetchWindow(windowIdx, version) {
    if (this.pendingFetches.has(windowIdx)) {
      return; // already in flight
    }

    const ctrl = new AbortController();
    this.pendingFetches.set(windowIdx, ctrl);

    try {
      const result = await fetchLogs({
        offset: this._windowOffset(windowIdx),
        limit: WINDOW_SIZE,
        severity: this.severity,
        q: this.q,
      }, ctrl.signal);

      // Check if still relevant
      if (version !== this.renderVersion) return;

      this.cache.set(windowIdx, result.rows);
      this.pendingFetches.delete(windowIdx);

      // Re-render now that we have data
      this._render();
    } catch (err) {
      this.pendingFetches.delete(windowIdx);
      if (err.name !== 'AbortError') {
        console.error('[VirtualScroller] fetch error:', err);
      }
    }
  }

  _getOrFetchRow(rowIdx, version) {
    const windowIdx = this._windowIdxFor(rowIdx);
    const cached = this.cache.get(windowIdx);
    if (cached) {
      const localIdx = rowIdx - this._windowOffset(windowIdx);
      return cached[localIdx] || null;
    }
    // Trigger fetch (non-blocking)
    this._fetchWindow(windowIdx, version);
    return null; // not yet available
  }

  _acquireRowEl() {
    if (this.rowPool.length > 0) return this.rowPool.pop();
    return createRowEl();
  }

  _releaseRowEl(el) {
    // Remove from DOM if still attached
    if (el.parentNode) el.remove();
    this.rowPool.push(el);
  }

  _prefetchAdjacent(firstRow, lastRow, version) {
    // Prefetch the window just before and just after the visible range
    const firstWindow = this._windowIdxFor(Math.max(0, firstRow - WINDOW_SIZE));
    const lastWindow  = this._windowIdxFor(Math.min(this.total - 1, lastRow + WINDOW_SIZE));

    if (!this.cache.get(firstWindow) && !this.pendingFetches.has(firstWindow)) {
      this._fetchWindow(firstWindow, version);
    }
    if (lastWindow !== firstWindow && !this.cache.get(lastWindow) && !this.pendingFetches.has(lastWindow)) {
      this._fetchWindow(lastWindow, version);
    }
  }

  _render() {
    if (this.total === 0) {
      // Clear all rows
      for (const { el } of this.renderedRows) {
        this._releaseRowEl(el);
      }
      this.renderedRows = [];
      this.rowsContainer.style.transform = 'translateY(0)';
      this.rowsContainer.replaceChildren();
      return;
    }

    const version = this.renderVersion;
    const { firstRow, lastRow } = this._getViewport();

    // Position the rows container at the correct scroll offset
    const translateY = firstRow * ROW_HEIGHT;
    this.rowsContainer.style.transform = `translateY(${translateY}px)`;
    // Note: we use transform (not top) for GPU-accelerated positioning

    // Build map of currently rendered rows
    const renderedMap = new Map();
    for (const item of this.renderedRows) {
      renderedMap.set(item.rowIdx, item.el);
    }

    // Determine which rows to keep, release, and add
    const newItems = [];
    let hasPlaceholders = false;

    for (let rowIdx = firstRow; rowIdx <= lastRow; rowIdx++) {
      if (renderedMap.has(rowIdx)) {
        // Keep existing element
        const el = renderedMap.get(rowIdx);
        renderedMap.delete(rowIdx); // mark as used
        newItems.push({ el, rowIdx });
      } else {
        // Need a new element
        const data = this._getOrFetchRow(rowIdx, version);
        const el = this._acquireRowEl();

        if (data) {
          updateRowEl(el, data);
        } else {
          // Placeholder while loading
          el.className = 'log-row loading-placeholder';
          el.querySelector('.cell-ts').textContent = '—';
          const badge = el.querySelector('.severity-badge');
          badge.className = 'severity-badge';
          badge.textContent = '';
          el.querySelector('.cell-service').textContent = '';
          el.querySelector('.cell-message').textContent = 'Loading...';
          hasPlaceholders = true;
        }

        newItems.push({ el, rowIdx });
      }
    }

    // Release rows that went out of range (still in renderedMap)
    for (const el of renderedMap.values()) {
      this._releaseRowEl(el);
    }

    // Rebuild DOM in correct order using replaceChildren
    this.rowsContainer.replaceChildren(...newItems.map(i => i.el));

    this.renderedRows = newItems;

    // Prefetch adjacent windows for smoother scrolling
    this._prefetchAdjacent(firstRow, lastRow, version);

    // Notify loading state
    this.onLoadingChange(hasPlaceholders);
  }

  destroy() {
    this.container.removeEventListener('scroll', this._onScroll);
    for (const ctrl of this.pendingFetches.values()) {
      ctrl.abort();
    }
  }
}
