const API_BASE = 'http://localhost:3001';
const ROW_HEIGHT = 28;
const OVERSCAN = 10;
const FETCH_LIMIT = 100; // rows per API request
const DEBOUNCE_MS = 250;

// State
let totalRows = 0;
let currentSeverity = '';
let currentQuery = '';
let filterGeneration = 0; // Incremented on every filter change; used to discard stale responses
let cache = new Map(); // cacheKey -> { total, rows }
let statsData = null;

// DOM elements
const scroller = document.getElementById('virtual-scroller');
const scrollContent = document.getElementById('scroll-content');
const severityFilter = document.getElementById('severity-filter');
const searchInput = document.getElementById('search-input');
const statsDisplay = document.getElementById('stats-display');

// Row pool for recycling DOM elements
const rowPool = [];
const activeRows = new Map(); // rowIndex -> element

function createRowElement() {
  const el = document.createElement('div');
  el.className = 'log-row';
  el.innerHTML = `
    <div class="col col-ts"></div>
    <div class="col col-severity"><span class="severity-badge"></span></div>
    <div class="col col-service"></div>
    <div class="col col-message"></div>
  `;
  return el;
}

function acquireRow() {
  return rowPool.length > 0 ? rowPool.pop() : createRowElement();
}

function releaseRow(el) {
  if (el.parentNode) el.parentNode.removeChild(el);
  rowPool.push(el);
}

function formatTimestamp(ts) {
  const d = new Date(ts);
  return d.toISOString().replace('T', ' ').replace('Z', '').slice(0, 23);
}

function updateRowElement(el, row, index) {
  const cols = el.children;
  cols[0].textContent = formatTimestamp(row.ts);

  const badge = cols[1].querySelector('.severity-badge');
  badge.textContent = row.severity;
  badge.className = `severity-badge severity-${row.severity}`;

  cols[2].textContent = row.service;
  cols[3].textContent = row.message;

  el.style.top = `${index * ROW_HEIGHT}px`;
  el.style.height = `${ROW_HEIGHT}px`;
}

// Build a cache key that binds to a specific filter state
function makeCacheKey(severity, query, offset, limit) {
  return `${severity}|${query}|${offset}|${limit}`;
}

function currentCacheKey(offset, limit) {
  return makeCacheKey(currentSeverity, currentQuery, offset, limit);
}

function clearCache() {
  cache.clear();
}

// Pending fetches tracking to avoid duplicate in-flight requests for the same key
const pendingFetches = new Map();

async function ensureData(offset, limit) {
  const key = currentCacheKey(offset, limit);
  if (cache.has(key)) return cache.get(key);
  if (pendingFetches.has(key)) return pendingFetches.get(key);

  // Capture filter state at call time
  const severity = currentSeverity;
  const query = currentQuery;
  const gen = filterGeneration;

  const params = new URLSearchParams();
  params.set('offset', offset);
  params.set('limit', limit);
  if (severity) params.set('severity', severity);
  if (query) params.set('q', query);

  const promise = fetch(`${API_BASE}/api/logs?${params}`)
    .then(res => {
      if (!res.ok) throw new Error(`API ${res.status}`);
      return res.json();
    })
    .then(data => {
      pendingFetches.delete(key);

      // Discard if filter state changed since this request was fired
      if (gen !== filterGeneration) return null;

      cache.set(key, data);

      if (totalRows !== data.total) {
        totalRows = data.total;
        updateScrollHeight();
        updateStats();
      }
      return data;
    })
    .catch(err => {
      pendingFetches.delete(key);
      console.error('Fetch error:', err);
      return null;
    });

  pendingFetches.set(key, promise);
  return promise;
}

function updateScrollHeight() {
  scrollContent.style.height = `${totalRows * ROW_HEIGHT}px`;
}

function updateStats() {
  const visible = activeRows.size;
  let text = `Showing ${visible} of ${totalRows.toLocaleString()} entries`;
  if (statsData) {
    text += ` | D:${statsData.severities.debug.toLocaleString()} I:${statsData.severities.info.toLocaleString()} W:${statsData.severities.warn.toLocaleString()} E:${statsData.severities.error.toLocaleString()}`;
  }
  statsDisplay.textContent = text;
}

// Rendering
let renderRAF = null;

function render() {
  renderRAF = null;

  const scrollTop = scroller.scrollTop;
  const viewportHeight = scroller.clientHeight;

  if (totalRows === 0) {
    for (const [, el] of activeRows) releaseRow(el);
    activeRows.clear();
    updateStats();
    return;
  }

  const firstVisible = Math.floor(scrollTop / ROW_HEIGHT);
  const lastVisible = Math.min(
    Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT),
    totalRows - 1
  );

  const renderStart = Math.max(0, firstVisible - OVERSCAN);
  const renderEnd = Math.min(totalRows - 1, lastVisible + OVERSCAN);

  // Remove rows outside the new render range
  for (const [idx, el] of activeRows) {
    if (idx < renderStart || idx > renderEnd) {
      releaseRow(el);
      activeRows.delete(idx);
    }
  }

  // Determine which fetch-chunks we need
  const neededChunkStart = Math.floor(renderStart / FETCH_LIMIT) * FETCH_LIMIT;
  const neededChunkEnd = Math.floor(renderEnd / FETCH_LIMIT) * FETCH_LIMIT;

  const fetchPromises = [];
  for (let co = neededChunkStart; co <= neededChunkEnd; co += FETCH_LIMIT) {
    const key = currentCacheKey(co, FETCH_LIMIT);
    if (!cache.has(key)) {
      fetchPromises.push(ensureData(co, FETCH_LIMIT));
    }
  }

  // Render whatever is already in cache
  renderFromCache(renderStart, renderEnd);

  // When pending fetches complete, re-render
  if (fetchPromises.length > 0) {
    Promise.all(fetchPromises).then(() => {
      if (!renderRAF) {
        renderFromCache(renderStart, renderEnd);
        updateStats();
      }
    });
  }

  updateStats();
}

function renderFromCache(renderStart, renderEnd) {
  for (let i = renderStart; i <= renderEnd; i++) {
    if (activeRows.has(i)) continue;

    const chunkOffset = Math.floor(i / FETCH_LIMIT) * FETCH_LIMIT;
    const key = currentCacheKey(chunkOffset, FETCH_LIMIT);
    const cached = cache.get(key);
    if (!cached) continue;

    const rowIdx = i - chunkOffset;
    if (rowIdx >= cached.rows.length) continue;

    const row = cached.rows[rowIdx];
    const el = acquireRow();
    updateRowElement(el, row, i);
    scrollContent.appendChild(el);
    activeRows.set(i, el);
  }
}

function scheduleRender() {
  if (renderRAF) return;
  renderRAF = requestAnimationFrame(render);
}

// Scroll handler
scroller.addEventListener('scroll', scheduleRender, { passive: true });

// Debounce utility
function debounce(fn, ms) {
  let timer = null;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

function resetAndFetch() {
  // Bump generation to invalidate in-flight requests
  filterGeneration++;

  // Clear cache and pending
  clearCache();
  pendingFetches.clear();

  // Clear rendered rows
  for (const [, el] of activeRows) releaseRow(el);
  activeRows.clear();

  // Reset scroll
  scroller.scrollTop = 0;
  totalRows = 0;
  updateScrollHeight();

  // Fetch first chunk to learn the total
  ensureData(0, FETCH_LIMIT).then(data => {
    if (data) {
      totalRows = data.total;
      updateScrollHeight();
      scheduleRender();
    }
  });
}

severityFilter.addEventListener('change', () => {
  currentSeverity = severityFilter.value;
  resetAndFetch();
});

const debouncedSearch = debounce(() => {
  currentQuery = searchInput.value.trim();
  resetAndFetch();
}, DEBOUNCE_MS);

searchInput.addEventListener('input', debouncedSearch);

// Window resize
window.addEventListener('resize', scheduleRender);

// Initial load
async function init() {
  try {
    statsData = await fetch(`${API_BASE}/api/stats`).then(r => r.json());
  } catch (e) {
    console.warn('Could not fetch stats:', e);
  }
  resetAndFetch();
}

init();
