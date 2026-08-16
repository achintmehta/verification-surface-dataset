/**
 * VirtualScroller
 *
 * Manages a fixed pool of DOM row elements that are repositioned as the user
 * scrolls, so the DOM never holds more than (visibleCount + overscan*2) rows
 * regardless of corpus size.
 *
 * Architecture:
 *   - scroll-spacer height = total * ROW_HEIGHT  → gives scrollbar correct range
 *   - rows-viewport is position:sticky top:0, so it always fills the viewport
 *   - Each .log-row is position:absolute with top = (rowIdx - windowStart) * ROW_HEIGHT
 *   - On scroll: compute new windowStart, fetch if needed, reposition rows
 *
 * Fetch strategy:
 *   - We fetch one "page" at a time (FETCH_LIMIT rows).
 *   - A page cache keyed by (filterKey, pageOffset) avoids redundant fetches.
 *   - Cache is cleared when filters change.
 *   - A generation counter discards renders that started before the last filter change.
 *   - When the visible window spans two pages, we fetch both concurrently.
 */

import { fetchLogs } from './api.js';

const ROW_HEIGHT  = 36;   // must match --row-height CSS var
const FETCH_LIMIT = 100;  // rows per API request (≤200)
const OVERSCAN    = 8;    // extra rows above/below viewport
const CACHE_MAX   = 30;   // max cached pages per filter key

export class VirtualScroller {
  constructor({ scrollContainer, spacer, viewport, onTotalChange, onLoadingChange }) {
    this.scrollContainer = scrollContainer;
    this.spacer          = spacer;
    this.viewport        = viewport;
    this.onTotalChange   = onTotalChange;
    this.onLoadingChange = onLoadingChange;

    this.severity = '';
    this.q        = '';
    this.total    = 0;

    // DOM row pool
    this._pool     = [];
    this._poolSize = 0;

    // Page cache: filterKey → Map<pageOffset, {total, rows}>
    this._cache = new Map();

    // In-flight fetch promises: `${filterKey}|${pageOffset}` → Promise
    this._inflight = new Map();

    // Generation counter – incremented on every setFilters call
    this._gen = 0;

    // Last rendered window start
    this._lastWS = -1;

    // Pending render request (rAF handle)
    this._rafHandle = null;

    this._onScroll = this._onScroll.bind(this);
    scrollContainer.addEventListener('scroll', this._onScroll, { passive: true });

    this._resizePool();
    window.addEventListener('resize', () => {
      this._resizePool();
      this._requestRender();
    });
  }

  // ── Public ─────────────────────────────────────────────────────────────────

  async setFilters({ severity = '', q = '' } = {}) {
    this.severity = severity;
    this.q        = q;
    this._gen++;
    this._lastWS = -1;

    // Cancel all in-flight fetches by clearing the map; the promises will
    // resolve but their results will be discarded (generation check).
    this._inflight.clear();

    // Reset scroll position
    this.scrollContainer.scrollTop = 0;

    // Immediately reset total so spacer shrinks
    this.total = 0;
    this._updateSpacer();

    // Kick off initial render
    await this._render(0, this._gen);
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  _filterKey() {
    return `${this.severity}\x00${this.q}`;
  }

  _pageOffset(rowIdx) {
    return Math.floor(rowIdx / FETCH_LIMIT) * FETCH_LIMIT;
  }

  _currentWS() {
    const scrollTop    = this.scrollContainer.scrollTop;
    const firstVisible = Math.floor(scrollTop / ROW_HEIGHT);
    return Math.max(0, firstVisible - OVERSCAN);
  }

  _visibleCount() {
    const h = this.scrollContainer.clientHeight || 600;
    return Math.ceil(h / ROW_HEIGHT) + OVERSCAN * 2 + 2;
  }

  _onScroll() {
    this._requestRender();
  }

  _requestRender() {
    if (this._rafHandle !== null) return;
    this._rafHandle = requestAnimationFrame(() => {
      this._rafHandle = null;
      const ws = this._currentWS();
      if (ws !== this._lastWS) {
        this._render(ws, this._gen);
      }
    });
  }

  _resizePool() {
    const needed = this._visibleCount();
    while (this._pool.length < needed) {
      const el = document.createElement('div');
      el.className     = 'log-row';
      el.style.display = 'none';
      this.viewport.appendChild(el);
      this._pool.push(el);
    }
    this._poolSize = needed;
    for (let i = needed; i < this._pool.length; i++) {
      this._pool[i].style.display = 'none';
    }
  }

  // ── Fetch ──────────────────────────────────────────────────────────────────

  /**
   * Fetch a page, using cache and deduplicating concurrent requests for the
   * same page. Returns the page data or throws on error.
   */
  _fetchPage(pageOffset, gen) {
    const fk       = this._filterKey();
    const cacheKey = `${fk}\x01${pageOffset}`;

    // Cache hit
    const fc = this._cache.get(fk);
    if (fc && fc.has(pageOffset)) {
      return Promise.resolve(fc.get(pageOffset));
    }

    // Deduplicate concurrent fetches
    if (this._inflight.has(cacheKey)) {
      return this._inflight.get(cacheKey);
    }

    const promise = fetchLogs({
      offset:   pageOffset,
      limit:    FETCH_LIMIT,
      severity: this.severity,
      q:        this.q,
    }).then((data) => {
      this._inflight.delete(cacheKey);

      // Only cache if still the same generation and filter
      if (gen === this._gen && this._filterKey() === fk) {
        let fc2 = this._cache.get(fk);
        if (!fc2) {
          fc2 = new Map();
          this._cache.set(fk, fc2);
        }
        // Evict oldest entry if at capacity
        if (fc2.size >= CACHE_MAX) {
          fc2.delete(fc2.keys().next().value);
        }
        fc2.set(pageOffset, data);

        // Update total
        if (data.total !== this.total) {
          this.total = data.total;
          this._updateSpacer();
          this.onTotalChange(data.total);
        }
      }
      return data;
    }).catch((err) => {
      this._inflight.delete(cacheKey);
      throw err;
    });

    this._inflight.set(cacheKey, promise);
    return promise;
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  async _render(ws, gen) {
    ws = Math.max(0, ws);
    this._lastWS = ws;

    const visCount = this._visibleCount();
    const wsEnd    = ws + visCount; // may exceed total; clamped in _paint

    // Determine which pages cover [ws, wsEnd)
    const p1Off = this._pageOffset(ws);
    const p2Off = this._pageOffset(Math.max(0, wsEnd - 1));
    const twoPages = p2Off !== p1Off;

    this.onLoadingChange(true);

    let p1, p2 = null;
    try {
      if (twoPages) {
        [p1, p2] = await Promise.all([
          this._fetchPage(p1Off, gen),
          this._fetchPage(p2Off, gen),
        ]);
      } else {
        p1 = await this._fetchPage(p1Off, gen);
      }
    } catch (err) {
      this.onLoadingChange(false);
      if (err.name !== 'AbortError') {
        console.error('[VirtualScroller] fetch error', err);
      }
      return;
    }

    this.onLoadingChange(false);

    // Discard if generation changed (filter updated while fetching)
    if (gen !== this._gen) return;

    // If scroll position changed while fetching, re-render at new position
    if (ws !== this._lastWS) {
      return this._render(this._lastWS, gen);
    }

    this._paint(ws, p1Off, p1, p2Off, p2);
  }

  // ── Paint ──────────────────────────────────────────────────────────────────

  _rowAt(rowIdx, p1Off, p1, p2Off, p2) {
    const po = this._pageOffset(rowIdx);
    if (po === p1Off) return p1.rows[rowIdx - p1Off] ?? null;
    if (p2 && po === p2Off) return p2.rows[rowIdx - p2Off] ?? null;
    return null;
  }

  _paint(ws, p1Off, p1, p2Off, p2) {
    const visCount   = this._visibleCount();
    const clampedEnd = Math.min(ws + visCount, this.total);

    if (this.total === 0) {
      for (let i = 0; i < this._poolSize; i++) this._pool[i].style.display = 'none';
      this.viewport.style.height = '0px';
      return;
    }

    let pi = 0; // pool index
    for (let ri = ws; ri < clampedEnd && pi < this._poolSize; ri++) {
      const row = this._rowAt(ri, p1Off, p1, p2Off, p2);
      const el  = this._pool[pi++];

      if (!row) {
        el.style.display = 'none';
        continue;
      }

      el.style.display = '';
      el.style.top     = `${(ri - ws) * ROW_HEIGHT}px`;
      el.className     = `log-row sev-${row.severity} ${ri % 2 === 0 ? 'even' : 'odd'}`;
      el.innerHTML     = this._rowHTML(row);
    }

    // Hide unused pool slots
    for (let i = pi; i < this._poolSize; i++) this._pool[i].style.display = 'none';

    // Viewport height = rendered rows
    const rendered = Math.min(clampedEnd - ws, pi);
    this.viewport.style.height = `${Math.max(0, rendered) * ROW_HEIGHT}px`;
  }

  _rowHTML(row) {
    return (
      `<div class="col col-ts col-ts-val">${esc(fmtTs(row.ts))}</div>` +
      `<div class="col col-sev col-sev-val">${esc(row.severity)}</div>` +
      `<div class="col col-svc col-svc-val">${esc(row.service)}</div>` +
      `<div class="col col-msg col-msg-val">${esc(row.message)}</div>`
    );
  }

  _updateSpacer() {
    this.spacer.style.height = `${this.total * ROW_HEIGHT}px`;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtTs(iso) {
  try {
    const d  = new Date(iso);
    const Y  = d.getUTCFullYear();
    const Mo = p2(d.getUTCMonth() + 1);
    const D  = p2(d.getUTCDate());
    const H  = p2(d.getUTCHours());
    const Mi = p2(d.getUTCMinutes());
    const S  = p2(d.getUTCSeconds());
    const ms = p3(d.getUTCMilliseconds());
    return `${Y}-${Mo}-${D} ${H}:${Mi}:${S}.${ms}`;
  } catch {
    return String(iso);
  }
}

const p2 = (n) => n < 10 ? `0${n}` : `${n}`;
const p3 = (n) => n < 10 ? `00${n}` : n < 100 ? `0${n}` : `${n}`;
