/**
 * VirtualScroller
 *
 * Manages a fixed pool of DOM row elements that are repositioned as the user
 * scrolls. Only the rows intersecting the viewport (plus overscan) exist in
 * the DOM at any time.
 *
 * Architecture:
 *  - scroller-container: overflow-y: scroll; fixed height
 *  - scroller-inner:     height = total * ROW_HEIGHT  (creates scroll range)
 *  - log-row elements:   position: absolute; top = rowIndex * ROW_HEIGHT
 *
 * When the scroll position changes we compute which row indices are visible,
 * map them to the pool slots, and update each slot's content + position.
 */

const ROW_HEIGHT  = 36;    // must match CSS --row-height
const OVERSCAN    = 10;    // extra rows above/below viewport
const FETCH_LIMIT = 100;   // rows per API request
const POOL_SIZE   = 80;    // DOM row pool (viewport ~20 rows + 2×overscan + buffer)

export class VirtualScroller {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.container   - the scrollable container
   * @param {HTMLElement} opts.inner       - the tall inner div
   * @param {Function}    opts.fetchWindow - async (offset, limit, signal) => { total, rows }
   */
  constructor({ container, inner, fetchWindow }) {
    this.container   = container;
    this.inner       = inner;
    this.fetchWindow = fetchWindow;

    this.total = 0;
    this.rows  = [];   // sparse array indexed by absolute row index

    // In-flight fetch tracking
    this._fetchController = null;
    this._fetchPending    = false;  // guard against concurrent _handleScroll calls

    // Pool of DOM elements
    this._pool      = [];
    this._poolBuilt = false;

    // Scroll handler (throttled via rAF)
    this._rafPending = false;
    // Track whether a scroll happened while we were handling a previous one
    this._scrollDirty = false;

    this.container.addEventListener('scroll', this._onScroll.bind(this), { passive: true });
  }

  // ── Pool ──────────────────────────────────────────────────────────────────

  /**
   * Build (or rebuild) the DOM pool. Safe to call multiple times —
   * removes old pool elements first.
   */
  buildPool() {
    // Remove any existing pool elements from the DOM
    for (const slot of this._pool) {
      if (slot.el.parentNode) slot.el.parentNode.removeChild(slot.el);
    }
    this._pool = [];

    for (let i = 0; i < POOL_SIZE; i++) {
      const el = document.createElement('div');
      el.className = 'log-row';
      el.style.display = 'none';
      this.inner.appendChild(el);
      this._pool.push({ el, rowIndex: -1 });
    }
    this._poolBuilt = true;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Reset to a new dataset (new filters applied).
   * Clears cache, resets scroll to top, sets inner height.
   */
  reset(total) {
    // Cancel any in-flight fetch
    if (this._fetchController) {
      this._fetchController.abort();
      this._fetchController = null;
    }
    this._fetchPending = false;

    this.total = total;
    this.rows  = [];
    this._clearPool();
    this.container.scrollTop = 0;
    this._updateInnerHeight();
  }

  /**
   * Pre-populate cache with rows from an already-completed fetch.
   */
  seedCache(offset, rows) {
    for (let i = 0; i < rows.length; i++) {
      this.rows[offset + i] = rows[i];
    }
  }

  /**
   * Paint the current viewport. Call after seedCache or after a fetch completes.
   */
  paintViewport() {
    if (!this._poolBuilt || this.total === 0) return;
    const scrollTop = this.container.scrollTop;
    const viewportH = this.container.clientHeight;
    const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const last  = Math.min(
      this.total - 1,
      Math.ceil((scrollTop + viewportH) / ROW_HEIGHT) + OVERSCAN
    );
    if (first <= last) this._paintRows(first, last);
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  _updateInnerHeight() {
    this.inner.style.height = `${this.total * ROW_HEIGHT}px`;
  }

  _clearPool() {
    for (const slot of this._pool) {
      slot.el.style.display = 'none';
      slot.rowIndex = -1;
    }
  }

  _onScroll() {
    if (this._rafPending) {
      // Mark that another scroll happened; we'll re-check after the current rAF
      this._scrollDirty = true;
      return;
    }
    this._rafPending = true;
    this._scrollDirty = false;
    requestAnimationFrame(() => {
      this._rafPending = false;
      this._handleScroll();
    });
  }

  /**
   * Compute visible range, identify missing rows, fetch them, then paint.
   * Re-entrant: if called while a fetch is in progress, marks dirty and returns.
   */
  async _handleScroll() {
    if (this._fetchPending) {
      this._scrollDirty = true;
      return;
    }

    const scrollTop = this.container.scrollTop;
    const viewportH = this.container.clientHeight;

    const firstVisible = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const lastVisible  = Math.min(
      this.total - 1,
      Math.ceil((scrollTop + viewportH) / ROW_HEIGHT) + OVERSCAN
    );

    if (firstVisible > lastVisible) return;

    // Paint what we have immediately (may be partial — blank slots for missing rows)
    this._paintRows(firstVisible, lastVisible);

    // Identify which rows we need but don't have
    const missing = [];
    for (let i = firstVisible; i <= lastVisible; i++) {
      if (this.rows[i] === undefined) missing.push(i);
    }

    if (missing.length === 0) return;

    // Fetch the contiguous window covering all missing rows,
    // expanded to a full FETCH_LIMIT window for efficiency
    const fetchOffset = missing[0];
    const fetchLimit  = Math.min(FETCH_LIMIT, this.total - fetchOffset);

    this._fetchPending = true;
    await this._fetchRows(fetchOffset, fetchLimit);
    this._fetchPending = false;

    // Re-paint after fetch
    this._paintRows(firstVisible, lastVisible);

    // If scroll moved while we were fetching, handle it now
    if (this._scrollDirty) {
      this._scrollDirty = false;
      this._handleScroll();
    }
  }

  async _fetchRows(offset, limit) {
    // Cancel any previous in-flight fetch
    if (this._fetchController) {
      this._fetchController.abort();
    }
    const controller = new AbortController();
    this._fetchController = controller;

    try {
      const result = await this.fetchWindow(offset, limit, controller.signal);
      if (controller.signal.aborted) return;

      // Update total if it changed (shouldn't during a session, but be safe)
      if (result.total !== this.total) {
        this.total = result.total;
        this._updateInnerHeight();
      }

      // Cache rows
      for (let i = 0; i < result.rows.length; i++) {
        this.rows[offset + i] = result.rows[i];
      }
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.error('[VirtualScroller] fetch error:', err);
    } finally {
      if (this._fetchController === controller) {
        this._fetchController = null;
      }
    }
  }

  _paintRows(firstVisible, lastVisible) {
    const needed = new Set();
    for (let i = firstVisible; i <= lastVisible; i++) needed.add(i);

    // Release pool slots that are no longer in the visible range
    for (const slot of this._pool) {
      if (slot.rowIndex !== -1 && !needed.has(slot.rowIndex)) {
        slot.el.style.display = 'none';
        slot.rowIndex = -1;
      }
    }

    // Build set of already-rendered row indices
    const alreadyRendered = new Set();
    for (const slot of this._pool) {
      if (slot.rowIndex !== -1) alreadyRendered.add(slot.rowIndex);
    }

    // Assign free pool slots to rows that need rendering
    let freeSlotIdx = 0;

    const getFreeSlot = () => {
      while (freeSlotIdx < this._pool.length && this._pool[freeSlotIdx].rowIndex !== -1) {
        freeSlotIdx++;
      }
      return freeSlotIdx < this._pool.length ? this._pool[freeSlotIdx++] : null;
    };

    for (let rowIndex = firstVisible; rowIndex <= lastVisible; rowIndex++) {
      if (alreadyRendered.has(rowIndex)) continue;

      const rowData = this.rows[rowIndex];
      if (!rowData) continue; // not yet fetched — will appear after next fetch

      const slot = getFreeSlot();
      if (!slot) break; // pool exhausted (shouldn't happen with correct POOL_SIZE)

      slot.rowIndex = rowIndex;
      this._renderRow(slot.el, rowData, rowIndex);
    }
  }

  _renderRow(el, row, rowIndex) {
    const top = rowIndex * ROW_HEIGHT;
    el.style.top = '0';
    el.style.transform = `translateY(${top}px)`;
    el.style.display = 'flex';
    el.className = `log-row ${rowIndex % 2 === 0 ? 'even' : 'odd'}`;

    const ts  = formatTimestamp(row.ts);
    const sev = row.severity || '';
    const svc = escapeHtml(row.service  || '');
    const msg = escapeHtml(row.message  || '');

    el.innerHTML = `<div class="col-ts">${ts}</div><div class="col-severity"><span class="severity-pill ${sev}">${sev}</span></div><div class="col-service">${svc}</div><div class="col-message">${msg}</div>`;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatTimestamp(isoStr) {
  if (!isoStr) return '';
  try {
    const d  = new Date(isoStr);
    const y  = d.getUTCFullYear();
    const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dy = String(d.getUTCDate()).padStart(2, '0');
    const h  = String(d.getUTCHours()).padStart(2, '0');
    const mi = String(d.getUTCMinutes()).padStart(2, '0');
    const s  = String(d.getUTCSeconds()).padStart(2, '0');
    return `${y}-${mo}-${dy} ${h}:${mi}:${s}`;
  } catch {
    return isoStr;
  }
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
