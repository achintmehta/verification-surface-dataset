/**
 * Virtual Scroller
 *
 * Architecture:
 * - The scroll container has a tall spacer that creates the full scroll height
 *   (total * rowHeight px).
 * - A pool of DOM row elements is positioned absolutely at the correct offset.
 * - On scroll, we compute which row indices are visible, fetch the window from
 *   the API if needed, and update the DOM rows in place.
 * - A window cache prevents redundant fetches for recently-seen offsets.
 * - Requests are sequenced: a new scroll position cancels the previous pending
 *   fetch (via the API client's AbortController) and issues a fresh one.
 *
 * Key invariants:
 * - DOM row count ≤ visibleRows + 2*overscan (typically ~30-50 rows max)
 * - The spacer height always equals total * rowHeight
 * - Rows are positioned via translateY, not top, to avoid layout thrash
 */

const FETCH_LIMIT = 100; // rows per API request
const CACHE_SIZE  = 20;  // number of windows to keep in LRU cache

export function createVirtualScroller({
  container,
  spacer,
  rowsEl,
  rowHeight,
  overscan,
  fetchWindow,
  onTotalChange,
  onLoadingChange,
}) {
  // ---- State ----
  let total         = 0;
  let scrollTop     = 0;
  let containerH    = 0;
  let rowPool       = [];       // reusable DOM elements
  let windowCache   = [];       // LRU cache: [{offset, rows}]
  let fetchSeq      = 0;        // monotonically increasing; stale responses are dropped
  let activeFetchSeq = -1;      // seq of the currently in-flight fetch
  let rafPending    = false;

  // ---- Initialization ----
  const resizeObserver = new ResizeObserver(() => {
    containerH = container.clientHeight;
    scheduleRender();
  });
  resizeObserver.observe(container);
  containerH = container.clientHeight;

  container.addEventListener('scroll', () => {
    scrollTop = container.scrollTop;
    scheduleRender();
  }, { passive: true });

  // ---- Public API ----
  function resetAndFetch() {
    // Reset scroll position and clear cache
    container.scrollTop = 0;
    scrollTop = 0;
    windowCache = [];
    total = 0;
    spacer.style.height = '0px';
    clearRows();
    // Issue a fresh fetch from offset 0
    const seq = ++fetchSeq;
    doFetch(0, seq);
  }

  // ---- Render scheduling (rAF-batched) ----
  function scheduleRender() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      render();
    });
  }

  // ---- Render ----
  function render() {
    if (total === 0) return;

    const visibleStart = Math.floor(scrollTop / rowHeight);
    const visibleCount = Math.ceil(containerH / rowHeight) + 1;
    const visibleEnd   = Math.min(visibleStart + visibleCount, total);

    const windowStart = Math.max(0, visibleStart - overscan);
    const windowEnd   = Math.min(total, visibleEnd + overscan);

    // Check if we have cached data for this window
    const cached = findInCache(windowStart, windowEnd);

    if (cached) {
      renderRows(windowStart, cached);
    } else {
      // Fetch the window; keep showing whatever is currently rendered
      const seq = ++fetchSeq;
      doFetch(windowStart, seq);
    }
  }

  // ---- Fetch ----
  async function doFetch(offset, seq) {
    // Mark this as the active fetch
    activeFetchSeq = seq;
    onLoadingChange(true);

    try {
      const result = await fetchWindow(offset, FETCH_LIMIT);

      // Stale response — a newer fetch has been issued
      if (seq !== fetchSeq || result === null) {
        // If there's no newer fetch in flight, clear loading
        if (activeFetchSeq === seq) {
          onLoadingChange(false);
        }
        return;
      }

      activeFetchSeq = -1;
      onLoadingChange(false);

      // Update total
      const totalChanged = result.total !== total;
      if (totalChanged) {
        total = result.total;
        spacer.style.height = `${total * rowHeight}px`;
        onTotalChange(total);
      }

      // Cache the result
      addToCache(offset, result.rows);

      // Re-render with fresh data
      const visibleStart = Math.floor(scrollTop / rowHeight);
      const visibleCount = Math.ceil(containerH / rowHeight) + 1;
      const visibleEnd   = Math.min(visibleStart + visibleCount, total);
      const windowStart  = Math.max(0, visibleStart - overscan);
      const windowEnd    = Math.min(total, visibleEnd + overscan);

      const cached = findInCache(windowStart, windowEnd);
      if (cached) {
        renderRows(windowStart, cached);
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error('[scroller] Fetch error:', err);
        onLoadingChange(false);
      }
    }
  }

  // ---- Row rendering ----
  function renderRows(startIndex, rows) {
    const count = rows.length;

    if (count === 0) {
      clearRows();
      return;
    }

    // Ensure we have enough DOM elements in the pool
    while (rowPool.length < count) {
      const el = createRowElement();
      rowsEl.appendChild(el);
      rowPool.push(el);
    }

    // Populate and show rows that are needed
    for (let i = 0; i < count; i++) {
      const el  = rowPool[i];
      const row = rows[i];
      const y   = (startIndex + i) * rowHeight;

      el.style.display    = '';
      el.style.transform  = `translateY(${y}px)`;
      populateRow(el, row);
    }

    // Hide excess pool elements
    for (let i = count; i < rowPool.length; i++) {
      rowPool[i].style.display = 'none';
    }
  }

  function clearRows() {
    for (const el of rowPool) {
      el.style.display = 'none';
    }
  }

  function createRowElement() {
    const el = document.createElement('div');
    el.className = 'log-row';
    el.style.cssText = `position:absolute;top:0;left:0;right:0;height:${rowHeight}px;`;

    // Pre-create child elements for each column
    const tsEl  = document.createElement('div');
    tsEl.className = 'col col-ts';

    const sevEl = document.createElement('div');
    sevEl.className = 'col col-severity';

    const svcEl = document.createElement('div');
    svcEl.className = 'col col-service';

    const msgEl = document.createElement('div');
    msgEl.className = 'col col-message';

    el.appendChild(tsEl);
    el.appendChild(sevEl);
    el.appendChild(svcEl);
    el.appendChild(msgEl);

    return el;
  }

  function populateRow(el, row) {
    const children = el.children;
    const tsEl  = children[0];
    const sevEl = children[1];
    const svcEl = children[2];
    const msgEl = children[3];

    // Format timestamp
    tsEl.textContent = formatTs(row.ts);

    // Severity
    sevEl.textContent = row.severity;
    sevEl.className = `col col-severity sev-${row.severity}`;

    // Service
    svcEl.textContent = row.service;

    // Message
    msgEl.textContent = row.message;
  }

  // Pre-allocated date object for formatting
  const _date = new Date();

  function formatTs(isoStr) {
    // Fast path: parse ISO string manually to avoid Date object allocation overhead
    // Format: YYYY-MM-DDTHH:MM:SS.mmmZ
    // Output: YYYY-MM-DD HH:MM:SS.mmm
    if (typeof isoStr === 'string' && isoStr.length >= 23) {
      return isoStr.substring(0, 10) + ' ' + isoStr.substring(11, 23);
    }
    _date.setTime(new Date(isoStr).getTime());
    return _date.toISOString().substring(0, 23).replace('T', ' ');
  }

  // ---- Window cache (LRU) ----
  function addToCache(offset, rows) {
    // Remove existing entry for same offset
    const idx = windowCache.findIndex((e) => e.offset === offset);
    if (idx !== -1) windowCache.splice(idx, 1);
    // Add to front (most recently used)
    windowCache.unshift({ offset, rows });
    // Trim to max size
    if (windowCache.length > CACHE_SIZE) {
      windowCache.length = CACHE_SIZE;
    }
  }

  function findInCache(windowStart, windowEnd) {
    // Find a cached window that fully covers [windowStart, windowEnd)
    for (let i = 0; i < windowCache.length; i++) {
      const entry = windowCache[i];
      const entryEnd = entry.offset + entry.rows.length;
      if (entry.offset <= windowStart && entryEnd >= windowEnd) {
        // Move to front (LRU)
        if (i !== 0) {
          windowCache.splice(i, 1);
          windowCache.unshift(entry);
        }
        // Slice out the relevant rows
        const sliceStart = windowStart - entry.offset;
        const sliceEnd   = windowEnd   - entry.offset;
        return entry.rows.slice(sliceStart, sliceEnd);
      }
    }
    return null;
  }

  return { resetAndFetch };
}
