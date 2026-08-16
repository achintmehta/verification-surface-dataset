const API_BASE = '/api';
const ROW_HEIGHT = 28;
const OVERSCAN = 10;
const FETCH_LIMIT = 100; // Rows per API fetch
const DEBOUNCE_MS = 250;

// State
let totalRows = 0;
let currentSeverity = '';
let currentQuery = '';
let cache = new Map();
let requestCounter = 0;
let activeRequestId = 0;

// DOM elements
const scrollContainer = document.getElementById('scroll-container');
const scrollSpacer = document.getElementById('scroll-spacer');
const viewport = document.getElementById('viewport');
const severityFilter = document.getElementById('severity-filter');
const searchInput = document.getElementById('search-input');
const rowCountEl = document.getElementById('row-count');
const badgesEl = document.getElementById('severity-badges');

// --- API ---

async function fetchLogsFromAPI(offset, limit) {
  const params = new URLSearchParams();
  params.set('offset', String(offset));
  params.set('limit', String(Math.min(limit, 200)));
  if (currentSeverity) params.set('severity', currentSeverity);
  if (currentQuery) params.set('q', currentQuery);

  const resp = await fetch(`${API_BASE}/logs?${params}`);
  if (!resp.ok) throw new Error(`API error: ${resp.status}`);
  return resp.json();
}

async function fetchStats() {
  const resp = await fetch(`${API_BASE}/stats`);
  if (!resp.ok) throw new Error(`API error: ${resp.status}`);
  return resp.json();
}

// --- Cache ---

function getCacheKey(offset, limit) {
  return `${currentSeverity}|${currentQuery}|${offset}|${limit}`;
}

function clearCache() {
  cache.clear();
  pendingFetches.clear();
}

// --- Virtual Scroller ---

function updateSpacerHeight() {
  scrollSpacer.style.height = `${totalRows * ROW_HEIGHT}px`;
}

function getVisibleRange() {
  const scrollTop = scrollContainer.scrollTop;
  const containerHeight = scrollContainer.clientHeight;
  const startRow = Math.floor(scrollTop / ROW_HEIGHT);
  const visibleCount = Math.ceil(containerHeight / ROW_HEIGHT);
  const firstRow = Math.max(0, startRow - OVERSCAN);
  const lastRow = Math.min(totalRows - 1, startRow + visibleCount + OVERSCAN);
  return { firstRow, lastRow, startRow, visibleCount };
}

function formatTimestamp(ts) {
  const d = new Date(ts);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function createRowElement(row) {
  const el = document.createElement('div');
  el.className = `log-row row-${row.severity}`;

  const ts = document.createElement('div');
  ts.className = 'col col-ts';
  ts.textContent = formatTimestamp(row.ts);

  const sev = document.createElement('div');
  sev.className = `col col-severity severity-${row.severity}`;
  sev.textContent = row.severity.toUpperCase();

  const svc = document.createElement('div');
  svc.className = 'col col-service';
  svc.textContent = row.service;

  const msg = document.createElement('div');
  msg.className = 'col col-message';
  msg.textContent = row.message;

  el.appendChild(ts);
  el.appendChild(sev);
  el.appendChild(svc);
  el.appendChild(msg);

  return el;
}

let lastRenderedCount = 0;

function updateRowCount(renderedCount) {
  if (renderedCount !== undefined) {
    lastRenderedCount = renderedCount;
  }
  rowCountEl.textContent = `${lastRenderedCount} of ${totalRows.toLocaleString()} rows`;
}

// Track pending fetches to avoid duplicates
const pendingFetches = new Set();

async function renderVisibleRows() {
  if (totalRows === 0) {
    viewport.innerHTML = '';
    viewport.style.transform = 'translateY(0px)';
    updateRowCount(0);
    return;
  }

  const { firstRow, lastRow } = getVisibleRange();
  if (firstRow > lastRow) {
    viewport.innerHTML = '';
    updateRowCount(0);
    return;
  }

  const myActiveId = activeRequestId;

  // Determine chunk-aligned fetch boundaries
  const fetchAlignedStart = Math.floor(firstRow / FETCH_LIMIT) * FETCH_LIMIT;
  const fetchAlignedEnd = Math.min(
    Math.ceil((lastRow + 1) / FETCH_LIMIT) * FETCH_LIMIT,
    totalRows
  );

  // Fetch any missing chunks
  const fetchPromises = [];
  for (let offset = fetchAlignedStart; offset < fetchAlignedEnd; offset += FETCH_LIMIT) {
    const limit = Math.min(FETCH_LIMIT, totalRows - offset);
    const key = getCacheKey(offset, limit);

    if (!cache.has(key) && !pendingFetches.has(key)) {
      pendingFetches.add(key);
      const p = fetchLogsFromAPI(offset, limit)
        .then(data => {
          pendingFetches.delete(key);
          if (myActiveId === activeRequestId) {
            cache.set(key, data.rows);
            if (data.total !== totalRows) {
              totalRows = data.total;
              updateSpacerHeight();
            }
          }
        })
        .catch(err => {
          pendingFetches.delete(key);
          console.error('Fetch error:', err);
        });
      fetchPromises.push(p);
    }
  }

  if (fetchPromises.length > 0) {
    await Promise.all(fetchPromises);
    if (myActiveId !== activeRequestId) return;
  }

  // Build DOM from cached data
  const fragment = document.createDocumentFragment();
  let renderedCount = 0;

  for (let rowIdx = firstRow; rowIdx <= lastRow; rowIdx++) {
    const chunkOffset = Math.floor(rowIdx / FETCH_LIMIT) * FETCH_LIMIT;
    const chunkLimit = Math.min(FETCH_LIMIT, totalRows - chunkOffset);
    const key = getCacheKey(chunkOffset, chunkLimit);
    const chunkRows = cache.get(key);

    if (chunkRows) {
      const localIdx = rowIdx - chunkOffset;
      if (localIdx < chunkRows.length) {
        fragment.appendChild(createRowElement(chunkRows[localIdx]));
        renderedCount++;
      }
    }
  }

  viewport.style.transform = `translateY(${firstRow * ROW_HEIGHT}px)`;
  viewport.innerHTML = '';
  viewport.appendChild(fragment);
  updateRowCount(renderedCount);
}

// --- Scroll handling ---

let scrollRAF = null;

function onScroll() {
  if (scrollRAF) return;
  scrollRAF = requestAnimationFrame(() => {
    scrollRAF = null;
    renderVisibleRows();
  });
}

scrollContainer.addEventListener('scroll', onScroll, { passive: true });

// --- Filter handling ---

let debounceTimer = null;

async function onFilterChange(resetScroll = true) {
  const myActiveId = ++requestCounter;
  activeRequestId = myActiveId;
  clearCache();

  if (resetScroll) {
    scrollContainer.scrollTop = 0;
  }

  try {
    const data = await fetchLogsFromAPI(0, FETCH_LIMIT);

    // Stale response check
    if (myActiveId !== activeRequestId) return;

    totalRows = data.total;
    const key = getCacheKey(0, Math.min(FETCH_LIMIT, totalRows));
    cache.set(key, data.rows);
    updateSpacerHeight();

    // Render now that we have data
    await renderVisibleRows();
  } catch (err) {
    console.error('Filter fetch error:', err);
  }
}

severityFilter.addEventListener('change', () => {
  currentSeverity = severityFilter.value;
  onFilterChange();
});

searchInput.addEventListener('input', () => {
  currentQuery = searchInput.value.trim();
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    onFilterChange();
  }, DEBOUNCE_MS);
});

// --- Stats / Badges ---

async function loadStats() {
  try {
    const stats = await fetchStats();
    badgesEl.innerHTML = [
      `<span class="badge badge-debug">D: ${stats.debug.toLocaleString()}</span>`,
      `<span class="badge badge-info">I: ${stats.info.toLocaleString()}</span>`,
      `<span class="badge badge-warn">W: ${stats.warn.toLocaleString()}</span>`,
      `<span class="badge badge-error">E: ${stats.error.toLocaleString()}</span>`,
    ].join('');
  } catch (err) {
    console.error('Stats error:', err);
  }
}

// --- Init ---

async function init() {
  await loadStats();
  await onFilterChange(false);
}

init();
