/**
 * Log Explorer - Virtualized Log Table
 *
 * Architecture:
 * - Virtual scrolling: only renders rows visible in viewport + overscan
 * - Row elements are pre-created and positioned absolutely via `top`
 * - Data is fetched window-by-window from the API with a page cache
 * - Debounced search with monotonic request IDs to discard stale responses
 * - DOM never holds more than MAX_VISIBLE_ROWS row elements
 */

const ROW_HEIGHT = 36;
const OVERSCAN = 10;
const PAGE_SIZE = 100; // rows per API page
const DEBOUNCE_MS = 250;
const API_BASE = '/api';
const MAX_VISIBLE_ROWS = 80; // pre-created row elements (enough for tall viewports)
const MAX_CACHE_ENTRIES = 60;

// ── State ────────────────────────────────────────────────────────────────────
let totalRows = 0;
let currentSeverity = '';
let currentQuery = '';
let filterGeneration = 0; // bumped on every filter change; used to discard stale fetches
let stats = null;

// Page cache: keyed by `${severity}|${query}|${pageIndex}`
const pageCache = new Map();

// In-flight fetch deduplication
const inFlightPages = new Map();

// ── DOM refs ────────────────────────────────────────────────────────────────
const scroller = document.getElementById('virtual-scroller');
const spacer = document.getElementById('scroll-spacer');
const rowPool = document.getElementById('row-pool');
const severitySelect = document.getElementById('severity-select');
const searchInput = document.getElementById('search-input');
const rowCountEl = document.getElementById('row-count');
const severityBadgesEl = document.getElementById('severity-badges');

// ── Row element pool ────────────────────────────────────────────────────────
const rowElements = [];

function createRowElements() {
  for (let i = 0; i < MAX_VISIBLE_ROWS; i++) {
    const row = document.createElement('div');
    row.className = 'log-row';
    row.style.height = `${ROW_HEIGHT}px`;
    row.innerHTML = `
      <div class="col col-ts"></div>
      <div class="col col-severity"></div>
      <div class="col col-service"></div>
      <div class="col col-message"></div>
    `;
    row.style.display = 'none';
    rowPool.appendChild(row);
    rowElements.push({
      el: row,
      cols: row.querySelectorAll('.col'),
      assignedIndex: -1,
    });
  }
}

// ── Cache helpers ───────────────────────────────────────────────────────────
function cacheKey(severity, query, pageIndex) {
  return `${severity}|${query}|${pageIndex}`;
}

function pruneCache() {
  if (pageCache.size <= MAX_CACHE_ENTRIES) return;
  const entries = [...pageCache.entries()].sort((a, b) => a[1].accessedAt - b[1].accessedAt);
  const excess = entries.length - MAX_CACHE_ENTRIES;
  for (let i = 0; i < excess; i++) {
    pageCache.delete(entries[i][0]);
  }
}

// ── API ─────────────────────────────────────────────────────────────────────

/**
 * Fetch a single page. Returns { rows, total } from cache or network.
 * Returns null if the current filterGeneration has changed (stale).
 */
async function fetchPage(pageIndex, severity, query, gen) {
  const key = cacheKey(severity, query, pageIndex);

  // Cache hit
  const cached = pageCache.get(key);
  if (cached) {
    cached.accessedAt = Date.now();
    return { rows: cached.rows, total: cached.total };
  }

  // Deduplicate in-flight
  if (inFlightPages.has(key)) {
    const result = await inFlightPages.get(key);
    if (gen !== filterGeneration) return null;
    return result;
  }

  const offset = pageIndex * PAGE_SIZE;
  const params = new URLSearchParams();
  params.set('offset', String(offset));
  params.set('limit', String(PAGE_SIZE));
  if (severity) params.set('severity', severity);
  if (query) params.set('q', query);

  const promise = fetch(`${API_BASE}/logs?${params}`)
    .then(async (response) => {
      if (!response.ok) {
        console.error('API error:', response.status);
        return null;
      }
      const data = await response.json();
      // Store in cache
      pageCache.set(key, {
        rows: data.rows,
        total: data.total,
        accessedAt: Date.now(),
      });
      pruneCache();
      return { rows: data.rows, total: data.total };
    })
    .catch((err) => {
      console.error('Fetch error:', err);
      return null;
    })
    .finally(() => {
      inFlightPages.delete(key);
    });

  inFlightPages.set(key, promise);
  const result = await promise;
  if (gen !== filterGeneration) return null;
  return result;
}

// ── Rendering ───────────────────────────────────────────────────────────────

function formatTimestamp(ts) {
  const d = new Date(ts);
  const pad2 = (n) => String(n).padStart(2, '0');
  const pad3 = (n) => String(n).padStart(3, '0');
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ` +
         `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}.${pad3(d.getUTCMilliseconds())}`;
}

function renderRow(rowEl, row, rowIndex) {
  const { el, cols } = rowEl;

  if (!row) {
    cols[0].textContent = '...';
    cols[1].innerHTML = '';
    cols[2].textContent = '';
    cols[3].textContent = 'Loading...';
    el.className = 'log-row loading';
  } else {
    cols[0].textContent = formatTimestamp(row.ts);
    cols[1].innerHTML = `<span class="sev-tag sev-tag-${row.severity}">${row.severity}</span>`;
    cols[2].textContent = row.service;
    cols[3].textContent = row.message;
    el.className = `log-row severity-${row.severity}`;
  }

  el.style.top = `${rowIndex * ROW_HEIGHT}px`;
  el.style.display = 'flex';
  rowEl.assignedIndex = rowIndex;
}

/**
 * The core render loop. Determines visible row range, fetches needed pages,
 * and updates DOM elements.
 */
async function renderVisibleRows() {
  const gen = filterGeneration;
  const severity = currentSeverity;
  const query = currentQuery;

  const scrollTop = scroller.scrollTop;
  const viewportHeight = scroller.clientHeight;

  if (totalRows === 0) {
    for (const re of rowElements) {
      re.el.style.display = 'none';
      re.assignedIndex = -1;
    }
    return;
  }

  // Visible range (clamped)
  const firstVisible = Math.floor(scrollTop / ROW_HEIGHT);
  const lastVisible = Math.min(
    Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT),
    totalRows - 1
  );
  const startIndex = Math.max(0, firstVisible - OVERSCAN);
  const endIndex = Math.min(totalRows - 1, lastVisible + OVERSCAN);
  const neededCount = endIndex - startIndex + 1;

  // Pages needed
  const firstPage = Math.floor(startIndex / PAGE_SIZE);
  const lastPage = Math.floor(endIndex / PAGE_SIZE);

  // Kick off fetches for all needed pages
  const fetchPromises = [];
  for (let p = firstPage; p <= lastPage; p++) {
    const key = cacheKey(severity, query, p);
    if (!pageCache.has(key)) {
      fetchPromises.push(fetchPage(p, severity, query, gen));
    }
  }

  if (fetchPromises.length > 0) {
    await Promise.all(fetchPromises);
    // Check staleness
    if (gen !== filterGeneration) return;
  }

  // Render each visible row
  for (let i = 0; i < MAX_VISIBLE_ROWS; i++) {
    const rowEl = rowElements[i];
    const rowIndex = startIndex + i;

    if (i >= neededCount) {
      rowEl.el.style.display = 'none';
      rowEl.assignedIndex = -1;
      continue;
    }

    const pageIndex = Math.floor(rowIndex / PAGE_SIZE);
    const offsetInPage = rowIndex % PAGE_SIZE;
    const key = cacheKey(severity, query, pageIndex);
    const cached = pageCache.get(key);
    const row = cached ? cached.rows[offsetInPage] || null : null;

    renderRow(rowEl, row, rowIndex);
  }
}

function updateRowCount() {
  if (totalRows === 0) {
    rowCountEl.textContent = stats ? 'No matching logs' : 'Loading...';
  } else {
    const rendered = rowElements.filter((r) => r.el.style.display !== 'none').length;
    rowCountEl.textContent = `${rendered} of ${totalRows.toLocaleString()} logs`;
  }
}

// ── Stats / Badges ──────────────────────────────────────────────────────────
async function loadStats() {
  try {
    const response = await fetch(`${API_BASE}/stats`);
    stats = await response.json();
    renderBadges();
  } catch (err) {
    console.error('Failed to load stats:', err);
  }
}

function renderBadges() {
  if (!stats) return;
  severityBadgesEl.innerHTML = ['debug', 'info', 'warn', 'error']
    .map(
      (s) =>
        `<span class="badge badge-${s}">${s}: ${stats.bySeverity[s].toLocaleString()}</span>`
    )
    .join('');
}

// ── Filter application ─────────────────────────────────────────────────────

async function applyFilters() {
  // Bump generation — any in-flight fetches for older generations will be discarded
  const gen = ++filterGeneration;

  // Clear cache (new filter combo means old pages are irrelevant)
  pageCache.clear();
  inFlightPages.clear();

  // Fetch first page to learn the new total
  const result = await fetchPage(0, currentSeverity, currentQuery, gen);
  if (!result || gen !== filterGeneration) return; // stale

  totalRows = result.total;
  spacer.style.height = `${totalRows * ROW_HEIGHT}px`;
  scroller.scrollTop = 0;

  await renderVisibleRows();
  updateRowCount();
}

// ── Event handlers ──────────────────────────────────────────────────────────

let scrollRAF = null;
function onScroll() {
  if (scrollRAF) return;
  scrollRAF = requestAnimationFrame(async () => {
    scrollRAF = null;
    await renderVisibleRows();
    updateRowCount();
  });
}

let debounceTimer = null;
function onSearchInput(e) {
  const value = e.target.value;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    currentQuery = value;
    applyFilters();
  }, DEBOUNCE_MS);
}

function onSeverityChange(e) {
  currentSeverity = e.target.value;
  applyFilters();
}

// ── Init ────────────────────────────────────────────────────────────────────
async function init() {
  createRowElements();

  scroller.addEventListener('scroll', onScroll, { passive: true });
  severitySelect.addEventListener('change', onSeverityChange);
  searchInput.addEventListener('input', onSearchInput);

  await loadStats();
  await applyFilters();
}

init().catch(console.error);
