/**
 * Log Explorer - Virtualized log table with windowed API queries.
 *
 * Architecture:
 * - VirtualScroller manages scroll position → row offset mapping
 * - DataManager handles API fetching with a page cache, debouncing, and stale-response cancellation
 * - Rows are positioned absolutely within a tall container; only visible + overscan rows exist in DOM
 */

const API_BASE = '/api';
const ROW_HEIGHT = 28; // pixels per row
const OVERSCAN = 10; // extra rows above/below viewport
const PAGE_SIZE = 100; // rows per API fetch
const DEBOUNCE_MS = 250; // search debounce

// ─── Data Manager ──────────────────────────────────────────────────────────────

class DataManager {
  constructor() {
    /** @type {Map<number, Object[]>} page index → rows */
    this.pageCache = new Map();
    this.total = 0;
    this.filters = { severity: '', q: '' };
    this._fetchId = 0; // monotonic counter to detect stale responses
    this._inflightPages = new Set();
  }

  setFilters(filters) {
    this.filters = { ...filters };
    this.pageCache.clear();
    this._inflightPages.clear();
    this._fetchId++;
    this.total = 0;
  }

  /**
   * Get a row by its global index. Returns the row object or null if not yet loaded.
   */
  getRow(index) {
    const pageIdx = Math.floor(index / PAGE_SIZE);
    const page = this.pageCache.get(pageIdx);
    if (!page) return null;
    const localIdx = index - pageIdx * PAGE_SIZE;
    return page[localIdx] || null;
  }

  /**
   * Ensure pages covering [startRow, endRow) are fetched.
   * Returns a promise that resolves when all needed pages are loaded (or were cached).
   */
  async ensureRange(startRow, endRow, onUpdate) {
    const startPage = Math.floor(Math.max(0, startRow) / PAGE_SIZE);
    const endPage = Math.floor(Math.max(0, endRow - 1) / PAGE_SIZE);

    const fetches = [];
    for (let p = startPage; p <= endPage; p++) {
      if (!this.pageCache.has(p) && !this._inflightPages.has(p)) {
        fetches.push(this._fetchPage(p, onUpdate));
      }
    }

    if (fetches.length > 0) {
      await Promise.all(fetches);
    }
  }

  async _fetchPage(pageIdx, onUpdate) {
    const fetchId = this._fetchId;
    this._inflightPages.add(pageIdx);

    const offset = pageIdx * PAGE_SIZE;
    const params = new URLSearchParams({
      offset: String(offset),
      limit: String(PAGE_SIZE),
    });

    if (this.filters.severity) {
      params.set('severity', this.filters.severity);
    }
    if (this.filters.q) {
      params.set('q', this.filters.q);
    }

    try {
      const res = await fetch(`${API_BASE}/logs?${params}`);
      if (!res.ok) return;

      const data = await res.json();

      // Stale check: if filters changed since we started, discard
      if (fetchId !== this._fetchId) return;

      this.total = data.total;
      this.pageCache.set(pageIdx, data.rows);
      this._inflightPages.delete(pageIdx);

      if (onUpdate) onUpdate();
    } catch (err) {
      this._inflightPages.delete(pageIdx);
      console.error('[data] Fetch error:', err);
    }
  }

  /**
   * Fetch initial stats for badge counts.
   */
  async fetchStats() {
    const res = await fetch(`${API_BASE}/stats`);
    return res.json();
  }

  /**
   * Initial load: fetch first page and get total.
   */
  async initialLoad(onUpdate) {
    await this._fetchPage(0, onUpdate);
  }
}

// ─── Virtual Scroller ──────────────────────────────────────────────────────────

class VirtualScroller {
  constructor(containerEl, contentEl, dataManager) {
    this.container = containerEl;
    this.content = contentEl;
    this.data = dataManager;

    /** @type {Map<number, HTMLElement>} rowIndex → DOM element */
    this.renderedRows = new Map();
    this._rowPool = []; // recycled row elements
    this._rafId = null;
    this._lastStart = -1;
    this._lastEnd = -1;

    this.container.addEventListener('scroll', () => this._onScroll(), { passive: true });

    // ResizeObserver for viewport size changes
    this._resizeObserver = new ResizeObserver(() => this._scheduleRender());
    this._resizeObserver.observe(this.container);
  }

  /**
   * Called when total count changes (filter change, initial load).
   */
  updateTotal() {
    const totalHeight = this.data.total * ROW_HEIGHT;
    this.content.style.height = `${totalHeight}px`;
  }

  resetScroll() {
    this.container.scrollTop = 0;
    this._clearAllRows();
    this.updateTotal();
    this._scheduleRender();
  }

  _onScroll() {
    this._scheduleRender();
  }

  _scheduleRender() {
    if (this._rafId) return;
    this._rafId = requestAnimationFrame(() => {
      this._rafId = null;
      this._render();
    });
  }

  _render() {
    const scrollTop = this.container.scrollTop;
    const viewportHeight = this.container.clientHeight;
    const total = this.data.total;

    if (total === 0) {
      this._clearAllRows();
      this._lastStart = -1;
      this._lastEnd = -1;
      return;
    }

    // Calculate visible range
    const rawStart = Math.floor(scrollTop / ROW_HEIGHT);
    const rawEnd = Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT);

    // Add overscan
    const startRow = Math.max(0, rawStart - OVERSCAN);
    const endRow = Math.min(total, rawEnd + OVERSCAN);

    // Remove rows that are now outside the range
    for (const [idx, el] of this.renderedRows) {
      if (idx < startRow || idx >= endRow) {
        this.renderedRows.delete(idx);
        el.style.display = 'none';
        this._rowPool.push(el);
      }
    }

    // Add/update rows in the visible range
    let hasMissing = false;
    for (let i = startRow; i < endRow; i++) {
      const rowData = this.data.getRow(i);
      if (!rowData) {
        hasMissing = true;
        continue;
      }

      if (this.renderedRows.has(i)) {
        // Already rendered — no update needed (data is immutable per index within a filter set)
        continue;
      }

      const el = this._acquireRow();
      this._populateRow(el, rowData, i);
      this.renderedRows.set(i, el);
    }

    // Fetch missing data
    if (hasMissing) {
      this.data.ensureRange(startRow, endRow, () => {
        this.updateTotal();
        this._scheduleRender();
        updateRowCount();
      });
    }

    this._lastStart = startRow;
    this._lastEnd = endRow;
  }

  _acquireRow() {
    if (this._rowPool.length > 0) {
      const el = this._rowPool.pop();
      el.style.display = '';
      return el;
    }

    // Create new row element
    const el = document.createElement('div');
    el.className = 'log-row';
    el.innerHTML = `
      <div class="col col-ts"></div>
      <div class="col col-severity"></div>
      <div class="col col-service"></div>
      <div class="col col-message"></div>
    `;
    this.content.appendChild(el);
    return el;
  }

  _populateRow(el, row, index) {
    const children = el.children;

    // Timestamp
    const ts = new Date(row.ts);
    children[0].textContent = formatTimestamp(ts);

    // Severity badge
    children[1].innerHTML = `<span class="severity-badge ${row.severity}">${row.severity}</span>`;

    // Service
    children[2].textContent = row.service;

    // Message
    children[3].textContent = row.message;
    children[3].title = row.message;

    // Position
    el.style.top = `${index * ROW_HEIGHT}px`;
    el.style.height = `${ROW_HEIGHT}px`;
  }

  _clearAllRows() {
    for (const [idx, el] of this.renderedRows) {
      el.style.display = 'none';
      this._rowPool.push(el);
    }
    this.renderedRows.clear();
  }
}

// ─── Utilities ─────────────────────────────────────────────────────────────────

function formatTimestamp(date) {
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  const ms = String(date.getMilliseconds()).padStart(3, '0');
  return `${y}-${mo}-${d} ${h}:${mi}:${s}.${ms}`;
}

function debounce(fn, ms) {
  let timer = null;
  return function (...args) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn.apply(this, args);
    }, ms);
  };
}

// ─── App Init ──────────────────────────────────────────────────────────────────

const dataManager = new DataManager();
let scroller = null;
let stats = null;

const rowCountEl = document.getElementById('row-count');
const severitySelect = document.getElementById('severity-filter');
const searchInput = document.getElementById('search-input');
const scrollerEl = document.getElementById('virtual-scroller');
const contentEl = document.getElementById('scroll-content');

function updateRowCount() {
  const total = dataManager.total;
  const visible = scroller ? scroller.renderedRows.size : 0;
  rowCountEl.textContent = `${visible} of ${total.toLocaleString()} entries`;
}

async function applyFilters() {
  const severity = severitySelect.value;
  const q = searchInput.value;

  dataManager.setFilters({ severity, q });
  scroller.resetScroll();

  // Fetch first page with new filters
  await dataManager.initialLoad(() => {
    scroller.updateTotal();
    scroller._scheduleRender();
    updateRowCount();
  });

  scroller.updateTotal();
  scroller._scheduleRender();
  updateRowCount();
}

// Severity change: immediate
severitySelect.addEventListener('change', () => {
  applyFilters();
});

// Search: debounced
const debouncedSearch = debounce(() => {
  applyFilters();
}, DEBOUNCE_MS);

searchInput.addEventListener('input', () => {
  debouncedSearch();
});

// Boot
async function boot() {
  scroller = new VirtualScroller(scrollerEl, contentEl, dataManager);

  // Load stats
  try {
    stats = await dataManager.fetchStats();
  } catch (e) {
    console.warn('[app] Could not fetch stats:', e);
  }

  // Initial data load
  await dataManager.initialLoad(() => {
    scroller.updateTotal();
    scroller._scheduleRender();
    updateRowCount();
  });

  scroller.updateTotal();
  scroller._scheduleRender();
  updateRowCount();
}

boot().catch((err) => {
  console.error('[app] Boot error:', err);
  rowCountEl.textContent = 'Error loading data';
});
