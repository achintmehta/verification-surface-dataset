/**
 * Log Explorer – Virtualized Frontend
 *
 * Architecture:
 *  - Virtual scroller: only visible rows + overscan exist in the DOM.
 *  - Scroll position → row offset → fetch window from API.
 *  - Debounced search, stale-response cancellation via generation counter.
 *  - Severity color-coding, row count badge.
 */

const API_BASE = '/api';
const ROW_HEIGHT = 36;          // px – must match CSS --row-height
const WINDOW_SIZE = 100;        // rows fetched per request (≤ 200)
const OVERSCAN = 10;            // extra rows above/below viewport
const DEBOUNCE_MS = 250;        // search debounce delay

// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  total: 0,
  severity: '',
  query: '',
  scrollTop: 0,
  rows: [],           // currently fetched rows
  fetchOffset: 0,     // offset of first row in `rows`
  loading: false,
  generation: 0,      // incremented on every filter/scroll change to cancel stale fetches
};

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const scrollContainer = document.getElementById('scroll-container');
const scrollSpacer    = document.getElementById('scroll-spacer');
const rowsContainer   = document.getElementById('rows-container');
const searchInput     = document.getElementById('search-input');
const searchClear     = document.getElementById('search-clear');
const severitySelect  = document.getElementById('severity-select');
const rowCountEl      = document.getElementById('row-count');
const statusText      = document.getElementById('status-text');

// ─── Utilities ────────────────────────────────────────────────────────────────
function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

function formatTs(isoString) {
  // Format: 2024-01-15 14:32:07.123
  const d = new Date(isoString);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
         `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function highlightMatch(text, query) {
  if (!query) return escapeHtml(text);
  const escaped = escapeHtml(text);
  const escapedQuery = escapeHtml(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return escaped.replace(
    new RegExp(escapedQuery, 'gi'),
    (m) => `<span class="match-highlight">${m}</span>`
  );
}

function setStatus(msg) {
  statusText.textContent = msg;
}

// ─── API ──────────────────────────────────────────────────────────────────────
async function fetchLogs(offset, limit, severity, q, generation) {
  const params = new URLSearchParams({ offset, limit });
  if (severity) params.set('severity', severity);
  if (q) params.set('q', q);

  const url = `${API_BASE}/logs?${params}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: resp.statusText }));
    throw new Error(err.error || resp.statusText);
  }
  return resp.json(); // { total, rows }
}

// ─── Virtual Scroller ─────────────────────────────────────────────────────────

/**
 * Compute which row offset the current scrollTop maps to,
 * then decide if we need to fetch a new window.
 */
function getVisibleRange() {
  const viewportHeight = scrollContainer.clientHeight;
  const firstVisible = Math.floor(state.scrollTop / ROW_HEIGHT);
  const lastVisible  = Math.min(
    state.total - 1,
    Math.ceil((state.scrollTop + viewportHeight) / ROW_HEIGHT)
  );
  return { firstVisible, lastVisible };
}

/**
 * Determine the fetch offset for a given first-visible row.
 * We align to WINDOW_SIZE boundaries so repeated scrolls reuse cached windows.
 */
function computeFetchOffset(firstVisible) {
  const windowIndex = Math.floor(firstVisible / WINDOW_SIZE);
  return windowIndex * WINDOW_SIZE;
}

/**
 * Render the visible rows from state.rows into the DOM.
 * Only rows intersecting [firstVisible - OVERSCAN, lastVisible + OVERSCAN] are rendered.
 */
function renderRows() {
  const { firstVisible, lastVisible } = getVisibleRange();
  const renderStart = Math.max(0, firstVisible - OVERSCAN);
  const renderEnd   = Math.min(state.total - 1, lastVisible + OVERSCAN);

  // Update spacer height to represent total virtual height
  const totalHeight = state.total * ROW_HEIGHT;
  scrollSpacer.style.height = `${totalHeight}px`;

  if (state.total === 0) {
    rowsContainer.innerHTML = `
      <div class="empty-state" style="position:absolute;top:0;left:0;right:0;">
        <div class="icon">🔍</div>
        <div class="title">No logs found</div>
        <div class="subtitle">Try adjusting your filters</div>
      </div>`;
    return;
  }

  // Position the rows container at the render start
  const topOffset = renderStart * ROW_HEIGHT;
  rowsContainer.style.transform = `translateY(${topOffset}px)`;

  // Build rows HTML
  const fragments = [];
  for (let rowIdx = renderStart; rowIdx <= renderEnd; rowIdx++) {
    // rowIdx is absolute index in the filtered result set
    const localIdx = rowIdx - state.fetchOffset;
    const row = state.rows[localIdx];

    if (!row) {
      // Row not yet loaded – show placeholder
      fragments.push(
        `<div class="log-row" style="height:${ROW_HEIGHT}px;opacity:0.3;">` +
        `<div class="col-ts">…</div>` +
        `<div class="col-severity"></div>` +
        `<div class="col-service"></div>` +
        `<div class="col-message">Loading…</div>` +
        `</div>`
      );
      continue;
    }

    const ts      = formatTs(row.ts);
    const sev     = row.severity;
    const service = escapeHtml(row.service);
    const message = highlightMatch(row.message, state.query);

    fragments.push(
      `<div class="log-row severity-${sev}" data-row="${rowIdx}">` +
      `<div class="col-ts">${ts}</div>` +
      `<div class="col-severity"><span class="severity-badge badge-${sev}">${sev}</span></div>` +
      `<div class="col-service">${service}</div>` +
      `<div class="col-message">${message}</div>` +
      `</div>`
    );
  }

  rowsContainer.innerHTML = fragments.join('');
}

/**
 * Main scroll handler: determine if we need to fetch a new window,
 * then render.
 */
async function onScroll() {
  state.scrollTop = scrollContainer.scrollTop;

  const { firstVisible } = getVisibleRange();
  const neededFetchOffset = computeFetchOffset(firstVisible);

  // Check if the needed rows are already in our window
  const windowEnd = state.fetchOffset + state.rows.length - 1;
  const needsFetch =
    neededFetchOffset !== state.fetchOffset ||
    state.rows.length === 0 ||
    firstVisible < state.fetchOffset ||
    firstVisible > windowEnd;

  if (needsFetch) {
    await loadWindow(neededFetchOffset);
  } else {
    renderRows();
  }
}

/**
 * Fetch a window of rows starting at `offset` and render.
 * Uses generation counter to discard stale responses.
 */
async function loadWindow(offset) {
  const gen = ++state.generation;
  state.loading = true;
  setStatus('Loading…');

  try {
    const { total, rows } = await fetchLogs(
      offset,
      WINDOW_SIZE,
      state.severity,
      state.query,
      gen
    );

    // Discard if a newer request has been issued
    if (gen !== state.generation) return;

    state.total = total;
    state.rows = rows;
    state.fetchOffset = offset;

    updateRowCount();
    renderRows();
    setStatus(`Showing rows ${offset + 1}–${Math.min(offset + rows.length, total)} of ${total.toLocaleString()}`);
  } catch (err) {
    if (gen !== state.generation) return;
    setStatus(`Error: ${err.message}`);
    console.error(err);
  } finally {
    if (gen === state.generation) {
      state.loading = false;
    }
  }
}

/**
 * Reset to top and reload with current filters.
 */
async function resetAndLoad() {
  const gen = ++state.generation;

  // Reset scroll position
  scrollContainer.scrollTop = 0;
  state.scrollTop = 0;
  state.rows = [];
  state.fetchOffset = 0;
  state.total = 0;

  // Clear rows immediately
  scrollSpacer.style.height = '0px';
  rowsContainer.innerHTML = '';
  rowCountEl.textContent = 'Loading…';
  setStatus('Loading…');

  state.loading = true;

  try {
    const { total, rows } = await fetchLogs(
      0,
      WINDOW_SIZE,
      state.severity,
      state.query,
      gen
    );

    if (gen !== state.generation) return;

    state.total = total;
    state.rows = rows;
    state.fetchOffset = 0;

    updateRowCount();
    renderRows();
    setStatus(
      total === 0
        ? 'No results'
        : `Showing rows 1–${Math.min(rows.length, total)} of ${total.toLocaleString()}`
    );
  } catch (err) {
    if (gen !== state.generation) return;
    setStatus(`Error: ${err.message}`);
    rowCountEl.textContent = 'Error';
    console.error(err);
  } finally {
    if (gen === state.generation) {
      state.loading = false;
    }
  }
}

function updateRowCount() {
  const { total, severity, query } = state;
  let label = `${total.toLocaleString()} rows`;
  if (severity || query) {
    label += ' (filtered)';
  }
  rowCountEl.textContent = label;
}

// ─── Event Handlers ───────────────────────────────────────────────────────────

// Scroll
scrollContainer.addEventListener('scroll', () => {
  state.scrollTop = scrollContainer.scrollTop;
  onScroll();
}, { passive: true });

// Severity filter
severitySelect.addEventListener('change', () => {
  state.severity = severitySelect.value;
  resetAndLoad();
});

// Search input (debounced)
const debouncedSearch = debounce(() => {
  state.query = searchInput.value.trim();
  searchClear.hidden = state.query === '';
  resetAndLoad();
}, DEBOUNCE_MS);

searchInput.addEventListener('input', debouncedSearch);

// Clear search
searchClear.addEventListener('click', () => {
  searchInput.value = '';
  searchClear.hidden = true;
  state.query = '';
  resetAndLoad();
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function boot() {
  setStatus('Connecting to API…');
  rowCountEl.textContent = 'Loading…';

  // Initial load
  await resetAndLoad();
}

boot();
