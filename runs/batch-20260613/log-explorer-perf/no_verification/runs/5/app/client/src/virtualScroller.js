/**
 * VirtualScroller
 *
 * Manages a virtualized list of log rows. Only the rows intersecting the
 * visible viewport (plus overscan) exist in the DOM at any time.
 *
 * Architecture:
 *   - scroller-container: the scrollable element (overflow-y: scroll)
 *   - scroller-inner:     sized to total * ROW_HEIGHT so the scrollbar is correct
 *   - rows-viewport:      absolutely positioned within scroller-inner;
 *                         contains only the rendered rows
 *
 * Fetch strategy:
 *   When the user scrolls to a position not covered by the cached window,
 *   a new fetch is triggered for a window centered around the visible area.
 *   Each fetch is identified by a (generation, fetchId) pair:
 *     - generation increments on every filter change (stale filter responses discarded)
 *     - fetchId increments on every new fetch (only the latest fetch per generation wins)
 *   The previous in-flight request is aborted before starting a new one.
 *
 * DOM budget:
 *   At most (viewport_rows + 2 * OVERSCAN) rows exist in the DOM at any time.
 *   For a typical 1080p screen showing ~25 rows and OVERSCAN=8, that is ≤41 rows.
 */

import { fetchLogs } from './api.js';

const ROW_HEIGHT         = 36;   // must match CSS --row-height
const FETCH_LIMIT        = 100;  // rows per API request (≤ 200 cap)
const OVERSCAN           = 8;    // extra rows above/below viewport
const SCROLL_DEBOUNCE_MS = 50;   // ms after last scroll event before fetching

export class VirtualScroller {
  /**
   * @param {object}      opts
   * @param {HTMLElement} opts.container  - the scrollable container
   * @param {HTMLElement} opts.inner      - the full-height inner div
   * @param {HTMLElement} opts.viewport   - the absolutely-positioned rows div
   * @param {function}    opts.onStatus   - callback(string) for status bar updates
   */
  constructor({ container, inner, viewport, onStatus }) {
    this.container = container;
    this.inner     = inner;
    this.viewport  = viewport;
    this.onStatus  = onStatus || (() => {});

    // ── Filter state ──────────────────────────────────────────────────────────
    this.severity = '';
    this.q        = '';

    // ── Data state ────────────────────────────────────────────────────────────
    this.total        = 0;
    this.rows         = [];    // currently cached rows
    this.windowOffset = 0;    // index of rows[0] in the full result set

    // ── Request tracking ──────────────────────────────────────────────────────
    this.generation = 0;      // incremented on filter change
    this.fetchId    = 0;      // incremented on each fetch attempt
    this.activeFetchId = -1;  // fetchId of the last completed fetch
    this.abortCtrl  = null;

    // ── Scroll debounce ───────────────────────────────────────────────────────
    this.scrollTimer = null;

    this._onScroll = this._onScroll.bind(this);
    this.container.addEventListener('scroll', this._onScroll, { passive: true });
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Apply new filters and reset the view to the top.
   */
  setFilters({ severity, q }) {
    this.severity = severity || '';
    this.q        = q        || '';

    // Bump generation — any in-flight response for the old generation is discarded
    this.generation++;
    const gen = this.generation;

    // Reset data state
    this.rows         = [];
    this.windowOffset = 0;
    this.total        = 0;
    this.activeFetchId = -1;

    // Cancel in-flight request
    this._abort();

    // Clear scroll debounce
    if (this.scrollTimer) {
      clearTimeout(this.scrollTimer);
      this.scrollTimer = null;
    }

    // Reset scroll position (synchronously, before fetch)
    this.container.scrollTop = 0;

    // Clear DOM
    this.viewport.innerHTML = '';
    this.inner.style.height = '0px';

    // Fetch first window
    this._scheduleFetch(0, gen);
  }

  // ─── Private: scroll handling ────────────────────────────────────────────────

  _onScroll() {
    // Render immediately from cache (zero-latency for cached rows)
    this._renderFromCache();

    // Debounce the fetch check
    if (this.scrollTimer) clearTimeout(this.scrollTimer);
    this.scrollTimer = setTimeout(() => {
      this.scrollTimer = null;
      this._checkCoverageAndFetch();
    }, SCROLL_DEBOUNCE_MS);
  }

  _checkCoverageAndFetch() {
    const { visibleStart, visibleEnd } = this._visibleRange();
    const neededStart = Math.max(0, visibleStart - OVERSCAN);
    const neededEnd   = Math.min(Math.max(0, this.total - 1), visibleEnd + OVERSCAN);

    const cacheStart = this.windowOffset;
    const cacheEnd   = this.windowOffset + this.rows.length - 1;

    const covered = (
      this.rows.length > 0 &&
      neededStart >= cacheStart &&
      neededEnd   <= cacheEnd
    );

    if (!covered) {
      // Center the fetch window around the visible area
      const center      = Math.floor((visibleStart + visibleEnd) / 2);
      const fetchOffset = Math.max(0, center - Math.floor(FETCH_LIMIT / 2));
      this._scheduleFetch(fetchOffset, this.generation);
    }
  }

  // ─── Private: fetching ───────────────────────────────────────────────────────

  _abort() {
    if (this.abortCtrl) {
      this.abortCtrl.abort();
      this.abortCtrl = null;
    }
  }

  _scheduleFetch(offset, gen) {
    // Abort any previous in-flight request
    this._abort();

    const fetchId = ++this.fetchId;
    this.abortCtrl = new AbortController();

    this._doFetch(offset, gen, fetchId, this.abortCtrl.signal);
  }

  async _doFetch(offset, gen, fetchId, signal) {
    this.onStatus(`Fetching rows ${offset + 1}–${offset + FETCH_LIMIT}…`);

    try {
      const t0   = performance.now();
      const data = await fetchLogs(
        {
          offset,
          limit:    FETCH_LIMIT,
          severity: this.severity || undefined,
          q:        this.q        || undefined,
        },
        signal
      );
      const elapsed = Math.round(performance.now() - t0);

      // Discard stale responses (wrong generation or superseded fetch)
      if (gen !== this.generation) return;
      if (fetchId < this.activeFetchId) return; // a newer fetch already landed

      this.activeFetchId = fetchId;
      this.total         = data.total;
      this.rows          = data.rows;
      this.windowOffset  = offset;

      this._updateInnerHeight();
      this._renderFromCache();

      const end = offset + data.rows.length;
      this.onStatus(
        `Rows ${offset + 1}–${end} of ${data.total.toLocaleString()} · ${elapsed} ms`
      );
    } catch (err) {
      if (err.name === 'AbortError') return;
      if (gen !== this.generation) return;
      console.error('[VirtualScroller] fetch error:', err);
      this.onStatus(`Error loading rows: ${err.message}`);
    }
  }

  // ─── Private: rendering ─────────────────────────────────────────────────────

  _visibleRange() {
    const scrollTop    = this.container.scrollTop;
    const clientHeight = this.container.clientHeight;
    const visibleStart = Math.floor(scrollTop / ROW_HEIGHT);
    const visibleEnd   = visibleStart + Math.ceil(clientHeight / ROW_HEIGHT);
    return { visibleStart, visibleEnd };
  }

  _updateInnerHeight() {
    this.inner.style.height = `${this.total * ROW_HEIGHT}px`;
  }

  _renderFromCache() {
    if (this.total === 0 && this.rows.length === 0) {
      this.viewport.innerHTML = '';
      this.viewport.style.top = '0px';
      return;
    }

    const { visibleStart, visibleEnd } = this._visibleRange();

    const renderStart = Math.max(0, visibleStart - OVERSCAN);
    const renderEnd   = Math.min(Math.max(0, this.total - 1), visibleEnd + OVERSCAN);

    const cacheStart = this.windowOffset;
    const cacheEnd   = this.windowOffset + this.rows.length - 1;

    // Clamp to what we actually have cached
    const actualStart = Math.max(renderStart, cacheStart);
    const actualEnd   = Math.min(renderEnd, cacheEnd);

    if (actualStart > actualEnd || this.rows.length === 0) {
      // Show skeleton while waiting for data
      this._renderSkeleton(renderStart, renderEnd);
      return;
    }

    // Position the viewport div at the top of the rendered rows
    this.viewport.style.top = `${actualStart * ROW_HEIGHT}px`;

    // Build the row elements
    const fragment = document.createDocumentFragment();
    for (let i = actualStart; i <= actualEnd; i++) {
      const rowData = this.rows[i - this.windowOffset];
      fragment.appendChild(this._buildRow(rowData, i));
    }

    this.viewport.innerHTML = '';
    this.viewport.appendChild(fragment);
  }

  _renderSkeleton(start, end) {
    const count = Math.min(end - start + 1, 30);
    if (count <= 0) return;

    this.viewport.style.top = `${start * ROW_HEIGHT}px`;

    const fragment = document.createDocumentFragment();
    for (let i = 0; i < count; i++) {
      const row = document.createElement('div');
      row.className = 'skeleton-row';
      row.innerHTML =
        '<div class="skeleton-block" style="width:160px"></div>' +
        '<div class="skeleton-block" style="width:50px"></div>' +
        '<div class="skeleton-block" style="width:120px"></div>' +
        '<div class="skeleton-block" style="flex:1"></div>';
      fragment.appendChild(row);
    }

    this.viewport.innerHTML = '';
    this.viewport.appendChild(fragment);
  }

  _buildRow(row, index) {
    const el = document.createElement('div');
    el.className = 'log-row';
    el.dataset.index = String(index);

    const ts    = new Date(row.ts);
    const tsStr = ts.toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');

    // Use textContent for safety where possible; innerHTML only for structure
    const tsEl  = document.createElement('div');
    tsEl.className = 'col-ts';
    tsEl.textContent = tsStr;

    const sevEl = document.createElement('div');
    sevEl.className = 'col-severity';
    const pill = document.createElement('span');
    pill.className = `severity-pill ${row.severity}`;
    pill.textContent = row.severity;
    sevEl.appendChild(pill);

    const svcEl = document.createElement('div');
    svcEl.className = 'col-service';
    svcEl.textContent = row.service;

    const msgEl = document.createElement('div');
    msgEl.className = 'col-message';
    msgEl.textContent = row.message;

    el.appendChild(tsEl);
    el.appendChild(sevEl);
    el.appendChild(svcEl);
    el.appendChild(msgEl);

    return el;
  }

  // ─── Cleanup ─────────────────────────────────────────────────────────────────

  destroy() {
    this.container.removeEventListener('scroll', this._onScroll);
    this._abort();
    if (this.scrollTimer) clearTimeout(this.scrollTimer);
  }
}
