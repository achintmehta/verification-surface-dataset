/**
 * VirtualScroller
 *
 * Manages a fixed-height scrollable container where only the visible rows
 * (plus overscan) exist in the DOM. The total scroll height is set via a
 * spacer element so the native scrollbar reflects the full corpus size.
 */

export class VirtualScroller {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.container    - The scrollable element
   * @param {HTMLElement} opts.spacer       - Absolutely positioned height-setter
   * @param {HTMLElement} opts.viewport     - Where rows are rendered (absolutely positioned)
   * @param {number}      opts.rowHeight    - Fixed row height in px
   * @param {number}      [opts.overscan]   - Extra rows above/below viewport (default 10)
   * @param {function}    opts.onFetchWindow - Called with (offset, limit) when a new window is needed
   */
  constructor({ container, spacer, viewport, rowHeight, overscan = 10, onFetchWindow }) {
    this._container    = container;
    this._spacer       = spacer;
    this._viewport     = viewport;
    this._rowHeight    = rowHeight;
    this._overscan     = overscan;
    this._onFetchWindow = onFetchWindow;

    this._total        = 0;
    this._rows         = [];   // currently loaded rows
    this._windowOffset = 0;    // offset of first loaded row
    this._windowSize   = 0;    // number of loaded rows

    this._rafPending      = false;
    this._destroyed       = false;
    this._lastFetchOffset = -1;
    this._lastFetchLimit  = 0;

    this._onScroll = this._onScroll.bind(this);
    this._container.addEventListener('scroll', this._onScroll, { passive: true });
  }

  destroy() {
    this._destroyed = true;
    this._container.removeEventListener('scroll', this._onScroll);
  }

  /** Update the total row count and resize the spacer. */
  setTotal(total) {
    this._total = total;
    this._spacer.style.height = `${total * this._rowHeight}px`;
  }

  /** Replace the loaded window of rows and re-render. */
  setWindow(offset, rows) {
    this._windowOffset = offset;
    this._rows         = rows;
    this._windowSize   = rows.length;
    this._render();
  }

  /** Scroll to the top and reset fetch-dedup state. */
  scrollToTop() {
    this._container.scrollTop = 0;
    this._lastFetchOffset     = -1;
    this._lastFetchLimit      = 0;
  }

  /** Force a re-render at the current scroll position. */
  refresh() {
    this._render();
  }

  /** Trigger an initial window check (call after setting total for the first time). */
  triggerInitialFetch() {
    this._checkWindow(this._container.scrollTop);
  }

  // ── Private ──────────────────────────────────────────────────────────────

  _onScroll() {
    if (this._rafPending) return;
    this._rafPending = true;
    requestAnimationFrame(() => {
      this._rafPending = false;
      if (this._destroyed) return;
      const scrollTop = this._container.scrollTop;
      this._checkWindow(scrollTop);
      this._render();
    });
  }

  /**
   * Determine whether the current scroll position is covered by the loaded
   * window (with overscan buffer). If not, request a new fetch.
   */
  _checkWindow(scrollTop) {
    if (this._total === 0) return;

    const containerHeight = this._container.clientHeight || 600;
    const visibleFirst    = Math.floor(scrollTop / this._rowHeight);
    const visibleCount    = Math.ceil(containerHeight / this._rowHeight);
    const visibleLast     = visibleFirst + visibleCount - 1;

    const loadedFirst = this._windowOffset;
    const loadedLast  = this._windowOffset + this._windowSize - 1;

    // The loaded window must cover the visible range plus overscan on both sides.
    // Clamp to [0, total-1] so we don't demand rows that don't exist.
    const needsFirst = Math.max(0, visibleFirst - this._overscan);
    const needsLast  = Math.min(this._total - 1, visibleLast + this._overscan);

    const coveredFirst = loadedFirst <= needsFirst;
    const coveredLast  = loadedLast  >= needsLast;
    const hasCoverage  = this._windowSize > 0 && coveredFirst && coveredLast;

    if (hasCoverage) return;

    // Center the fetch window around the visible range.
    const fetchSize   = Math.min(200, visibleCount + this._overscan * 6);
    const idealOffset = Math.max(0, visibleFirst - Math.floor(fetchSize / 2));
    const fetchOffset = Math.min(idealOffset, Math.max(0, this._total - fetchSize));

    // Avoid re-requesting the exact same window (dedup in-flight requests).
    if (fetchOffset === this._lastFetchOffset && fetchSize === this._lastFetchLimit) return;

    this._lastFetchOffset = fetchOffset;
    this._lastFetchLimit  = fetchSize;
    this._onFetchWindow(fetchOffset, fetchSize);
  }

  _render() {
    const scrollTop       = this._container.scrollTop;
    const containerHeight = this._container.clientHeight || 600;

    const visibleFirst = Math.floor(scrollTop / this._rowHeight);
    const visibleCount = Math.ceil(containerHeight / this._rowHeight);
    const renderFirst  = Math.max(0, visibleFirst - this._overscan);
    const renderLast   = Math.min(this._total - 1, visibleFirst + visibleCount + this._overscan);

    // Intersect render range with loaded window
    const loadedFirst = this._windowOffset;
    const loadedLast  = this._windowOffset + this._windowSize - 1;

    const domFirst = Math.max(renderFirst, loadedFirst);
    const domLast  = Math.min(renderLast,  loadedLast);

    if (domFirst > domLast || this._windowSize === 0) {
      this._viewport.innerHTML = '';
      this._viewport.style.transform = 'translateY(0px)';
      return;
    }

    // Position the viewport at the first rendered row
    const topPx = domFirst * this._rowHeight;
    this._viewport.style.transform = `translateY(${topPx}px)`;

    // Build and swap in the new row fragment
    const fragment = document.createDocumentFragment();
    for (let absIdx = domFirst; absIdx <= domLast; absIdx++) {
      const rowIdx = absIdx - this._windowOffset;
      const row    = this._rows[rowIdx];
      if (!row) continue;
      fragment.appendChild(buildRow(row));
    }

    this._viewport.innerHTML = '';
    this._viewport.appendChild(fragment);
  }
}

// ── Row builder ──────────────────────────────────────────────────────────────

const SEV_CLASSES = {
  debug: 'sev-debug',
  info:  'sev-info',
  warn:  'sev-warn',
  error: 'sev-error',
};

function buildRow(row) {
  const div = document.createElement('div');
  div.className = 'log-row';

  const ts = document.createElement('div');
  ts.className = 'col-ts';
  ts.textContent = formatTs(row.ts);

  const sev = document.createElement('div');
  sev.className = `col-severity ${SEV_CLASSES[row.severity] || ''}`;
  sev.textContent = row.severity;

  const svc = document.createElement('div');
  svc.className = 'col-service';
  svc.textContent = row.service;

  const msg = document.createElement('div');
  msg.className = 'col-message';
  msg.textContent = row.message;

  div.appendChild(ts);
  div.appendChild(sev);
  div.appendChild(svc);
  div.appendChild(msg);

  return div;
}

function formatTs(isoString) {
  try {
    const d  = new Date(isoString);
    const Y  = d.getUTCFullYear();
    const Mo = pad2(d.getUTCMonth() + 1);
    const D  = pad2(d.getUTCDate());
    const h  = pad2(d.getUTCHours());
    const m  = pad2(d.getUTCMinutes());
    const s  = pad2(d.getUTCSeconds());
    return `${Y}-${Mo}-${D} ${h}:${m}:${s} UTC`;
  } catch {
    return isoString;
  }
}

function pad2(n) {
  return n < 10 ? `0${n}` : `${n}`;
}
