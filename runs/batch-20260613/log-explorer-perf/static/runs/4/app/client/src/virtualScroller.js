/**
 * VirtualScroller
 *
 * Manages a fixed-height viewport with a spacer that sets the total scroll
 * height. Only the rows intersecting the visible window (plus overscan) are
 * rendered in the DOM. Rows are fetched in pages and cached; the cache is
 * bounded to avoid unbounded memory growth.
 *
 * Architecture:
 *  - viewport:   the scrollable container element (overflow-y: scroll)
 *  - spacer:     a 1px-wide element whose height = total * ROW_HEIGHT
 *                (this is what makes the scrollbar reflect the full corpus)
 *  - container:  absolutely-positioned div that holds rendered row elements,
 *                translated to the correct vertical offset
 *
 * On every scroll event we compute which row indices are visible, check the
 * page cache, and issue fetches for any uncached pages. The container is
 * repositioned so rows appear at the right scroll offset.
 */

import { fetchLogs } from './api.js';

const ROW_HEIGHT      = 36;  // px — must match CSS --row-height
const OVERSCAN        = 10;  // extra rows above/below viewport to pre-render
const FETCH_LIMIT     = 100; // rows per API request (well under 200 cap)
const MAX_CACHE_PAGES = 20;  // max cached pages before LRU eviction

export class VirtualScroller {
  constructor({ viewport, spacer, container, onLoadingChange }) {
    this.viewport         = viewport;
    this.spacer           = spacer;
    this.container        = container;
    this.onLoadingChange  = onLoadingChange || (() => {});

    // Current filter state
    this.total    = 0;
    this.severity = '';
    this.q        = '';

    // Page cache: Map<pageKey, rows[]>
    // pageKey = `${pageIndex}:${severity}:${q}`
    this._cache      = new Map();
    this._cacheOrder = []; // insertion order for LRU eviction

    // In-flight requests: Map<pageKey, AbortController>
    this._inflight = new Map();

    // Generation counter — incremented on every filter reset to discard
    // responses that arrived after the filter changed.
    this._generation = 0;

    // rAF throttle for scroll handler
    this._rafPending = false;

    // Bind and register scroll handler
    this._onScroll = this._onScroll.bind(this);
    this.viewport.addEventListener('scroll', this._onScroll, { passive: true });
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Reset to a new filter state. Clears cache, cancels in-flight requests,
   * resets scroll to top, and triggers an initial render.
   */
  reset({ total, severity, q }) {
    this._cancelAllInflight();
    this._generation++;
    this.total    = total;
    this.severity = severity;
    this.q        = q;
    this._cache.clear();
    this._cacheOrder = [];
    this._resetDom(total);
    if (total > 0) this._renderWindow();
  }

  /**
   * Like reset(), but seeds page 0 into the cache from an already-fetched
   * first page, avoiding a redundant network request for the initial view.
   */
  resetWithFirstPage({ total, severity, q, firstPageRows }) {
    this._cancelAllInflight();
    this._generation++;
    this.total    = total;
    this.severity = severity;
    this.q        = q;
    this._cache.clear();
    this._cacheOrder = [];

    // Pre-seed page 0 so the initial render is instant
    if (firstPageRows && firstPageRows.length > 0) {
      this._addToCache(this._pageKey(0), firstPageRows);
    }

    this._resetDom(total);
    if (total > 0) this._renderWindow();
  }

  /**
   * Update the total row count without resetting scroll or cache.
   * Used when the server reports a changed total mid-session.
   */
  updateTotal(total) {
    this.total = total;
    this.spacer.style.height = `${total * ROW_HEIGHT}px`;
  }

  /** Clean up event listeners and abort in-flight requests. */
  destroy() {
    this.viewport.removeEventListener('scroll', this._onScroll);
    this._cancelAllInflight();
  }

  // ── Private ───────────────────────────────────────────────────────────────

  _cancelAllInflight() {
    for (const ctrl of this._inflight.values()) ctrl.abort();
    this._inflight.clear();
    if (this._inflight.size === 0) this.onLoadingChange(false);
  }

  _resetDom(total) {
    // Reset scroll position
    this.viewport.scrollTop = 0;
    // Set spacer height to reflect total corpus size
    this.spacer.style.height = `${total * ROW_HEIGHT}px`;
    // Clear rendered rows
    this.container.innerHTML = '';
    this.container.style.top = '0px';

    if (total === 0) {
      this._renderEmpty();
    }
  }

  _onScroll() {
    if (this._rafPending) return;
    this._rafPending = true;
    requestAnimationFrame(() => {
      this._rafPending = false;
      this._renderWindow();
    });
  }

  _renderWindow() {
    const scrollTop  = this.viewport.scrollTop;
    const viewportH  = this.viewport.clientHeight;

    if (viewportH === 0) return; // not yet laid out

    // Visible row range (0-indexed)
    const firstVisible = Math.floor(scrollTop / ROW_HEIGHT);
    const lastVisible  = Math.min(
      this.total - 1,
      Math.ceil((scrollTop + viewportH) / ROW_HEIGHT) - 1
    );

    // Expand with overscan
    const renderStart = Math.max(0, firstVisible - OVERSCAN);
    const renderEnd   = Math.min(this.total - 1, lastVisible + OVERSCAN);

    if (renderStart > renderEnd) return;

    // Determine which pages cover this range
    const pageStart = Math.floor(renderStart / FETCH_LIMIT);
    const pageEnd   = Math.floor(renderEnd   / FETCH_LIMIT);

    const gen = this._generation;

    // Collect rows from cache; trigger fetches for missing pages
    const allRows = {}; // absolute row index → row data

    for (let page = pageStart; page <= pageEnd; page++) {
      const key    = this._pageKey(page);
      const cached = this._cache.get(key);

      if (cached) {
        const pageOffset = page * FETCH_LIMIT;
        for (let i = 0; i < cached.length; i++) {
          allRows[pageOffset + i] = cached[i];
        }
      } else if (!this._inflight.has(key)) {
        // Kick off a fetch for this page
        this._fetchPage(page, gen);
      }
    }

    // Render whatever we have (placeholders for rows still loading)
    this._renderRows(renderStart, renderEnd, allRows);
  }

  _pageKey(page) {
    return `${page}:${this.severity}:${this.q}`;
  }

  async _fetchPage(page, gen) {
    const key    = this._pageKey(page);
    const offset = page * FETCH_LIMIT;
    const ctrl   = new AbortController();
    this._inflight.set(key, ctrl);
    this.onLoadingChange(true);

    try {
      const result = await fetchLogs(
        { offset, limit: FETCH_LIMIT, severity: this.severity, q: this.q },
        ctrl.signal
      );

      // Discard if the filter changed while we were fetching
      if (gen !== this._generation) return;

      this._addToCache(key, result.rows);

      // Update total if the server reports a different count
      if (result.total !== this.total) {
        this.updateTotal(result.total);
      }

      // Re-render now that we have data
      this._renderWindow();
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.error(`[VirtualScroller] fetch page ${page} failed:`, err);
    } finally {
      this._inflight.delete(key);
      if (this._inflight.size === 0) {
        this.onLoadingChange(false);
      }
    }
  }

  _addToCache(key, rows) {
    if (this._cache.has(key)) {
      // Refresh existing entry (move to end of LRU order)
      this._cache.set(key, rows);
      return;
    }
    // Evict oldest entry if at capacity
    if (this._cacheOrder.length >= MAX_CACHE_PAGES) {
      const oldest = this._cacheOrder.shift();
      this._cache.delete(oldest);
    }
    this._cache.set(key, rows);
    this._cacheOrder.push(key);
  }

  _renderRows(renderStart, renderEnd, allRows) {
    // Position the container so its top aligns with renderStart
    this.container.style.top = `${renderStart * ROW_HEIGHT}px`;

    const fragment = document.createDocumentFragment();
    for (let i = renderStart; i <= renderEnd; i++) {
      const row = allRows[i];
      fragment.appendChild(row ? this._buildRowEl(row, i) : this._buildPlaceholderEl(i));
    }

    this.container.innerHTML = '';
    this.container.appendChild(fragment);
  }

  _buildRowEl(row, index) {
    const div = document.createElement('div');
    div.className = 'log-row';
    div.dataset.index = index;

    // Format timestamp: "2024-01-15 14:32:07.123"
    const ts = new Date(row.ts).toISOString()
      .replace('T', ' ')
      .replace('Z', '')
      .slice(0, 23);

    div.innerHTML =
      `<div class="col-ts">${escapeHtml(ts)}</div>` +
      `<div class="col-sev"><span class="sev-chip ${escapeHtml(row.severity)}">${escapeHtml(row.severity)}</span></div>` +
      `<div class="col-svc" title="${escapeHtml(row.service)}">${escapeHtml(row.service)}</div>` +
      `<div class="col-msg" title="${escapeHtml(row.message)}">${escapeHtml(row.message)}</div>`;

    return div;
  }

  _buildPlaceholderEl(index) {
    const div = document.createElement('div');
    div.className = 'log-row';
    div.dataset.index = index;
    div.innerHTML =
      `<div class="col-ts" style="color:var(--text-dim)">loading…</div>` +
      `<div class="col-sev"></div>` +
      `<div class="col-svc"></div>` +
      `<div class="col-msg" style="color:var(--text-dim)">Fetching row ${index}…</div>`;
    return div;
  }

  _renderEmpty() {
    this.container.style.top = '0px';
    this.container.innerHTML =
      `<div class="empty-state">` +
      `<div class="empty-state-icon">🔍</div>` +
      `<div class="empty-state-text">No log entries match your filters.</div>` +
      `</div>`;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
