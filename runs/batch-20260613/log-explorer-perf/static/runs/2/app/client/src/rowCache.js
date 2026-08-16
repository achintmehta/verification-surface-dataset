/**
 * RowCache
 *
 * Manages a sliding window of fetched rows. When the virtual scroller
 * requests a new window, the cache fetches the appropriate page(s) from
 * the API and notifies the caller.
 *
 * Design:
 * - Keeps one "page" of rows in memory (the last fetched window).
 * - Cancels in-flight requests when a newer request supersedes them.
 * - Calls onData({ rows, windowStart, total }) when data arrives.
 * - Calls onLoading(bool) to show/hide the spinner.
 * - Calls onError(message) on fetch failure.
 */

import { fetchLogs } from './api.js';

const FETCH_LIMIT = 200; // max rows per request

export class RowCache {
  constructor({ onData, onLoading, onError }) {
    this._onData    = onData;
    this._onLoading = onLoading;
    this._onError   = onError;

    // Current filter state
    this._severity = '';
    this._q        = '';

    // In-flight request controller
    this._abortController = null;

    // Cached window
    this._cachedStart = -1;
    this._cachedRows  = [];
    this._total       = 0;

  }

  /** Update filters — clears cache and triggers a fresh fetch at offset 0. */
  setFilters({ severity = '', q = '' } = {}) {
    this._severity = severity;
    this._q = q;
    this._cachedStart = -1;
    this._cachedRows = [];
    this._total = 0;
  }

  /**
   * Request rows for the given window [startIndex, endIndex].
   * Fetches a page that covers the window with some padding.
   */
  requestWindow(startIndex, endIndex) {
    // Align fetch offset to page boundaries to improve cache hit rate
    // Page size = FETCH_LIMIT; align down to nearest page start
    const PAGE = FETCH_LIMIT;
    const fetchOffset = Math.max(0, Math.floor(startIndex / PAGE) * PAGE);
    const fetchLimit  = FETCH_LIMIT;

    // Check if the current cache already covers this window
    const cacheEnd = this._cachedStart + this._cachedRows.length - 1;
    if (
      this._cachedStart >= 0 &&
      startIndex >= this._cachedStart &&
      endIndex <= cacheEnd
    ) {
      // Cache hit — serve from cache
      this._serveFromCache(startIndex, endIndex);
      return;
    }

    // Cancel any in-flight request
    if (this._abortController) {
      this._abortController.abort();
    }

    this._abortController = new AbortController();
    const controller = this._abortController;

    this._onLoading(true);

    const params = {
      offset:   fetchOffset,
      limit:    fetchLimit,
      severity: this._severity,
      q:        this._q,
    };

    fetchLogs(params, controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;

        this._cachedStart = fetchOffset;
        this._cachedRows  = data.rows;
        this._total       = data.total;
        this._abortController = null;

        this._onLoading(false);
        this._serveFromCache(startIndex, endIndex);
      })
      .catch((err) => {
        if (err.name === 'AbortError') return;
        this._abortController = null;
        this._onLoading(false);
        this._onError(err.message || 'Fetch failed');
      });
  }

  _serveFromCache(startIndex, endIndex) {
    const relStart = startIndex - this._cachedStart;
    const relEnd   = endIndex   - this._cachedStart;
    const rows = this._cachedRows.slice(
      Math.max(0, relStart),
      Math.min(this._cachedRows.length, relEnd + 1)
    );

    this._onData({
      rows,
      windowStart: startIndex,
      total: this._total,
    });
  }

  get total() {
    return this._total;
  }

  /** Cancel any in-flight request. */
  cancel() {
    if (this._abortController) {
      this._abortController.abort();
      this._abortController = null;
    }
  }
}
