import { fetchLogs } from './api.js';

const ROW_HEIGHT = 28;
const OVERSCAN = 10;       // extra rows above/below viewport
const FETCH_LIMIT = 100;   // rows per API fetch (within 200 cap)

/**
 * VirtualScroller manages:
 * - A cache of fetched row windows
 * - DOM row pool (create/recycle)
 * - Mapping scroll position -> data offset -> rendered rows
 */
export class VirtualScroller {
  constructor({ scrollerEl, spacerEl, containerEl, onTotalChange }) {
    this.scrollerEl = scrollerEl;
    this.spacerEl = spacerEl;
    this.containerEl = containerEl;
    this.onTotalChange = onTotalChange;

    this.total = 0;
    this.filters = { severity: '', q: '' };
    
    // Row cache: Map<offset, row data>
    this.cache = new Map();
    
    // DOM pool (unused elements)
    this.rowPool = [];
    // Active rows: offset -> DOM element
    this.activeRows = new Map();

    // Track in-flight fetches: key "offset:limit" -> true
    this.pendingFetches = new Set();
    
    // Request versioning for stale response rejection
    this.filterVersion = 0;
    
    // Current AbortController for cancelling stale requests
    this.abortController = null;

    // Scroll handler with rAF throttle
    this._scrollRAF = null;
    this.scrollerEl.addEventListener('scroll', () => {
      if (this._scrollRAF) return;
      this._scrollRAF = requestAnimationFrame(() => {
        this._scrollRAF = null;
        this._onScroll();
      });
    });
  }

  /**
   * Set filters and reload. Called from outside.
   */
  async setFilters(filters) {
    this.filters = { ...this.filters, ...filters };
    this.filterVersion++;
    const version = this.filterVersion;
    
    // Cancel any in-flight requests
    if (this.abortController) {
      this.abortController.abort();
    }
    this.abortController = new AbortController();
    
    // Clear cache and active rows
    this.cache.clear();
    this.pendingFetches.clear();
    this._recycleAllRows();
    
    // Reset scroll
    this.scrollerEl.scrollTop = 0;
    
    // Fetch first window to get total
    try {
      const result = await fetchLogs(
        { offset: 0, limit: FETCH_LIMIT, ...this.filters },
        this.abortController.signal
      );
      
      // Check for staleness
      if (version !== this.filterVersion) return;
      
      this.total = result.total;
      this._updateSpacerHeight();
      
      // Cache fetched rows
      for (let i = 0; i < result.rows.length; i++) {
        this.cache.set(i, result.rows[i]);
      }
      
      this.onTotalChange(this.total);
      this._render();
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.error('Failed to fetch logs:', err);
    }
  }

  _updateSpacerHeight() {
    this.spacerEl.style.height = `${this.total * ROW_HEIGHT}px`;
  }

  _onScroll() {
    this._render();
  }

  _recycleAllRows() {
    for (const [offset, el] of this.activeRows) {
      el.style.display = 'none';
      this.rowPool.push(el);
    }
    this.activeRows.clear();
  }

  _render() {
    const scrollTop = this.scrollerEl.scrollTop;
    const viewportHeight = this.scrollerEl.clientHeight;

    if (this.total === 0) {
      this._recycleAllRows();
      return;
    }

    const firstVisible = Math.floor(scrollTop / ROW_HEIGHT);
    const lastVisible = Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT);

    const renderStart = Math.max(0, firstVisible - OVERSCAN);
    const renderEnd = Math.min(this.total, lastVisible + OVERSCAN);

    // Recycle rows that are out of range
    const toRecycle = [];
    for (const [offset, el] of this.activeRows) {
      if (offset < renderStart || offset >= renderEnd) {
        toRecycle.push(offset);
      }
    }
    for (const offset of toRecycle) {
      const el = this.activeRows.get(offset);
      this.activeRows.delete(offset);
      el.style.display = 'none';
      this.rowPool.push(el);
    }

    // Determine which ranges we need to fetch
    const fetchNeeded = [];

    // Render rows that are in range and have data
    for (let i = renderStart; i < renderEnd; i++) {
      const data = this.cache.get(i);
      
      if (!data) {
        // Mark as needing fetch
        fetchNeeded.push(i);
        continue;
      }

      if (this.activeRows.has(i)) {
        // Already rendered, just update position
        const el = this.activeRows.get(i);
        el.style.transform = `translateY(${i * ROW_HEIGHT}px)`;
      } else {
        // Create/recycle a row
        const el = this._getOrCreateRow();
        this._populateRow(el, data);
        el.style.transform = `translateY(${i * ROW_HEIGHT}px)`;
        el.style.display = 'flex';
        this.activeRows.set(i, el);
      }
    }

    // Fire off fetches for missing data (coalesce into chunks)
    if (fetchNeeded.length > 0) {
      this._fetchMissing(fetchNeeded);
    }
  }

  _fetchMissing(offsets) {
    // Group into aligned FETCH_LIMIT chunks
    const chunks = new Set();
    for (const offset of offsets) {
      const chunkStart = Math.floor(offset / FETCH_LIMIT) * FETCH_LIMIT;
      chunks.add(chunkStart);
    }

    for (const chunkStart of chunks) {
      const key = `${chunkStart}`;
      if (this.pendingFetches.has(key)) continue;
      this.pendingFetches.add(key);

      const version = this.filterVersion;
      const limit = Math.min(FETCH_LIMIT, this.total - chunkStart);

      fetchLogs(
        { offset: chunkStart, limit, ...this.filters },
        this.abortController?.signal
      ).then(result => {
        this.pendingFetches.delete(key);
        
        // Reject stale responses
        if (version !== this.filterVersion) return;

        // Cache the rows
        for (let i = 0; i < result.rows.length; i++) {
          this.cache.set(chunkStart + i, result.rows[i]);
        }

        // Re-render to show newly available data
        this._renderCached();
      }).catch(err => {
        this.pendingFetches.delete(key);
        if (err.name === 'AbortError') return;
        console.error('Fetch error:', err);
      });
    }
  }

  /**
   * Like _render but only fills in rows that have data.
   * Does NOT trigger new fetches (avoids recursion).
   */
  _renderCached() {
    const scrollTop = this.scrollerEl.scrollTop;
    const viewportHeight = this.scrollerEl.clientHeight;

    if (this.total === 0) return;

    const firstVisible = Math.floor(scrollTop / ROW_HEIGHT);
    const lastVisible = Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT);

    const renderStart = Math.max(0, firstVisible - OVERSCAN);
    const renderEnd = Math.min(this.total, lastVisible + OVERSCAN);

    // Recycle out-of-range rows
    const toRecycle = [];
    for (const [offset, el] of this.activeRows) {
      if (offset < renderStart || offset >= renderEnd) {
        toRecycle.push(offset);
      }
    }
    for (const offset of toRecycle) {
      const el = this.activeRows.get(offset);
      this.activeRows.delete(offset);
      el.style.display = 'none';
      this.rowPool.push(el);
    }

    // Fill in newly available data
    for (let i = renderStart; i < renderEnd; i++) {
      if (this.activeRows.has(i)) continue;
      
      const data = this.cache.get(i);
      if (!data) continue;

      const el = this._getOrCreateRow();
      this._populateRow(el, data);
      el.style.transform = `translateY(${i * ROW_HEIGHT}px)`;
      el.style.display = 'flex';
      this.activeRows.set(i, el);
    }
  }

  _getOrCreateRow() {
    if (this.rowPool.length > 0) {
      return this.rowPool.pop();
    }

    const row = document.createElement('div');
    row.className = 'log-row';
    row.innerHTML = `
      <div class="col col-ts"></div>
      <div class="col col-severity"></div>
      <div class="col col-service"></div>
      <div class="col col-message"></div>
    `;
    row.style.position = 'absolute';
    row.style.left = '0';
    row.style.right = '0';
    row.style.height = `${ROW_HEIGHT}px`;
    this.containerEl.appendChild(row);
    return row;
  }

  _populateRow(el, data) {
    const cols = el.children;
    
    // Timestamp - format nicely
    const ts = new Date(data.ts);
    cols[0].textContent = ts.toISOString().replace('T', ' ').slice(0, 23);
    
    // Severity
    cols[1].textContent = data.severity.toUpperCase();
    cols[1].className = `col col-severity severity-${data.severity}`;
    
    // Service
    cols[2].textContent = data.service;
    
    // Message
    cols[3].textContent = data.message;
  }

  /**
   * Get count of DOM rows currently active
   */
  getActiveDOMCount() {
    return this.activeRows.size;
  }
}
