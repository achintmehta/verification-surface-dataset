// Log Explorer - Virtual Scroll Client

const API_BASE = '/api';
const ROW_HEIGHT = 36;
const OVERSCAN = 10; // extra rows above and below viewport
const FETCH_WINDOW = 100; // rows fetched per request
const DEBOUNCE_MS = 250;

// State
let state = {
  total: 0,
  severity: '',
  query: '',
  cache: new Map(), // Map<string, { rows: Map<number, row>, total: number }>
  fetchVersion: 0, // incremented on filter change to ignore stale responses
  pendingFetches: new Set(), // track in-flight page keys
  stats: null,
};

// DOM refs
const scroller = document.getElementById('virtual-scroller');
const spacer = document.getElementById('scroll-spacer');
const rowContainer = document.getElementById('row-container');
const severityFilter = document.getElementById('severity-filter');
const searchInput = document.getElementById('search-input');
const searchIndicator = document.getElementById('search-indicator');
const rowCountEl = document.getElementById('row-count');
const severityBadgesEl = document.getElementById('severity-badges');
const loadingOverlay = document.getElementById('loading-overlay');

// --- API ---

async function fetchLogs(offset, limit, severity, q, version) {
  const params = new URLSearchParams();
  params.set('offset', offset);
  params.set('limit', limit);
  if (severity) params.set('severity', severity);
  if (q) params.set('q', q);

  const resp = await fetch(`${API_BASE}/logs?${params}`);
  if (!resp.ok) throw new Error(`API error: ${resp.status}`);
  return { data: await resp.json(), version };
}

async function fetchStats() {
  const resp = await fetch(`${API_BASE}/stats`);
  if (!resp.ok) throw new Error(`API error: ${resp.status}`);
  return resp.json();
}

// --- Cache ---

function getCacheKey() {
  return `${state.severity}::${state.query}`;
}

function getCachedRow(index) {
  const key = getCacheKey();
  const cache = state.cache.get(key);
  if (!cache) return null;
  return cache.rows.get(index) || null;
}

function setCachedRows(rows, startOffset) {
  const key = getCacheKey();
  let cache = state.cache.get(key);
  if (!cache) {
    cache = { rows: new Map(), total: state.total };
    state.cache.set(key, cache);
  }
  rows.forEach((row, i) => {
    cache.rows.set(startOffset + i, row);
  });

  // Limit cache size: keep max 5 filter combos
  if (state.cache.size > 5) {
    const firstKey = state.cache.keys().next().value;
    if (firstKey !== key) state.cache.delete(firstKey);
  }
}

// --- Virtual Scroller ---

function getVisibleRange() {
  const scrollTop = scroller.scrollTop;
  const viewportHeight = scroller.clientHeight;

  const startRow = Math.floor(scrollTop / ROW_HEIGHT);
  const endRow = Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT);

  const overscanStart = Math.max(0, startRow - OVERSCAN);
  const overscanEnd = Math.min(state.total, endRow + OVERSCAN);

  return { startRow, endRow, overscanStart, overscanEnd };
}

function formatTimestamp(ts) {
  const d = new Date(ts);
  return d.toISOString().replace('T', ' ').slice(0, 23);
}

function renderRows() {
  const { overscanStart, overscanEnd } = getVisibleRange();

  // Determine which pages we need to fetch
  const neededPages = new Set();
  for (let i = overscanStart; i < overscanEnd; i++) {
    if (!getCachedRow(i)) {
      const pageStart = Math.floor(i / FETCH_WINDOW) * FETCH_WINDOW;
      neededPages.add(pageStart);
    }
  }

  // Trigger fetches for missing pages
  for (const pageStart of neededPages) {
    const pageKey = `${getCacheKey()}::${pageStart}`;
    if (!state.pendingFetches.has(pageKey)) {
      state.pendingFetches.add(pageKey);
      const version = state.fetchVersion;
      fetchLogs(pageStart, FETCH_WINDOW, state.severity, state.query, version)
        .then(({ data, version: v }) => {
          state.pendingFetches.delete(pageKey);
          // Ignore stale responses
          if (v !== state.fetchVersion) return;
          setCachedRows(data.rows, pageStart);
          // Update total from server
          if (data.total !== state.total) {
            state.total = data.total;
            updateSpacerHeight();
            updateRowCount();
          }
          renderRows();
        })
        .catch(err => {
          state.pendingFetches.delete(pageKey);
          console.error('Fetch error:', err);
        });
    }
  }

  // Build DOM for visible range
  const fragment = document.createDocumentFragment();
  const existingRows = rowContainer.children;
  const rowsNeeded = overscanEnd - overscanStart;

  // Track which element indices to reuse
  let elIdx = 0;

  for (let i = overscanStart; i < overscanEnd; i++) {
    const row = getCachedRow(i);
    let el;

    if (elIdx < existingRows.length) {
      el = existingRows[elIdx];
    } else {
      el = createRowElement();
      fragment.appendChild(el);
    }

    const yPos = i * ROW_HEIGHT;
    el.style.transform = `translateY(${yPos}px)`;
    el.style.position = 'absolute';
    el.style.width = '100%';

    if (row) {
      populateRow(el, row);
      el.style.visibility = 'visible';
    } else {
      clearRow(el);
      el.style.visibility = 'hidden';
    }

    elIdx++;
  }

  // Remove excess elements
  while (rowContainer.children.length > elIdx) {
    rowContainer.removeChild(rowContainer.lastChild);
  }

  // Append new elements
  if (fragment.children.length > 0) {
    rowContainer.appendChild(fragment);
  }
}

function createRowElement() {
  const el = document.createElement('div');
  el.className = 'log-row';
  el.innerHTML = `
    <div class="col col-ts"></div>
    <div class="col col-severity"><span class="severity-tag"></span></div>
    <div class="col col-service"></div>
    <div class="col col-message"></div>
  `;
  return el;
}

function populateRow(el, row) {
  const cols = el.children;
  cols[0].textContent = formatTimestamp(row.ts);
  const tag = cols[1].firstElementChild;
  tag.textContent = row.severity;
  tag.className = `severity-tag ${row.severity}`;
  cols[2].textContent = row.service;
  cols[3].textContent = row.message;
}

function clearRow(el) {
  const cols = el.children;
  cols[0].textContent = '';
  cols[1].firstElementChild.textContent = '';
  cols[1].firstElementChild.className = 'severity-tag';
  cols[2].textContent = '';
  cols[3].textContent = '';
}

function updateSpacerHeight() {
  spacer.style.height = `${state.total * ROW_HEIGHT}px`;
}

function updateRowCount() {
  const { overscanStart, overscanEnd } = getVisibleRange();
  const visibleCount = Math.min(overscanEnd, state.total) - overscanStart;
  rowCountEl.textContent = `Showing ${Math.max(0, visibleCount)} of ${state.total.toLocaleString()} logs`;
}

// --- Filter Handling ---

function resetAndRefetch() {
  // Increment version to invalidate stale responses
  state.fetchVersion++;
  state.pendingFetches.clear();

  // Reset scroll
  scroller.scrollTop = 0;

  // Load initial window with version tracking
  const version = state.fetchVersion;
  searchIndicator.classList.remove('hidden');

  fetchLogs(0, FETCH_WINDOW, state.severity, state.query, version)
    .then(({ data, version: v }) => {
      searchIndicator.classList.add('hidden');
      if (v !== state.fetchVersion) return;

      state.total = data.total;
      updateSpacerHeight();

      // Clear cache for this filter combo and repopulate
      const key = getCacheKey();
      state.cache.set(key, { rows: new Map(), total: data.total });
      setCachedRows(data.rows, 0);

      updateRowCount();
      renderRows();
    })
    .catch(err => {
      searchIndicator.classList.add('hidden');
      console.error('Filter fetch error:', err);
    });
}

let searchTimeout = null;

severityFilter.addEventListener('change', () => {
  state.severity = severityFilter.value;
  resetAndRefetch();
});

searchInput.addEventListener('input', () => {
  if (searchTimeout) clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    state.query = searchInput.value.trim();
    resetAndRefetch();
  }, DEBOUNCE_MS);
});

// --- Scroll Handler ---

let scrollRAF = null;

scroller.addEventListener('scroll', () => {
  if (scrollRAF) return;
  scrollRAF = requestAnimationFrame(() => {
    scrollRAF = null;
    renderRows();
    updateRowCount();
  });
});

// --- Stats / Badges ---

async function loadStats() {
  try {
    const stats = await fetchStats();
    state.stats = stats;
    renderBadges(stats);
  } catch (err) {
    console.error('Stats error:', err);
  }
}

function renderBadges(stats) {
  severityBadgesEl.innerHTML = '';
  for (const [sev, count] of Object.entries(stats.counts)) {
    const badge = document.createElement('span');
    badge.className = `severity-badge ${sev}`;
    badge.textContent = `${sev}: ${count.toLocaleString()}`;
    severityBadgesEl.appendChild(badge);
  }
}

// --- Init ---

async function init() {
  try {
    // Load stats and initial data in parallel
    const [statsResult] = await Promise.all([
      fetchStats(),
    ]);

    state.stats = statsResult;
    renderBadges(statsResult);

    // Load initial page
    const version = state.fetchVersion;
    const { data } = await fetchLogs(0, FETCH_WINDOW, '', '', version);

    state.total = data.total;
    updateSpacerHeight();
    setCachedRows(data.rows, 0);
    updateRowCount();
    renderRows();

    loadingOverlay.classList.add('hidden');
  } catch (err) {
    console.error('Init error:', err);
    document.querySelector('.loading-spinner').textContent = 
      'Failed to load logs. Is the server running?';
  }
}

init();
