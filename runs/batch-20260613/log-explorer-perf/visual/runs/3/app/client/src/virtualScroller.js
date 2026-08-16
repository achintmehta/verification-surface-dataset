/**
 * VirtualScroller
 *
 * Manages a virtualized list where only the visible rows (+ overscan) exist in the DOM.
 * The total scroll height reflects the full filtered corpus.
 *
 * Layout:
 *   .scroller-container  — overflow-y: scroll, flex: 1
 *     .scroller-inner    — height = total * ROW_HEIGHT  (sets the scrollbar range)
 *       .rows-viewport   — position: absolute, top = renderedOffset * ROW_HEIGHT
 *                          contains only the currently rendered rows
 *
 * On scroll we compute which row offset is at the top of the viewport, fetch that
 * window from the API, and re-render. A monotonic request sequence number ensures
 * stale responses never overwrite newer ones.
 */

import { fetchLogs, WINDOW_SIZE } from './api.js';

const ROW_HEIGHT        = 36;   // px — must match CSS --row-height
const OVERSCAN_ROWS     = 8;    // extra rows to render above/below the visible area
const SCROLL_DEBOUNCE   = 40;   // ms — how long to wait after scroll stops before fetching
const MAX_DOM_ROWS      = 100;  // hard cap on rows in the DOM at any time

const SEV_LABELS = { debug: 'DEBUG', info: 'INFO', warn: 'WARN', error: 'ERROR' };

// ── helpers ──────────────────────────────────────────────────────────────────

function formatTs(iso) {
  const d = new Date(iso);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}` +
    `.${p(d.getUTCMilliseconds(), 3)}`
  );
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildRowHTML(row) {
  return (
    `<div class="col col-ts">${formatTs(row.ts)}</div>` +
    `<div class="col col-severity"><span class="severity-badge">${SEV_LABELS[row.severity] ?? row.severity}</span></div>` +
    `<div class="col col-service">${esc(row.service)}</div>` +
    `<div class="col col-message">${esc(row.message)}</div>`
  );
}

// ── VirtualScroller class ─────────────────────────────────────────────────────

export class VirtualScroller {
  /**
   * @param {{
   *   container: HTMLElement,
   *   inner: HTMLElement,
   *   viewport: HTMLElement,
   *   onTotalChange: (total: number) => void,
   *   onStatusChange: (msg: string) => void,
   * }} opts
   */
  constructor({ container, inner, viewport, onTotalChange, onStatusChange }) {
    this.container      = container;
    this.inner          = inner;
    this.viewport       = viewport;
    this.onTotalChange  = onTotalChange;
    this.onStatusChange = onStatusChange;

    // Filter state
    this.severity = '';
    this.q        = '';

    // Data state
    this.total          = 0;
    this.renderedOffset = 0;   // offset of the first rendered row
    this.renderedCount  = 0;   // number of rows currently in the DOM

    // Inflight tracking
    this._seq         = 0;    // monotonic; incremented on every fetch
    this._scrollTimer = null;

    this.container.addEventListener('scroll', this._onScroll.bind(this), { passive: true });
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /** Apply new filters and reset scroll to top. */
  async setFilters({ severity = '', q = '' } = {}) {
    this.severity = severity;
    this.q        = q;
    // Reset scroll position synchronously so the next fetch uses offset 0
    this.container.scrollTop = 0;
    await this._fetch(0);
  }

  /** Initial load. */
  async init() {
    await this._fetch(0);
  }

  // ── Scroll handling ─────────────────────────────────────────────────────────

  _onScroll() {
    if (this._scrollTimer) clearTimeout(this._scrollTimer);
    this._scrollTimer = setTimeout(() => {
      this._onScrollSettled(this.container.scrollTop);
    }, SCROLL_DEBOUNCE);
  }

  _onScrollSettled(scrollTop) {
    if (this.total === 0) return;

    const viewportH   = this.container.clientHeight;
    const visibleRows = Math.ceil(viewportH / ROW_HEIGHT);

    // Row index at the very top of the visible area
    const topRow = Math.floor(scrollTop / ROW_HEIGHT);

    // We want to render from (topRow - OVERSCAN) to (topRow + visibleRows + OVERSCAN)
    // Clamp to [0, total)
    const wantStart = Math.max(0, topRow - OVERSCAN_ROWS);
    const wantEnd   = Math.min(this.total, topRow + visibleRows + OVERSCAN_ROWS);
    const wantCount = wantEnd - wantStart;

    // Check if the current rendered window already covers what we need
    const alreadyCovered =
      this.renderedCount > 0 &&
      wantStart >= this.renderedOffset &&
      wantEnd   <= this.renderedOffset + this.renderedCount;

    if (alreadyCovered) return; // nothing to do

    // Fetch a window that covers the desired range, capped at MAX_DOM_ROWS
    // Align the fetch start to a multiple of WINDOW_SIZE for cache friendliness
    const fetchLimit  = Math.min(MAX_DOM_ROWS, WINDOW_SIZE);
    // Center the fetch window around the visible area
    const fetchStart  = Math.max(0, Math.min(
      wantStart,
      this.total - fetchLimit
    ));

    this._fetch(fetchStart, fetchLimit);
  }

  // ── Core fetch + render ─────────────────────────────────────────────────────

  async _fetch(offset, limit = WINDOW_SIZE) {
    const seq      = ++this._seq;
    const severity = this.severity;
    const q        = this.q;

    this.onStatusChange('Loading…');

    try {
      const t0   = performance.now();
      const data = await fetchLogs({ offset, limit, severity, q });
      const ms   = Math.round(performance.now() - t0);

      // Stale-response guard
      if (seq !== this._seq) return;

      this.total          = data.total;
      this.renderedOffset = offset;
      this.renderedCount  = data.rows.length;

      // 1. Update the phantom scroll height
      this.inner.style.height = `${this.total * ROW_HEIGHT}px`;

      // 2. Position the row viewport at the correct pixel offset
      this.viewport.style.top = `${offset * ROW_HEIGHT}px`;

      // 3. Render rows into the viewport
      this._renderRows(data.rows);

      // 4. Notify parent components
      this.onTotalChange(this.total);

      const first = offset + 1;
      const last  = offset + data.rows.length;
      this.onStatusChange(
        `Rows ${first.toLocaleString()}–${last.toLocaleString()} of ${this.total.toLocaleString()} | Query: ${ms} ms`
      );
    } catch (err) {
      if (err.name === 'AbortError') return; // intentionally cancelled
      if (seq !== this._seq)        return; // stale
      this.onStatusChange(`Error: ${err.message}`);
      console.error('[VirtualScroller._fetch]', err);
    }
  }

  _renderRows(rows) {
    if (rows.length === 0) {
      this.viewport.innerHTML =
        '<div class="empty-state">No log entries match the current filters.</div>';
      return;
    }

    // Build all row HTML in one string and set innerHTML once — fastest path
    const html = rows.map((row, i) => {
      const even = (this.renderedOffset + i) % 2 === 0;
      return (
        `<div class="log-row sev-${row.severity}${even ? ' row-even' : ' row-odd'}" ` +
        `style="height:${ROW_HEIGHT}px">` +
        buildRowHTML(row) +
        `</div>`
      );
    }).join('');

    this.viewport.innerHTML = html;
  }
}
