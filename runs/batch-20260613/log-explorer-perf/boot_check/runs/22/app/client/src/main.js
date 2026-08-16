// ── Constants ────────────────────────────────────────────────────────────────

const ROW_HEIGHT = 28;        // Must match CSS .log-row height
const OVERSCAN = 10;          // Extra rows above/below viewport
const FETCH_WINDOW = 100;     // Rows per API call
const DEBOUNCE_MS = 250;      // Search debounce
const API_BASE = '/api';

// ── State ────────────────────────────────────────────────────────────────────

let state = {
  total: 0,
  severity: '',
  searchQuery: '',
  // Cache of fetched rows: Map<offset, { rows, timestamp }>
  cache: new Map(),
  // The currently rendered range
  renderedStart: -1,
  renderedEnd: -1,
  // Monotonic request counter to detect stale responses
  requestGeneration: 0,
  // Current filter generation — bumped on filter change to invalidate cache
  filterGeneration: 0,
};

// ── DOM references ───────────────────────────────────────────────────────────

const scrollContainer = document.getElementById('scroll-container');
const scrollSpacer = document.getElementById('scroll-spacer');
const viewport = document.getElementById('viewport');
const rowCountEl = document.getElementById('row-count');
const severitySelect = document.getElementById('severity-select');
const searchInput = document.getElementById('search-input');
const badgesEl = document.getElementById('severity-badges');

// ── Utility ──────────────────────────────────────────────────────────────────

function formatTimestamp(ts) {
  const d = new Date(ts);
  return d.toISOString().replace('T', ' ').replace('Z', '').slice(0, 23);
}

function debounce(fn, ms) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), ms);
  };
}

// ── API ──────────────────────────────────────────────────────────────────────

// In-flight abort controllers keyed by request purpose
let inflightControllers = new Map();

async function fetchLogs(offset, limit, filterGen) {
  const params = new URLSearchParams();
  params.set('offset', String(offset));
  params.set('limit', String(limit));
  if (state.severity) params.set('severity', state.severity);
  if (state.searchQuery) params.set('q', state.searchQuery);

  const cacheKey = `${offset}:${limit}`;

  // Cancel any in-flight request for this exact key
  if (inflightControllers.has(cacheKey)) {
    inflightControllers.get(cacheKey).abort();
  }

  const controller = new AbortController();
  inflightControllers.set(cacheKey, controller);

  try {
    const res = await fetch(`${API_BASE}/logs?${params}`, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    // Only apply if this response is for the current filter generation
    if (filterGen !== state.filterGeneration) return null;

    // Update total
    state.total = data.total;
    updateScrollHeight();
    updateRowCount();

    // Cache the rows
    for (let i = 0; i < data.rows.length; i++) {
      state.cache.set(offset + i, data.rows[i]);
    }

    return data;
  } catch (err) {
    if (err.name === 'AbortError') return null;
    console.error('Fetch error:', err);
    return null;
  } finally {
    inflightControllers.delete(cacheKey);
  }
}

async function fetchStats() {
  try {
    const res = await fetch(`${API_BASE}/stats`);
    const data = await res.json();
    renderBadges(data.bySeverity);
  } catch (err) {
    console.error('Stats fetch error:', err);
  }
}

// ── Rendering ────────────────────────────────────────────────────────────────

function renderBadges(bySeverity) {
  if (!bySeverity) return;
  const severities = ['debug', 'info', 'warn', 'error'];
  badgesEl.innerHTML = severities.map(s =>
    `<span class="badge badge-${s}">${s}: ${(bySeverity[s] || 0).toLocaleString()}</span>`
  ).join('');
}

function createRowElement(row, index) {
  const el = document.createElement('div');
  el.className = 'log-row';
  el.innerHTML = `
    <div class="col col-ts">${formatTimestamp(row.ts)}</div>
    <div class="col col-severity sev-${row.severity}">${row.severity.toUpperCase()}</div>
    <div class="col col-service">${row.service}</div>
    <div class="col col-message">${escapeHtml(row.message)}</div>
  `;
  return el;
}

function createPlaceholderRow(index) {
  const el = document.createElement('div');
  el.className = 'log-row';
  el.innerHTML = `
    <div class="col col-ts" style="color:#6c7086">Loading...</div>
    <div class="col col-severity"></div>
    <div class="col col-service"></div>
    <div class="col col-message"></div>
  `;
  return el;
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function updateScrollHeight() {
  scrollSpacer.style.height = `${state.total * ROW_HEIGHT}px`;
}

function updateRowCount() {
  const visibleCount = viewport.children.length;
  rowCountEl.textContent = `${Math.min(visibleCount, state.total)} of ${state.total.toLocaleString()} logs`;
}

// ── Virtual Scroll Engine ────────────────────────────────────────────────────

// Set of offsets currently being fetched
const pendingFetches = new Set();

async function renderVisibleRows() {
  const scrollTop = scrollContainer.scrollTop;
  const containerHeight = scrollContainer.clientHeight;

  const firstVisible = Math.floor(scrollTop / ROW_HEIGHT);
  const visibleCount = Math.ceil(containerHeight / ROW_HEIGHT);

  let start = Math.max(0, firstVisible - OVERSCAN);
  let end = Math.min(state.total, firstVisible + visibleCount + OVERSCAN);

  if (start === state.renderedStart && end === state.renderedEnd) return;

  state.renderedStart = start;
  state.renderedEnd = end;

  // Position the viewport
  viewport.style.transform = `translateY(${start * ROW_HEIGHT}px)`;

  // Determine which rows we need to fetch
  const missingRanges = [];
  let rangeStart = -1;

  for (let i = start; i < end; i++) {
    if (!state.cache.has(i)) {
      if (rangeStart === -1) rangeStart = i;
    } else {
      if (rangeStart !== -1) {
        missingRanges.push([rangeStart, i]);
        rangeStart = -1;
      }
    }
  }
  if (rangeStart !== -1) missingRanges.push([rangeStart, end]);

  // Render what we have now
  renderRows(start, end);

  // Fetch missing ranges
  const filterGen = state.filterGeneration;
  for (const [rs, re] of missingRanges) {
    // Align to FETCH_WINDOW boundaries for better cache reuse
    const alignedStart = Math.floor(rs / FETCH_WINDOW) * FETCH_WINDOW;
    const alignedEnd = Math.min(
      Math.ceil(re / FETCH_WINDOW) * FETCH_WINDOW,
      state.total
    );

    for (let offset = alignedStart; offset < alignedEnd; offset += FETCH_WINDOW) {
      const fetchKey = `${filterGen}:${offset}`;
      if (pendingFetches.has(fetchKey)) continue;

      // Already have all rows in this window?
      let allCached = true;
      for (let j = offset; j < Math.min(offset + FETCH_WINDOW, state.total); j++) {
        if (!state.cache.has(j)) { allCached = false; break; }
      }
      if (allCached) continue;

      pendingFetches.add(fetchKey);
      const limit = Math.min(FETCH_WINDOW, state.total - offset);
      fetchLogs(offset, limit, filterGen).then(() => {
        pendingFetches.delete(fetchKey);
        // Re-render if still in the same filter generation and range
        if (filterGen === state.filterGeneration) {
          renderRows(state.renderedStart, state.renderedEnd);
          updateRowCount();
        }
      });
    }
  }
}

function renderRows(start, end) {
  // Build new content
  const fragment = document.createDocumentFragment();
  for (let i = start; i < end; i++) {
    const row = state.cache.get(i);
    if (row) {
      fragment.appendChild(createRowElement(row, i));
    } else {
      fragment.appendChild(createPlaceholderRow(i));
    }
  }

  // Replace viewport contents
  viewport.innerHTML = '';
  viewport.appendChild(fragment);
}

// ── Filter handlers ──────────────────────────────────────────────────────────

function onFilterChange() {
  // Cancel all in-flight requests
  for (const [, ctrl] of inflightControllers) {
    ctrl.abort();
  }
  inflightControllers.clear();
  pendingFetches.clear();

  // Bump filter generation
  state.filterGeneration++;
  state.cache.clear();
  state.renderedStart = -1;
  state.renderedEnd = -1;
  state.total = 0;

  // Reset scroll
  scrollContainer.scrollTop = 0;
  viewport.innerHTML = '';

  // Fetch initial data
  initialFetch();
}

async function initialFetch() {
  const filterGen = state.filterGeneration;
  const data = await fetchLogs(0, FETCH_WINDOW, filterGen);
  if (data && filterGen === state.filterGeneration) {
    renderVisibleRows();
  }
}

severitySelect.addEventListener('change', () => {
  state.severity = severitySelect.value;
  onFilterChange();
});

const debouncedSearch = debounce(() => {
  state.searchQuery = searchInput.value.trim();
  onFilterChange();
}, DEBOUNCE_MS);

searchInput.addEventListener('input', debouncedSearch);

// ── Scroll handler ───────────────────────────────────────────────────────────

let scrollRAF = null;
scrollContainer.addEventListener('scroll', () => {
  if (scrollRAF) return;
  scrollRAF = requestAnimationFrame(() => {
    scrollRAF = null;
    renderVisibleRows();
  });
}, { passive: true });

// ── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  await fetchStats();
  await initialFetch();
}

init();
