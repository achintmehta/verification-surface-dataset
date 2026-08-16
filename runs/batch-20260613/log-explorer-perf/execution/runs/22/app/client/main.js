const API_BASE = '/api';
const ROW_HEIGHT = 28;
const OVERSCAN = 10;
const FETCH_BUFFER = 50; // fetch extra rows beyond visible for smoother scrolling
const DEBOUNCE_MS = 250;
const PAGE_SIZE = 200; // max rows per request

// State
let state = {
  total: 0,
  severity: '',
  q: '',
  cache: new Map(), // offset -> { rows, timestamp }
  fetchVersion: 0,  // incremented on filter change to cancel stale
  pendingFetches: new Set(),
  stats: null,
};

// DOM refs
const scrollContainer = document.getElementById('scroll-container');
const scrollSpacer = document.getElementById('scroll-spacer');
const viewport = document.getElementById('viewport');
const severityFilter = document.getElementById('severity-filter');
const searchInput = document.getElementById('search-input');
const rowCountEl = document.getElementById('row-count');
const badgesEl = document.getElementById('severity-badges');

// Loading indicator
const loadingEl = document.createElement('div');
loadingEl.className = 'loading-indicator';
loadingEl.textContent = 'Loading...';
document.body.appendChild(loadingEl);

// ---- API ----

async function fetchLogs(offset, limit, version) {
  const params = new URLSearchParams();
  params.set('offset', offset);
  params.set('limit', Math.min(limit, PAGE_SIZE));
  if (state.severity) params.set('severity', state.severity);
  if (state.q) params.set('q', state.q);

  const res = await fetch(`${API_BASE}/logs?${params}`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  const data = await res.json();

  // Stale check
  if (version !== state.fetchVersion) return null;

  return data;
}

async function fetchStats() {
  const res = await fetch(`${API_BASE}/stats`);
  if (!res.ok) throw new Error(`Stats API error: ${res.status}`);
  return res.json();
}

// ---- Cache ----

function getCachedRows(startIdx, endIdx) {
  const results = [];
  for (let i = startIdx; i < endIdx; i++) {
    // Find which page this index belongs to
    const pageStart = Math.floor(i / PAGE_SIZE) * PAGE_SIZE;
    const cached = state.cache.get(pageStart);
    if (cached) {
      const localIdx = i - pageStart;
      if (localIdx < cached.rows.length) {
        results.push({ index: i, row: cached.rows[localIdx] });
      } else {
        results.push({ index: i, row: null });
      }
    } else {
      results.push({ index: i, row: null });
    }
  }
  return results;
}

function clearCache() {
  state.cache.clear();
}

// ---- Rendering ----

function formatTimestamp(ts) {
  const d = new Date(ts);
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function createRowElement(row, index) {
  const el = document.createElement('div');
  el.className = 'log-row';
  el.style.height = ROW_HEIGHT + 'px';

  if (row) {
    el.innerHTML = `
      <div class="col col-ts">${formatTimestamp(row.ts)}</div>
      <div class="col col-severity"><span class="severity-tag severity-${row.severity}">${row.severity}</span></div>
      <div class="col col-service">${escapeHtml(row.service)}</div>
      <div class="col col-message">${escapeHtml(row.message)}</div>
    `;
  } else {
    el.innerHTML = `
      <div class="col col-ts" style="color:#555">Loading...</div>
      <div class="col col-severity"></div>
      <div class="col col-service"></div>
      <div class="col col-message"></div>
    `;
  }

  return el;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function updateRowCount() {
  const visibleStart = getVisibleRange();
  rowCountEl.textContent = `${state.total.toLocaleString()} logs`;
}

function updateBadges() {
  if (!state.stats) return;
  const s = state.stats.severities;
  badgesEl.innerHTML = `
    <span class="badge badge-debug">D: ${s.debug.toLocaleString()}</span>
    <span class="badge badge-info">I: ${s.info.toLocaleString()}</span>
    <span class="badge badge-warn">W: ${s.warn.toLocaleString()}</span>
    <span class="badge badge-error">E: ${s.error.toLocaleString()}</span>
  `;
}

// ---- Virtual Scrolling ----

function getVisibleRange() {
  const scrollTop = scrollContainer.scrollTop;
  const containerHeight = scrollContainer.clientHeight;

  const startRow = Math.floor(scrollTop / ROW_HEIGHT);
  const visibleCount = Math.ceil(containerHeight / ROW_HEIGHT);

  const rangeStart = Math.max(0, startRow - OVERSCAN);
  const rangeEnd = Math.min(state.total, startRow + visibleCount + OVERSCAN);

  return { rangeStart, rangeEnd, startRow, visibleCount };
}

function render() {
  if (state.total === 0) {
    scrollSpacer.style.height = '0px';
    viewport.innerHTML = '<div style="padding:40px;text-align:center;color:#555">No log entries found</div>';
    return;
  }

  const totalHeight = state.total * ROW_HEIGHT;
  scrollSpacer.style.height = totalHeight + 'px';

  const { rangeStart, rangeEnd } = getVisibleRange();
  const cachedRows = getCachedRows(rangeStart, rangeEnd);

  // Position the viewport
  viewport.style.transform = `translateY(${rangeStart * ROW_HEIGHT}px)`;

  // Build DOM
  const fragment = document.createDocumentFragment();
  const missingPages = new Set();

  for (const { index, row } of cachedRows) {
    fragment.appendChild(createRowElement(row, index));
    if (!row) {
      const pageStart = Math.floor(index / PAGE_SIZE) * PAGE_SIZE;
      missingPages.add(pageStart);
    }
  }

  viewport.innerHTML = '';
  viewport.appendChild(fragment);

  // Fetch missing pages
  for (const pageStart of missingPages) {
    fetchPage(pageStart);
  }
}

async function fetchPage(pageStart) {
  const cacheKey = pageStart;
  if (state.cache.has(cacheKey) || state.pendingFetches.has(cacheKey)) return;

  state.pendingFetches.add(cacheKey);
  showLoading(true);

  const version = state.fetchVersion;

  try {
    const data = await fetchLogs(pageStart, PAGE_SIZE, version);
    if (!data) return; // stale

    state.cache.set(cacheKey, { rows: data.rows, timestamp: Date.now() });

    // Update total if it changed (shouldn't with static corpus, but safe)
    if (data.total !== state.total) {
      state.total = data.total;
      updateRowCount();
    }

    // Re-render if still the same version
    if (version === state.fetchVersion) {
      render();
    }
  } catch (err) {
    console.error('Failed to fetch page:', err);
  } finally {
    state.pendingFetches.delete(cacheKey);
    if (state.pendingFetches.size === 0) showLoading(false);
  }
}

function showLoading(show) {
  loadingEl.classList.toggle('visible', show);
}

// ---- Scroll Handling ----

let scrollRAF = null;

function onScroll() {
  if (scrollRAF) return;
  scrollRAF = requestAnimationFrame(() => {
    scrollRAF = null;
    render();
  });
}

scrollContainer.addEventListener('scroll', onScroll, { passive: true });

// ---- Filter Handling ----

function onFilterChange() {
  state.fetchVersion++;
  state.cache.clear();
  state.pendingFetches.clear();
  scrollContainer.scrollTop = 0;

  // Initial fetch to get total
  loadInitialData();
}

severityFilter.addEventListener('change', () => {
  state.severity = severityFilter.value;
  onFilterChange();
});

let searchDebounceTimer = null;

searchInput.addEventListener('input', () => {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    state.q = searchInput.value.trim();
    onFilterChange();
  }, DEBOUNCE_MS);
});

// ---- Initialization ----

async function loadInitialData() {
  const version = state.fetchVersion;

  try {
    showLoading(true);

    // Fetch first page + total
    const data = await fetchLogs(0, PAGE_SIZE, version);
    if (!data) return; // stale

    state.total = data.total;
    state.cache.set(0, { rows: data.rows, timestamp: Date.now() });

    updateRowCount();
    render();
  } catch (err) {
    console.error('Failed to load initial data:', err);
    rowCountEl.textContent = 'Error loading data';
  } finally {
    showLoading(false);
  }
}

async function init() {
  try {
    // Fetch stats for badges
    const stats = await fetchStats();
    state.stats = stats;
    updateBadges();
  } catch (err) {
    console.error('Failed to load stats:', err);
  }

  await loadInitialData();
}

init();
