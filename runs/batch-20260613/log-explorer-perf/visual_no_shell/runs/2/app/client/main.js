/**
 * Log Explorer - Virtualized Frontend
 *
 * Architecture:
 * - VirtualScroller: manages the DOM pool, maps scroll position → row offset,
 *   fetches windows of rows from the API, recycles DOM nodes.
 * - FilterState: holds current severity + search query, debounces search.
 * - ApiClient: wraps fetch with request cancellation (AbortController).
 */

const API_BASE = 'http://localhost:3001/api';
const ROW_HEIGHT = 36;          // px, must match CSS --row-height
const WINDOW_SIZE = 100;        // rows fetched per API call (≤ 200)
const OVERSCAN = 5;             // extra rows above/below viewport
const DEBOUNCE_MS = 300;        // search debounce delay

// ─── Utility ────────────────────────────────────────────────────────────────

function debounce(fn, delay) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

function formatTs(tsStr) {
  // Format: 2024-01-15 14:32:07.123
  const d = new Date(tsStr);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
         `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.` +
         `${pad(d.getMilliseconds(), 3)}`;
}

// ─── API Client ─────────────────────────────────────────────────────────────

class ApiClient {
  constructor(base) {
    this.base = base;
    this._abortController = null;
  }

  async fetchLogs({ offset, limit, severity, q }) {
    // Cancel any in-flight request
    if (this._abortController) {
      this._abortController.abort();
    }
    this._abortController = new AbortController();

    const params = new URLSearchParams({ offset, limit });
    if (severity) params.set('severity', severity);
    if (q)        params.set('q', q);

    const url = `${this.base}/logs?${params}`;
    const res = await fetch(url, { signal: this._abortController.signal });
    if (!res.ok) throw new Error(`API error ${res.status}`);
    return res.json();
  }

  async fetchStats() {
    const res = await fetch(`${this.base}/stats`);
    if (!res.ok) throw new Error(`Stats API error ${res.status}`);
    return res.json();
  }
}

// ─── Virtual Scroller ────────────────────────────────────────────────────────

class VirtualScroller {
  constructor({ container, spacer, rowsEl, rowHeight, overscan, onFetchWindow }) {
    this.container   = container;
    this.spacer      = spacer;
    this.rowsEl      = rowsEl;
    this.rowHeight   = rowHeight;
    this.overscan    = overscan;
    this.onFetchWindow = onFetchWindow;

    this.total       = 0;
    this.rows        = [];       // currently loaded rows
    this.loadedOffset = -1;      // offset of first loaded row
    this.loadedCount  = 0;       // number of loaded rows

    this._scrollRAF  = null;
    this._lastScrollTop = 0;

    this.container.addEventListener('scroll', this._onScroll.bind(this), { passive: true });
  }

  setTotal(total) {
    this.total = total;
    // Update spacer height to represent full corpus
    this.spacer.style.height = `${total * this.rowHeight}px`;
  }

  setRows(rows, offset) {
    this.rows = rows;
    this.loadedOffset = offset;
    this.loadedCount = rows.length;
    this._render();
  }

  reset() {
    this.total = 0;
    this.rows = [];
    this.loadedOffset = -1;
    this.loadedCount = 0;
    this.container.scrollTop = 0;
    this._lastScrollTop = 0;
    this.spacer.style.height = '0px';
    this.rowsEl.innerHTML = '';
  }

  _onScroll() {
    if (this._scrollRAF) return;
    this._scrollRAF = requestAnimationFrame(() => {
      this._scrollRAF = null;
      const scrollTop = this.container.scrollTop;
      if (Math.abs(scrollTop - this._lastScrollTop) < 1) return;
      this._lastScrollTop = scrollTop;
      this._checkAndFetch(scrollTop);
    });
  }

  _checkAndFetch(scrollTop) {
    const viewportHeight = this.container.clientHeight;
    const firstVisible = Math.floor(scrollTop / this.rowHeight);
    const lastVisible  = Math.min(
      this.total - 1,
      Math.ceil((scrollTop + viewportHeight) / this.rowHeight)
    );

    const fetchStart = Math.max(0, firstVisible - this.overscan);
    const fetchEnd   = Math.min(this.total - 1, lastVisible + this.overscan);

    // Check if current window covers the visible range
    const windowStart = this.loadedOffset;
    const windowEnd   = this.loadedOffset + this.loadedCount - 1;

    const covered = (
      this.loadedOffset >= 0 &&
      fetchStart >= windowStart &&
      fetchEnd   <= windowEnd
    );

    if (!covered) {
      this.onFetchWindow(fetchStart);
    } else {
      // Just re-render with current data
      this._render();
    }
  }

  _render() {
    const scrollTop = this.container.scrollTop;
    const viewportHeight = this.container.clientHeight;

    if (this.total === 0 || this.rows.length === 0) {
      this.rowsEl.innerHTML = '';
      return;
    }

    const firstVisible = Math.floor(scrollTop / this.rowHeight);
    const lastVisible  = Math.min(
      this.total - 1,
      Math.ceil((scrollTop + viewportHeight) / this.rowHeight)
    );

    const renderStart = Math.max(0, firstVisible - this.overscan);
    const renderEnd   = Math.min(this.total - 1, lastVisible + this.overscan);

    // Map render indices to loaded rows
    const windowStart = this.loadedOffset;
    const windowEnd   = this.loadedOffset + this.loadedCount - 1;

    const clampedStart = Math.max(renderStart, windowStart);
    const clampedEnd   = Math.min(renderEnd, windowEnd);

    if (clampedStart > clampedEnd) {
      this.rowsEl.innerHTML = '';
      return;
    }

    // Position the rows container at the correct offset
    const topOffset = clampedStart * this.rowHeight;
    this.rowsEl.style.transform = `translateY(${topOffset}px)`;

    // Build DOM
    const fragment = document.createDocumentFragment();
    for (let i = clampedStart; i <= clampedEnd; i++) {
      const rowData = this.rows[i - windowStart];
      if (!rowData) continue;
      const el = this._buildRow(rowData);
      fragment.appendChild(el);
    }

    this.rowsEl.innerHTML = '';
    this.rowsEl.appendChild(fragment);
  }

  _buildRow(row) {
    const el = document.createElement('div');
    el.className = `log-row severity-${row.severity}`;

    const ts = document.createElement('div');
    ts.className = 'col-ts';
    ts.textContent = formatTs(row.ts);

    const sev = document.createElement('div');
    sev.className = 'col-severity';
    const pill = document.createElement('span');
    pill.className = `severity-pill ${row.severity}`;
    pill.textContent = row.severity;
    sev.appendChild(pill);

    const svc = document.createElement('div');
    svc.className = 'col-service';
    svc.textContent = row.service;
    svc.title = row.service;

    const msg = document.createElement('div');
    msg.className = 'col-message';
    msg.textContent = row.message;
    msg.title = row.message;

    el.appendChild(ts);
    el.appendChild(sev);
    el.appendChild(svc);
    el.appendChild(msg);

    return el;
  }

  // Force re-render at current scroll position
  refresh() {
    this._render();
  }

  // Trigger a fetch check from outside (e.g. after filter change)
  triggerFetch() {
    this._checkAndFetch(this.container.scrollTop);
  }
}

// ─── App ─────────────────────────────────────────────────────────────────────

class LogExplorer {
  constructor() {
    this.api = new ApiClient(API_BASE);

    // State
    this.severity = '';
    this.query    = '';
    this.total    = 0;
    this._requestSeq = 0;  // monotonic counter to detect stale responses

    // DOM refs
    this.scrollContainer = document.getElementById('scroll-container');
    this.spacer          = document.getElementById('scroll-spacer');
    this.virtualRowsEl   = document.getElementById('virtual-rows');
    this.loadingOverlay  = document.getElementById('loading-overlay');
    this.emptyState      = document.getElementById('empty-state');
    this.countDisplay    = document.getElementById('count-display');
    this.severityFilter  = document.getElementById('severity-filter');
    this.searchInput     = document.getElementById('search-input');
    this.searchClear     = document.getElementById('search-clear');
    this.statTotal       = document.getElementById('stat-total');
    this.badgeDebug      = document.getElementById('badge-debug');
    this.badgeInfo       = document.getElementById('badge-info');
    this.badgeWarn       = document.getElementById('badge-warn');
    this.badgeError      = document.getElementById('badge-error');

    // Virtual scroller
    this.scroller = new VirtualScroller({
      container:   this.scrollContainer,
      spacer:      this.spacer,
      rowsEl:      this.virtualRowsEl,
      rowHeight:   ROW_HEIGHT,
      overscan:    OVERSCAN,
      onFetchWindow: (offset) => this._fetchWindow(offset),
    });

    this._bindEvents();
    this._init();
  }

  _bindEvents() {
    this.severityFilter.addEventListener('change', () => {
      this.severity = this.severityFilter.value;
      this._resetAndFetch();
    });

    const debouncedSearch = debounce((value) => {
      this.query = value;
      this._resetAndFetch();
    }, DEBOUNCE_MS);

    this.searchInput.addEventListener('input', (e) => {
      const value = e.target.value;
      this.searchClear.style.display = value ? 'block' : 'none';
      debouncedSearch(value);
    });

    this.searchClear.addEventListener('click', () => {
      this.searchInput.value = '';
      this.searchClear.style.display = 'none';
      this.query = '';
      this._resetAndFetch();
    });
  }

  async _init() {
    this._showLoading(true);
    try {
      // Load stats for badges
      const stats = await this.api.fetchStats();
      this._updateStats(stats);
      // Initial fetch
      await this._resetAndFetch();
    } catch (err) {
      console.error('Init error:', err);
      this._showLoading(false);
    }
  }

  async _resetAndFetch() {
    this.scroller.reset();
    this._showLoading(true);
    this._showEmpty(false);
    await this._fetchWindow(0);
  }

  async _fetchWindow(offset) {
    const seq = ++this._requestSeq;
    const { severity, query } = this;

    // Clamp offset
    const clampedOffset = Math.max(0, offset);

    try {
      const data = await this.api.fetchLogs({
        offset: clampedOffset,
        limit:  WINDOW_SIZE,
        severity: severity || undefined,
        q:      query || undefined,
      });

      // Stale response check
      if (seq !== this._requestSeq) return;

      this.total = data.total;
      this.scroller.setTotal(data.total);
      this.scroller.setRows(data.rows, clampedOffset);

      this._updateCountDisplay(data.total);
      this._showLoading(false);
      this._showEmpty(data.total === 0);

    } catch (err) {
      if (err.name === 'AbortError') return; // cancelled, ignore
      console.error('Fetch error:', err);
      if (seq === this._requestSeq) {
        this._showLoading(false);
      }
    }
  }

  _updateStats(stats) {
    this.statTotal.textContent = `${stats.total.toLocaleString()} total logs`;
    this.badgeDebug.textContent = `Debug: ${stats.bySeverity.debug.toLocaleString()}`;
    this.badgeInfo.textContent  = `Info: ${stats.bySeverity.info.toLocaleString()}`;
    this.badgeWarn.textContent  = `Warn: ${stats.bySeverity.warn.toLocaleString()}`;
    this.badgeError.textContent = `Error: ${stats.bySeverity.error.toLocaleString()}`;
  }

  _updateCountDisplay(total) {
    const filterDesc = [];
    if (this.severity) filterDesc.push(`severity=${this.severity}`);
    if (this.query)    filterDesc.push(`q="${this.query}"`);

    if (filterDesc.length > 0) {
      this.countDisplay.textContent = `${total.toLocaleString()} of ${this.total.toLocaleString()} rows (filtered)`;
    } else {
      this.countDisplay.textContent = `${total.toLocaleString()} rows`;
    }
  }

  _showLoading(show) {
    this.loadingOverlay.classList.toggle('hidden', !show);
  }

  _showEmpty(show) {
    this.emptyState.style.display = show ? 'flex' : 'none';
  }
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  new LogExplorer();
});
