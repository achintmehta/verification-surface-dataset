/**
 * Log Explorer — main entry point.
 *
 * Wires together:
 *  - Filter controls (severity dropdown + debounced search)
 *  - Stats bar (per-severity badges)
 *  - VirtualScroller (virtualized log table)
 *  - API client (windowed fetch with AbortController)
 */

import { fetchLogs, fetchStats } from './api.js';
import { VirtualScroller } from './virtualScroller.js';

const DEBOUNCE_MS = 300;
const FETCH_LIMIT = 100;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const severitySelect    = /** @type {HTMLSelectElement} */ (document.getElementById('severity-select'));
const searchInput       = /** @type {HTMLInputElement}  */ (document.getElementById('search-input'));
const rowCountEl        = document.getElementById('row-count');
const statusBar         = document.getElementById('status-bar');
const scrollerContainer = document.getElementById('scroller-container');
const scrollerInner     = document.getElementById('scroller-inner');
const badgeError        = document.getElementById('badge-error');
const badgeWarn         = document.getElementById('badge-warn');
const badgeInfo         = document.getElementById('badge-info');
const badgeDebug        = document.getElementById('badge-debug');

// ── State ─────────────────────────────────────────────────────────────────────
let currentSeverity = '';
let currentQ        = '';

// Request sequencing: only the latest request's response is applied
let requestSeq = 0;

// AbortController for the current in-flight filter-change request
let filterAbortController = null;

// Debounce timer
let debounceTimer = null;

// ── VirtualScroller ───────────────────────────────────────────────────────────
const scroller = new VirtualScroller({
  container: scrollerContainer,
  inner:     scrollerInner,
  fetchWindow: async (offset, limit, signal) => {
    return fetchLogs({
      offset,
      limit: Math.min(limit, FETCH_LIMIT),
      severity: currentSeverity || null,
      q:        currentQ        || null,
    }, signal);
  },
});

// ── Filter application ────────────────────────────────────────────────────────
async function applyFilters() {
  // Cancel any previous in-flight filter request
  if (filterAbortController) {
    filterAbortController.abort();
  }
  filterAbortController = new AbortController();
  const signal = filterAbortController.signal;

  const seq = ++requestSeq;
  setStatus('Loading…');

  try {
    const result = await fetchLogs({
      offset:   0,
      limit:    FETCH_LIMIT,
      severity: currentSeverity || null,
      q:        currentQ        || null,
    }, signal);

    // Discard stale responses
    if (seq !== requestSeq) return;

    // Reset scroller (clears cache, resets scroll to top, sets inner height)
    scroller.reset(result.total);

    // Pre-populate cache with the rows we already fetched
    scroller.seedCache(0, result.rows);

    // Paint the initial viewport
    scroller.paintViewport();

    updateRowCount(result.total);
    setStatus(
      result.total === 0
        ? 'No results for current filters.'
        : `Loaded — ${fmtCount(result.total)} rows total`
    );

  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error('[filters] Error applying filters:', err);
    setStatus(`Error: ${err.message}`);
  }
}

// ── Event listeners ───────────────────────────────────────────────────────────
severitySelect.addEventListener('change', () => {
  currentSeverity = severitySelect.value;
  applyFilters();
});

searchInput.addEventListener('input', () => {
  currentQ = searchInput.value;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(applyFilters, DEBOUNCE_MS);
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function updateRowCount(total) {
  const parts = [];
  if (currentSeverity) parts.push(currentSeverity);
  if (currentQ)        parts.push(`"${currentQ}"`);
  const suffix = parts.length > 0 ? ` (${parts.join(', ')})` : '';
  rowCountEl.textContent = `${fmtCount(total)} rows${suffix}`;
}

function setStatus(msg) {
  statusBar.textContent = msg;
}

function fmtCount(n) {
  return Number(n).toLocaleString();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Boot ──────────────────────────────────────────────────────────────────────
async function boot() {
  setStatus('Connecting to server…');
  rowCountEl.textContent = 'Loading…';

  // Show loading spinner
  scrollerInner.innerHTML = `
    <div class="empty-state">
      <div class="spinner"></div>
      <p>Loading log corpus…</p>
    </div>
  `;

  // Wait for server to be ready (retry loop for first-boot seeding)
  let ready = false;
  let attempts = 0;

  while (!ready && attempts < 120) {
    try {
      const stats = await fetchStats();
      if (stats.total >= 100000) {
        ready = true;
        badgeError.textContent = fmtCount(stats.bySeverity.error);
        badgeWarn.textContent  = fmtCount(stats.bySeverity.warn);
        badgeInfo.textContent  = fmtCount(stats.bySeverity.info);
        badgeDebug.textContent = fmtCount(stats.bySeverity.debug);
      } else if (stats.total > 0) {
        setStatus(`Seeding database… (${fmtCount(stats.total)} / 100,000 rows)`);
        await sleep(1500);
      } else {
        setStatus('Seeding database… (starting up)');
        await sleep(1500);
      }
    } catch {
      setStatus(`Waiting for server… (attempt ${attempts + 1})`);
      await sleep(1000);
    }
    attempts++;
  }

  if (!ready) {
    setStatus('Server unavailable. Please refresh the page.');
    scrollerInner.innerHTML = `
      <div class="empty-state">
        <h2>Server Unavailable</h2>
        <p>Please ensure the backend is running and refresh.</p>
      </div>
    `;
    return;
  }

  // Clear spinner, build the DOM pool, then load data
  scrollerInner.innerHTML = '';
  scroller.buildPool();

  setStatus('Ready');
  await applyFilters();
}

boot();
