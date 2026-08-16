const API_BASE = window.location.port === '5173' ? '' : 'http://localhost:3001';
const ROW_HEIGHT = 32;
const OVERSCAN = 10;
const FETCH_LIMIT = 100; // rows per fetch
const DEBOUNCE_MS = 250;

// State
let state = {
  total: 0,
  severity: '',
  search: '',
  rows: new Map(), // offset -> row data (sparse cache)
  fetchGeneration: 0, // incremented on filter change to discard stale responses
  pendingFetches: new Set(), // track in-flight page keys
  stats: null,
};

// DOM elements
const scrollContainer = document.getElementById('scroll-container');
const scrollSpacer = document.getElementById('scroll-spacer');
const scrollContent = document.getElementById('scroll-content');
const severityFilter = document.getElementById('severity-filter');
const searchInput = document.getElementById('search-input');
const rowCountEl = document.getElementById('row-count');
const severityBadgesEl = document.getElementById('severity-badges');

// ---- API ----

async function fetchLogs(offset, limit, severity, search, generation) {
  const params = new URLSearchParams();
  params.set('offset', offset);
  params.set('limit', limit);
  if (severity) params.set('severity', severity);
  if (search) params.set('q', search);

  const res = await fetch(`${API_BASE}/api/logs?${params}`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  const data = await res.json();
  return { ...data, generation };
}

async function fetchStats() {
  const res = await fetch(`${API_BASE}/api/stats`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

// ---- Virtual Scroller ----

function getVisibleRange() {
  const scrollTop = scrollContainer.scrollTop;
  const viewportHeight = scrollContainer.clientHeight;
  const startRow = Math.floor(scrollTop / ROW_HEIGHT);
  const endRow = Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT);
  return {
    start: Math.max(0, startRow - OVERSCAN),
    end: Math.min(state.total, endRow + OVERSCAN),
  };
}

function updateSpacer() {
  scrollSpacer.style.height = `${state.total * ROW_HEIGHT}px`;
}

function formatTimestamp(ts) {
  const d = new Date(ts);
  return d.toISOString().replace('T', ' ').replace('Z', '').slice(0, 23);
}

function createRowElement(row, index) {
  const el = document.createElement('div');
  el.className = 'log-row';
  el.style.height = `${ROW_HEIGHT}px`;

  if (!row) {
    el.innerHTML = `<div class="col col-ts">&nbsp;</div><div class="col col-severity">&nbsp;</div><div class="col col-service">&nbsp;</div><div class="col col-message loading-row">Loading...</div>`;
    return el;
  }

  const severityClass = `severity-${row.severity}`;
  el.innerHTML = `
    <div class="col col-ts">${formatTimestamp(row.ts)}</div>
    <div class="col col-severity"><span class="severity-badge ${severityClass}">${row.severity}</span></div>
    <div class="col col-service">${escapeHtml(row.service)}</div>
    <div class="col col-message" title="${escapeAttr(row.message)}">${escapeHtml(row.message)}</div>
  `;
  return el;
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(str) {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function render() {
  const { start, end } = getVisibleRange();
  
  // Build fragment
  const fragment = document.createDocumentFragment();
  
  // Track which pages we need to fetch
  const neededPages = new Set();

  for (let i = start; i < end; i++) {
    const row = state.rows.get(i);
    const el = createRowElement(row, i);
    fragment.appendChild(el);

    if (!row) {
      // Calculate which page this row belongs to
      const pageStart = Math.floor(i / FETCH_LIMIT) * FETCH_LIMIT;
      neededPages.add(pageStart);
    }
  }

  // Position content
  scrollContent.style.transform = `translateY(${start * ROW_HEIGHT}px)`;
  scrollContent.replaceChildren(fragment);

  // Trigger fetches for missing pages
  for (const pageStart of neededPages) {
    fetchPage(pageStart);
  }
}

async function fetchPage(pageStart) {
  const pageKey = `${state.fetchGeneration}:${pageStart}`;
  if (state.pendingFetches.has(pageKey)) return;
  state.pendingFetches.add(pageKey);

  const generation = state.fetchGeneration;

  try {
    const data = await fetchLogs(
      pageStart,
      FETCH_LIMIT,
      state.severity,
      state.search,
      generation
    );

    // Discard if stale
    if (data.generation !== state.fetchGeneration) return;

    // Update total (should be consistent)
    if (data.total !== state.total) {
      state.total = data.total;
      updateSpacer();
      updateRowCount();
    }

    // Store rows
    for (let i = 0; i < data.rows.length; i++) {
      state.rows.set(pageStart + i, data.rows[i]);
    }

    // Re-render
    render();
  } catch (err) {
    console.error('Fetch error:', err);
  } finally {
    state.pendingFetches.delete(pageKey);
  }
}

function updateRowCount() {
  const { start, end } = getVisibleRange();
  const visibleCount = Math.min(end, state.total) - start;
  rowCountEl.textContent = `${visibleCount} of ${state.total.toLocaleString()} rows`;
}

// ---- Filters ----

function resetAndRefresh() {
  state.fetchGeneration++;
  state.rows.clear();
  state.pendingFetches.clear();
  state.total = 0;
  scrollContainer.scrollTop = 0;
  updateSpacer();
  scrollContent.replaceChildren();
  
  // Fetch first page to get total
  fetchPage(0);
}

severityFilter.addEventListener('change', () => {
  state.severity = severityFilter.value;
  resetAndRefresh();
});

let debounceTimer = null;
searchInput.addEventListener('input', () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    state.search = searchInput.value.trim();
    resetAndRefresh();
  }, DEBOUNCE_MS);
});

// ---- Scroll handling ----

let scrollRAF = null;
scrollContainer.addEventListener('scroll', () => {
  if (scrollRAF) return;
  scrollRAF = requestAnimationFrame(() => {
    scrollRAF = null;
    render();
    updateRowCount();
  });
});

// ---- Stats badges ----

async function loadStats() {
  try {
    const stats = await fetchStats();
    state.stats = stats;
    
    severityBadgesEl.innerHTML = ['debug', 'info', 'warn', 'error']
      .map(s => `<span class="badge badge-${s}">${s}: ${(stats.severities[s] || 0).toLocaleString()}</span>`)
      .join('');
  } catch (err) {
    console.error('Failed to load stats:', err);
  }
}

// ---- Init ----

async function init() {
  await loadStats();
  resetAndRefresh();
}

init();
