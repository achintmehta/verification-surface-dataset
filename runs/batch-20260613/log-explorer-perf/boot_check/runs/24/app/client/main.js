const API_BASE = 'http://localhost:3001';
const ROW_HEIGHT = 28;
const OVERSCAN = 10;
const FETCH_BATCH = 100; // rows per API call
const DEBOUNCE_MS = 250;

// State
let state = {
  total: 0,
  severity: '',
  query: '',
  cache: new Map(), // offset -> { rows, timestamp }
  fetchVersion: 0,  // monotonic counter to discard stale responses
  pendingFetches: new Set(),
  stats: null,
};

// DOM elements
const scrollContainer = document.getElementById('scroll-container');
const scrollSpacer = document.getElementById('scroll-spacer');
const viewport = document.getElementById('viewport');
const severityFilter = document.getElementById('severity-filter');
const searchInput = document.getElementById('search-input');
const rowCountEl = document.getElementById('row-count');
const severityBadges = document.getElementById('severity-badges');

// ---- API ----

async function fetchLogs(offset, limit, version) {
  const params = new URLSearchParams();
  params.set('offset', offset);
  params.set('limit', limit);
  if (state.severity) params.set('severity', state.severity);
  if (state.query) params.set('q', state.query);

  const resp = await fetch(`${API_BASE}/api/logs?${params}`);
  if (!resp.ok) throw new Error(`API error: ${resp.status}`);
  return resp.json();
}

async function fetchStats() {
  const resp = await fetch(`${API_BASE}/api/stats`);
  if (!resp.ok) throw new Error(`Stats error: ${resp.status}`);
  return resp.json();
}

// ---- Cache ----

function getCacheKey(offset) {
  // Align to batch boundaries
  return Math.floor(offset / FETCH_BATCH) * FETCH_BATCH;
}

function getRowFromCache(index) {
  const batchStart = getCacheKey(index);
  const entry = state.cache.get(batchStart);
  if (!entry) return null;
  const localIdx = index - batchStart;
  if (localIdx < 0 || localIdx >= entry.rows.length) return null;
  return entry.rows[localIdx];
}

async function ensureRowsCached(startIdx, endIdx) {
  const version = state.fetchVersion;
  const batchesToFetch = new Set();

  for (let i = startIdx; i <= endIdx; i += FETCH_BATCH) {
    const batchStart = getCacheKey(i);
    batchesToFetch.add(batchStart);
  }
  // Also add the batch containing endIdx
  batchesToFetch.add(getCacheKey(endIdx));

  const fetches = [];
  for (const batchStart of batchesToFetch) {
    if (state.cache.has(batchStart)) continue;
    if (state.pendingFetches.has(batchStart)) continue;
    if (batchStart >= state.total) continue;

    state.pendingFetches.add(batchStart);
    const limit = Math.min(FETCH_BATCH, state.total - batchStart);

    fetches.push(
      fetchLogs(batchStart, limit, version)
        .then(data => {
          // Discard if state has changed (newer filter/search)
          if (version !== state.fetchVersion) return;
          state.cache.set(batchStart, { rows: data.rows, timestamp: Date.now() });
          // Update total in case it drifted
          state.total = data.total;
        })
        .catch(err => {
          console.error(`Fetch error at offset ${batchStart}:`, err);
        })
        .finally(() => {
          state.pendingFetches.delete(batchStart);
        })
    );
  }

  if (fetches.length > 0) {
    await Promise.all(fetches);
    // Re-render after data arrives (only if version still current)
    if (version === state.fetchVersion) {
      renderVisibleRows();
    }
  }
}

// ---- Rendering ----

function formatTimestamp(ts) {
  const d = new Date(ts);
  return d.toISOString().replace('T', ' ').replace('Z', '');
}

function renderVisibleRows() {
  const scrollTop = scrollContainer.scrollTop;
  const containerHeight = scrollContainer.clientHeight;

  const firstVisible = Math.floor(scrollTop / ROW_HEIGHT);
  const visibleCount = Math.ceil(containerHeight / ROW_HEIGHT);

  const startIdx = Math.max(0, firstVisible - OVERSCAN);
  const endIdx = Math.min(state.total - 1, firstVisible + visibleCount + OVERSCAN);

  if (state.total === 0) {
    viewport.innerHTML = '<div class="loading-row">No matching log entries</div>';
    viewport.style.transform = 'translateY(0px)';
    return;
  }

  // Build rows HTML
  const fragments = [];
  let hasMissingRows = false;

  for (let i = startIdx; i <= endIdx; i++) {
    const row = getRowFromCache(i);
    if (!row) {
      hasMissingRows = true;
      fragments.push(`<div class="log-row" style="height:${ROW_HEIGHT}px"><div class="col col-ts" style="color:#555">Loading...</div></div>`);
      continue;
    }

    fragments.push(
      `<div class="log-row" data-index="${i}">` +
        `<div class="col col-ts">${formatTimestamp(row.ts)}</div>` +
        `<div class="col col-severity severity-${row.severity}">${row.severity.toUpperCase()}</div>` +
        `<div class="col col-service">${escapeHtml(row.service)}</div>` +
        `<div class="col col-message">${escapeHtml(row.message)}</div>` +
      `</div>`
    );
  }

  viewport.innerHTML = fragments.join('');
  viewport.style.transform = `translateY(${startIdx * ROW_HEIGHT}px)`;

  // Update row count display
  const displayStart = firstVisible + 1;
  const displayEnd = Math.min(firstVisible + visibleCount, state.total);
  rowCountEl.textContent = `${displayStart}–${displayEnd} of ${state.total.toLocaleString()}`;

  // Fetch missing data
  if (hasMissingRows) {
    ensureRowsCached(startIdx, endIdx);
  }
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---- Filter Management ----

function resetAndRefetch() {
  state.fetchVersion++;
  state.cache.clear();
  state.pendingFetches.clear();

  // Fetch first batch to get total
  const version = state.fetchVersion;
  const params = new URLSearchParams();
  params.set('offset', 0);
  params.set('limit', FETCH_BATCH);
  if (state.severity) params.set('severity', state.severity);
  if (state.query) params.set('q', state.query);

  fetch(`${API_BASE}/api/logs?${params}`)
    .then(resp => resp.json())
    .then(data => {
      if (version !== state.fetchVersion) return; // stale
      state.total = data.total;
      state.cache.set(0, { rows: data.rows, timestamp: Date.now() });

      // Update spacer height
      scrollSpacer.style.height = `${state.total * ROW_HEIGHT}px`;

      // Reset scroll position
      scrollContainer.scrollTop = 0;

      renderVisibleRows();
    })
    .catch(err => {
      console.error('Filter fetch error:', err);
      rowCountEl.textContent = 'Error loading data';
    });
}

// ---- Debounce ----

function debounce(fn, ms) {
  let timer = null;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

// ---- Event Handlers ----

severityFilter.addEventListener('change', () => {
  state.severity = severityFilter.value;
  resetAndRefetch();
});

const debouncedSearch = debounce(() => {
  state.query = searchInput.value.trim();
  resetAndRefetch();
}, DEBOUNCE_MS);

searchInput.addEventListener('input', () => {
  debouncedSearch();
});

// Scroll handler with requestAnimationFrame throttle
let scrollRAF = null;
scrollContainer.addEventListener('scroll', () => {
  if (scrollRAF) return;
  scrollRAF = requestAnimationFrame(() => {
    scrollRAF = null;
    renderVisibleRows();
    // Pre-fetch neighboring batches
    const scrollTop = scrollContainer.scrollTop;
    const firstVisible = Math.floor(scrollTop / ROW_HEIGHT);
    const visibleCount = Math.ceil(scrollContainer.clientHeight / ROW_HEIGHT);
    const prefetchStart = Math.max(0, firstVisible - FETCH_BATCH);
    const prefetchEnd = Math.min(state.total - 1, firstVisible + visibleCount + FETCH_BATCH);
    ensureRowsCached(prefetchStart, prefetchEnd);
  });
});

// ---- Stats Badges ----

async function loadStats() {
  try {
    const stats = await fetchStats();
    state.stats = stats;

    const badges = ['debug', 'info', 'warn', 'error']
      .map(s => {
        const count = stats.severityCounts[s] || 0;
        return `<span class="badge badge-${s}">${s}: ${count.toLocaleString()}</span>`;
      })
      .join('');
    severityBadges.innerHTML = badges;
  } catch (err) {
    console.error('Stats load error:', err);
  }
}

// ---- Init ----

async function init() {
  rowCountEl.textContent = 'Loading...';
  await loadStats();
  resetAndRefetch();
}

init();
