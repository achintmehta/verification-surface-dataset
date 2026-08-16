// ─── Constants ────────────────────────────────────────────────────────────────
const API_BASE    = '/api';
const ROW_HEIGHT  = 36;     // px — must match CSS --row-height
const OVERSCAN    = 8;      // extra rows above/below viewport
const FETCH_LIMIT = 100;    // rows per API request (window size)
const DEBOUNCE_MS = 250;    // search debounce delay

// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  total:      0,
  severity:   '',
  query:      '',
  // Row cache: Map<cacheKey, Row[]>
  cache:      new Map(),
  // Current filter generation — incremented on every filter change
  generation: 0,
  // Set of window offsets currently being fetched (for current generation)
  inflight:   new Set(),
  stats:      null,
};

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const scrollViewport   = document.getElementById('scroll-viewport');
const scrollRunway     = document.getElementById('scroll-runway');
const rowPool          = document.getElementById('row-pool');
const loadingOverlay   = document.getElementById('loading-overlay');
const emptyState       = document.getElementById('empty-state');
const resultCountLabel = document.getElementById('result-count-label');
const totalCountEl     = document.getElementById('total-count');
const severityBadges   = document.getElementById('severity-badges');
const severityFilter   = document.getElementById('severity-filter');
const searchInput      = document.getElementById('search-input');
const clearSearchBtn   = document.getElementById('clear-search');

// ─── Utilities ────────────────────────────────────────────────────────────────
function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

function formatTs(isoStr) {
  const d = new Date(isoStr);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.` +
    `${p(d.getMilliseconds(), 3)}`
  );
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
  const safe  = escapeHtml(text);
  const safeQ = escapeHtml(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return safe.replace(new RegExp(safeQ, 'gi'), m => `<span class="highlight">${m}</span>`);
}

// ─── Cache helpers ────────────────────────────────────────────────────────────
function winOffset(rowIdx) {
  return Math.floor(rowIdx / FETCH_LIMIT) * FETCH_LIMIT;
}

function cacheKey(wo) {
  return `${state.severity}\x00${state.query}\x00${wo}`;
}

function getCachedRow(rowIdx) {
  const wo  = winOffset(rowIdx);
  const win = state.cache.get(cacheKey(wo));
  return win ? (win[rowIdx - wo] ?? null) : null;
}

// ─── API ──────────────────────────────────────────────────────────────────────
async function apiFetch(offset, limit) {
  const p = new URLSearchParams({ offset: String(offset), limit: String(limit) });
  if (state.severity) p.set('severity', state.severity);
  if (state.query)    p.set('q', state.query);
  const res = await fetch(`${API_BASE}/logs?${p}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json(); // { total, rows }
}

async function apiStats() {
  const res = await fetch(`${API_BASE}/stats`);
  if (!res.ok) throw new Error(res.statusText);
  return res.json();
}

// ─── Window fetching ──────────────────────────────────────────────────────────
async function fetchWindow(wo) {
  const key = cacheKey(wo);
  if (state.cache.has(key) || state.inflight.has(wo)) return;

  state.inflight.add(wo);
  const gen = state.generation;

  try {
    const data = await apiFetch(wo, FETCH_LIMIT);
    if (gen !== state.generation) return; // stale — discard

    state.cache.set(key, data.rows);

    if (data.total !== state.total) {
      state.total = data.total;
      updateRunwayHeight();
      updateResultLabel();
    }

    scheduleRender();
  } catch (err) {
    console.warn('fetchWindow error:', err);
  } finally {
    state.inflight.delete(wo);
  }
}

// ─── Virtual Scroll Rendering ─────────────────────────────────────────────────
let rafPending = false;

function scheduleRender() {
  if (!rafPending) {
    rafPending = true;
    requestAnimationFrame(renderViewport);
  }
}

function renderViewport() {
  rafPending = false;

  const scrollTop      = scrollViewport.scrollTop;
  const viewportHeight = scrollViewport.clientHeight;
  const total          = state.total;

  if (total === 0) {
    rowPool.innerHTML = '';
    rowPool.style.top = '0px';
    return;
  }

  // Visible row range
  const firstVisible = Math.floor(scrollTop / ROW_HEIGHT);
  const lastVisible  = Math.min(
    Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) - 1,
    total - 1
  );

  // Overscan
  const firstRow = Math.max(0, firstVisible - OVERSCAN);
  const lastRow  = Math.min(total - 1, lastVisible + OVERSCAN);

  // Kick off fetches for any missing windows
  const firstWin = winOffset(firstRow);
  const lastWin  = winOffset(lastRow);
  for (let wo = firstWin; wo <= lastWin; wo += FETCH_LIMIT) {
    if (!state.cache.has(cacheKey(wo))) {
      fetchWindow(wo);
    }
  }

  // Position the row pool at firstRow's logical top
  rowPool.style.top = `${firstRow * ROW_HEIGHT}px`;

  // Build DOM rows in normal flow
  const query    = state.query;
  const fragment = document.createDocumentFragment();

  for (let i = firstRow; i <= lastRow; i++) {
    const row = getCachedRow(i);
    const div = document.createElement('div');
    div.className = `log-row${row ? ' ' + row.severity : ' placeholder'}`;

    if (row) {
      div.innerHTML =
        `<div class="col col-ts">${formatTs(row.ts)}</div>` +
        `<div class="col col-severity">${escapeHtml(row.severity)}</div>` +
        `<div class="col col-service">${escapeHtml(row.service)}</div>` +
        `<div class="col col-message">${highlightMatch(row.message, query)}</div>`;
    } else {
      div.innerHTML =
        `<div class="col col-ts loading-cell">—</div>` +
        `<div class="col col-severity"></div>` +
        `<div class="col col-service"></div>` +
        `<div class="col col-message loading-cell">Loading…</div>`;
    }

    fragment.appendChild(div);
  }

  rowPool.replaceChildren(fragment);
}

function updateRunwayHeight() {
  scrollRunway.style.height = `${state.total * ROW_HEIGHT}px`;
}

// ─── Filter application ───────────────────────────────────────────────────────
function applyFilters() {
  state.generation++;
  state.inflight.clear();
  state.cache.clear();
  state.total = 0;

  scrollViewport.scrollTop = 0;
  rowPool.innerHTML = '';
  rowPool.style.top = '0px';
  updateRunwayHeight();

  showLoading(true);
  emptyState.style.display = 'none';

  loadInitialWindow();
}

async function loadInitialWindow() {
  const gen = state.generation;
  try {
    const data = await apiFetch(0, FETCH_LIMIT);
    if (gen !== state.generation) return;

    state.cache.set(cacheKey(0), data.rows);
    state.total = data.total;

    updateRunwayHeight();
    updateResultLabel();
    showLoading(false);

    if (state.total === 0) {
      emptyState.style.display = 'flex';
    } else {
      emptyState.style.display = 'none';
      scheduleRender();
    }
  } catch (err) {
    console.error('loadInitialWindow error:', err);
    showLoading(false);
  }
}

// ─── UI helpers ───────────────────────────────────────────────────────────────
function showLoading(show) {
  loadingOverlay.style.display = show ? 'flex' : 'none';
}

function updateResultLabel() {
  const sevPart = state.severity
    ? `<strong>${state.severity}</strong>`
    : '';
  const qPart = state.query
    ? `matching "<strong>${escapeHtml(state.query)}</strong>"`
    : '';
  const parts = [sevPart, qPart].filter(Boolean);
  const filterPart = parts.length ? ` (${parts.join(', ')})` : '';
  resultCountLabel.innerHTML =
    `Showing <strong>${state.total.toLocaleString()}</strong> log entries${filterPart}`;
}

function renderSeverityBadges(stats) {
  if (!stats) return;
  const order = ['error', 'warn', 'info', 'debug'];
  severityBadges.innerHTML = order
    .map(sev => {
      const cnt = stats.bySeverity[sev] || 0;
      return `<span class="sev-badge ${sev}" data-sev="${sev}" title="Filter by ${sev}">
        ${sev} <span class="badge-count">${cnt.toLocaleString()}</span>
      </span>`;
    })
    .join('');

  severityBadges.querySelectorAll('.sev-badge').forEach(badge => {
    badge.addEventListener('click', () => {
      const sev = badge.dataset.sev;
      if (state.severity === sev) {
        severityFilter.value = '';
        state.severity = '';
      } else {
        severityFilter.value = sev;
        state.severity = sev;
      }
      applyFilters();
    });
  });
}

// ─── Event listeners ──────────────────────────────────────────────────────────
scrollViewport.addEventListener('scroll', scheduleRender, { passive: true });

severityFilter.addEventListener('change', () => {
  state.severity = severityFilter.value;
  applyFilters();
});

const debouncedSearch = debounce(() => {
  state.query = searchInput.value.trim();
  clearSearchBtn.style.display = state.query ? 'block' : 'none';
  applyFilters();
}, DEBOUNCE_MS);

searchInput.addEventListener('input', debouncedSearch);

clearSearchBtn.addEventListener('click', () => {
  searchInput.value = '';
  clearSearchBtn.style.display = 'none';
  state.query = '';
  applyFilters();
});

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  showLoading(true);

  try {
    state.stats = await apiStats();
    if (state.stats) {
      totalCountEl.textContent = state.stats.total.toLocaleString();
      renderSeverityBadges(state.stats);
    }
  } catch (err) {
    console.warn('Stats load failed:', err);
  }

  await loadInitialWindow();
}

init();
