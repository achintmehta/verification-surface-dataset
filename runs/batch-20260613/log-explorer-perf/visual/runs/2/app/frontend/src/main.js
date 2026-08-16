/**
 * Log Explorer — Virtualized frontend
 *
 * Architecture:
 *  - A single "scroller" div has a tall spacer that represents the full
 *    virtual height (total * ROW_H).
 *  - A "row-pool" div is absolutely positioned and translated to the current
 *    scroll offset, holding only the visible rows + overscan.
 *  - On scroll, we compute which offset window is needed, fetch it if not
 *    cached, and update the DOM pool.
 *  - Filters reset scroll to 0 and invalidate the cache.
 *  - Debounced search with request cancellation prevents stale overwrites.
 */

const API = '/api';
const ROW_H = 36;           // px — must match CSS --row-h
const WINDOW_SIZE = 80;     // rows fetched per request (well under 200 cap)
const OVERSCAN = 10;        // extra rows above/below viewport
const DEBOUNCE_MS = 250;    // search debounce
const CACHE_MAX = 20;       // max cached windows

// ── DOM refs ──────────────────────────────────────────────────────────────────
const scrollerEl   = document.getElementById('scroller');
const spacerEl     = document.getElementById('spacer');
const rowPoolEl    = document.getElementById('row-pool');
const rowCountEl   = document.getElementById('row-count');
const statusEl     = document.getElementById('status-text');
const severityEl   = document.getElementById('severity-filter');
const searchEl     = document.getElementById('search-input');

// ── State ─────────────────────────────────────────────────────────────────────
let state = {
  total: 0,
  severity: '',
  q: '',
  scrollTop: 0,
};

// Window cache: Map<windowKey, { rows, ts }>
// windowKey = `${severity}|${q}|${windowOffset}`
const windowCache = new Map();

// In-flight fetch tracker
let fetchSeq = 0;           // monotonically increasing sequence number
let latestSeq = 0;          // the seq of the most recent *completed* fetch we care about

// ── Utilities ─────────────────────────────────────────────────────────────────
function cacheKey(severity, q, windowOffset) {
  return `${severity}|${q}|${windowOffset}`;
}

function windowOffset(rowOffset) {
  // Align to WINDOW_SIZE boundaries
  return Math.floor(rowOffset / WINDOW_SIZE) * WINDOW_SIZE;
}

function evictCache() {
  if (windowCache.size <= CACHE_MAX) return;
  // Evict oldest entries
  const toDelete = windowCache.size - CACHE_MAX;
  let i = 0;
  for (const key of windowCache.keys()) {
    if (i++ >= toDelete) break;
    windowCache.delete(key);
  }
}

function formatTs(isoStr) {
  // e.g. "2024-01-15 14:32:07"
  return isoStr.replace('T', ' ').replace(/\.\d+Z$/, '').replace('Z', '');
}

function setStatus(msg) {
  statusEl.textContent = msg;
}

// ── Row DOM pool ──────────────────────────────────────────────────────────────
// We maintain a fixed pool of DOM row elements and reuse them.
let domRows = [];

function ensurePoolSize(n) {
  while (domRows.length < n) {
    const el = document.createElement('div');
    el.className = 'log-row';
    el.innerHTML = `
      <div class="col-ts"></div>
      <div class="col-sev"><span class="badge"></span></div>
      <div class="col-svc"></div>
      <div class="col-msg"></div>
    `;
    rowPoolEl.appendChild(el);
    domRows.push(el);
  }
  // Hide excess
  for (let i = n; i < domRows.length; i++) {
    domRows[i].style.display = 'none';
  }
}

function renderRows(rows, startOffset) {
  const n = rows.length;
  ensurePoolSize(n);

  for (let i = 0; i < n; i++) {
    const row = rows[i];
    const el = domRows[i];
    el.style.display = '';
    el.className = `log-row ${row.severity}`;

    const children = el.children;
    children[0].textContent = formatTs(row.ts);
    const badge = children[1].firstElementChild;
    badge.className = `badge ${row.severity}`;
    badge.textContent = row.severity;
    children[2].textContent = row.service;
    children[3].textContent = row.message;
    children[3].title = row.message;
  }

  // Position the pool at the correct scroll offset
  const topPx = startOffset * ROW_H;
  rowPoolEl.style.transform = `translateY(${topPx}px)`;
}

function clearPool() {
  for (const el of domRows) {
    el.style.display = 'none';
  }
  rowPoolEl.style.transform = 'translateY(0px)';
}

// ── Fetch ─────────────────────────────────────────────────────────────────────
async function fetchWindow(severity, q, offset, seq) {
  const params = new URLSearchParams({
    offset: String(offset),
    limit: String(WINDOW_SIZE),
  });
  if (severity) params.set('severity', severity);
  if (q) params.set('q', q);

  const url = `${API}/logs?${params}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  return { data, seq };
}

// ── Main render loop ──────────────────────────────────────────────────────────
let renderScheduled = false;

function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(doRender);
}

async function doRender() {
  renderScheduled = false;

  const { severity, q, scrollTop, total } = state;

  // Which rows are visible?
  const viewportH = scrollerEl.clientHeight;
  const firstVisible = Math.floor(scrollTop / ROW_H);
  const lastVisible = Math.min(
    Math.ceil((scrollTop + viewportH) / ROW_H),
    total - 1
  );

  const firstRow = Math.max(0, firstVisible - OVERSCAN);
  const lastRow = Math.min(total - 1, lastVisible + OVERSCAN);

  if (total === 0) {
    clearPool();
    return;
  }

  // Which windows do we need?
  const win1 = windowOffset(firstRow);
  const win2 = windowOffset(lastRow);

  // Collect rows from cache (may span 1 or 2 windows)
  const windows = [win1];
  if (win2 !== win1) windows.push(win2);

  // Check cache
  const missing = windows.filter(w => !windowCache.has(cacheKey(severity, q, w)));

  if (missing.length === 0) {
    // All cached — render immediately
    renderFromCache(severity, q, firstRow, lastRow);
    return;
  }

  // Fetch missing windows
  const mySeq = ++fetchSeq;
  setStatus('Loading…');

  try {
    const fetches = missing.map(w => fetchWindow(severity, q, w, mySeq));
    const results = await Promise.all(fetches);

    // Check if this fetch is still relevant
    if (mySeq < latestSeq) return; // superseded
    latestSeq = mySeq;

    for (let i = 0; i < results.length; i++) {
      const { data } = results[i];
      const w = missing[i];
      const key = cacheKey(severity, q, w);
      windowCache.set(key, data.rows);
      evictCache();

      // Update total from the most recent response
      if (data.total !== state.total) {
        state.total = data.total;
        updateSpacerHeight();
        updateRowCount();
      }
    }

    renderFromCache(severity, q, firstRow, lastRow);
    setStatus(`Showing rows ${firstRow + 1}–${Math.min(lastRow + 1, total)} of ${state.total.toLocaleString()}`);
  } catch (err) {
    if (mySeq < latestSeq) return;
    setStatus(`Error: ${err.message}`);
    console.error(err);
  }
}

function renderFromCache(severity, q, firstRow, lastRow) {
  const rows = [];
  for (let r = firstRow; r <= lastRow; r++) {
    const w = windowOffset(r);
    const key = cacheKey(severity, q, w);
    const cached = windowCache.get(key);
    if (!cached) continue;
    const localIdx = r - w;
    if (localIdx >= 0 && localIdx < cached.length) {
      rows.push(cached[localIdx]);
    }
  }

  if (rows.length > 0) {
    renderRows(rows, firstRow);
    setStatus(
      `Showing rows ${firstRow + 1}–${Math.min(lastRow + 1, state.total)} of ${state.total.toLocaleString()}`
    );
  } else {
    clearPool();
  }
}

// ── Spacer / count ────────────────────────────────────────────────────────────
function updateSpacerHeight() {
  spacerEl.style.height = `${state.total * ROW_H}px`;
}

function updateRowCount() {
  rowCountEl.textContent = `${state.total.toLocaleString()} rows`;
}

// ── Initial load ──────────────────────────────────────────────────────────────
async function initialLoad() {
  setStatus('Connecting to server…');
  try {
    // Fetch stats for badges
    const statsResp = await fetch(`${API}/stats`);
    if (statsResp.ok) {
      const stats = await statsResp.json();
      updateSeverityBadges(stats.bySeverity);
    }

    // Fetch first window to get total
    const mySeq = ++fetchSeq;
    latestSeq = mySeq;

    const params = new URLSearchParams({ offset: '0', limit: String(WINDOW_SIZE) });
    const resp = await fetch(`${API}/logs?${params}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();

    state.total = data.total;
    windowCache.set(cacheKey('', '', 0), data.rows);

    updateSpacerHeight();
    updateRowCount();
    renderFromCache('', '', 0, Math.min(WINDOW_SIZE - 1, data.total - 1));
    setStatus(`Showing rows 1–${Math.min(WINDOW_SIZE, data.total)} of ${data.total.toLocaleString()}`);
  } catch (err) {
    setStatus(`Failed to connect: ${err.message}. Is the backend running?`);
    rowCountEl.textContent = 'Error';
  }
}

function updateSeverityBadges(bySeverity) {
  const opts = severityEl.querySelectorAll('option[value]');
  for (const opt of opts) {
    const sev = opt.value;
    if (sev && bySeverity[sev] !== undefined) {
      opt.textContent = `${sev.charAt(0).toUpperCase() + sev.slice(1)} (${bySeverity[sev].toLocaleString()})`;
    }
  }
}

// ── Filter reset ──────────────────────────────────────────────────────────────
async function applyFilters() {
  const severity = severityEl.value;
  const q = searchEl.value.trim();

  // Invalidate cache for new filter combo (keep others for quick back-navigation)
  state.severity = severity;
  state.q = q;
  state.total = 0;
  state.scrollTop = 0;

  // Reset scroll
  scrollerEl.scrollTop = 0;
  clearPool();
  updateSpacerHeight();
  rowCountEl.textContent = '…';

  // Fetch new total + first window
  const mySeq = ++fetchSeq;
  latestSeq = mySeq;
  setStatus('Loading…');

  try {
    const params = new URLSearchParams({ offset: '0', limit: String(WINDOW_SIZE) });
    if (severity) params.set('severity', severity);
    if (q) params.set('q', q);

    const resp = await fetch(`${API}/logs?${params}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();

    if (mySeq < latestSeq) return; // superseded by a newer filter change
    latestSeq = mySeq;

    state.total = data.total;
    windowCache.set(cacheKey(severity, q, 0), data.rows);
    evictCache();

    updateSpacerHeight();
    updateRowCount();

    if (data.total === 0) {
      clearPool();
      setStatus('No results match the current filters.');
      rowCountEl.textContent = '0 rows';
      return;
    }

    renderFromCache(severity, q, 0, Math.min(WINDOW_SIZE - 1, data.total - 1));
    setStatus(`Showing rows 1–${Math.min(WINDOW_SIZE, data.total)} of ${data.total.toLocaleString()}`);
  } catch (err) {
    if (mySeq < latestSeq) return;
    setStatus(`Error: ${err.message}`);
  }
}

// ── Debounce ──────────────────────────────────────────────────────────────────
function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

const debouncedSearch = debounce(applyFilters, DEBOUNCE_MS);

// ── Event listeners ───────────────────────────────────────────────────────────
scrollerEl.addEventListener('scroll', () => {
  state.scrollTop = scrollerEl.scrollTop;
  scheduleRender();
}, { passive: true });

severityEl.addEventListener('change', applyFilters);

searchEl.addEventListener('input', () => {
  // Immediately increment seq so any in-flight request for old query is ignored
  fetchSeq++;
  debouncedSearch();
});

// ── Boot ──────────────────────────────────────────────────────────────────────
initialLoad();
