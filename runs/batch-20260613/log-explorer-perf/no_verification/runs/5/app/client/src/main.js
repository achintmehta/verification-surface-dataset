/**
 * Log Explorer — main entry point
 *
 * Wires together:
 *   - Filter controls (severity dropdown, debounced search input)
 *   - Stats bar (per-severity count badges)
 *   - VirtualScroller (virtualized log table)
 *
 * Stale-response prevention is handled inside VirtualScroller via generation
 * counters. The search input is debounced here so keystrokes never block.
 */

import { fetchStats } from './api.js';
import { VirtualScroller } from './virtualScroller.js';

const SEARCH_DEBOUNCE_MS = 300;

// ─── DOM refs ────────────────────────────────────────────────────────────────
const severitySelect    = /** @type {HTMLSelectElement} */ (document.getElementById('severity-select'));
const searchInput       = /** @type {HTMLInputElement}  */ (document.getElementById('search-input'));
const searchClear       = /** @type {HTMLButtonElement} */ (document.getElementById('search-clear'));
const severityBadges    = /** @type {HTMLElement}       */ (document.getElementById('severity-badges'));
const rowCountEl        = /** @type {HTMLElement}       */ (document.getElementById('row-count'));
const statusTextEl      = /** @type {HTMLElement}       */ (document.getElementById('status-text'));
const scrollerContainer = /** @type {HTMLElement}       */ (document.getElementById('scroller-container'));
const scrollerInner     = /** @type {HTMLElement}       */ (document.getElementById('scroller-inner'));
const rowsViewport      = /** @type {HTMLElement}       */ (document.getElementById('rows-viewport'));

// ─── State ───────────────────────────────────────────────────────────────────
let searchTimer    = null;
let statsAbortCtrl = null;

// ─── Virtual Scroller ────────────────────────────────────────────────────────
const scroller = new VirtualScroller({
  container: scrollerContainer,
  inner:     scrollerInner,
  viewport:  rowsViewport,
  onStatus:  handleStatus,
});

function handleStatus(msg) {
  statusTextEl.textContent = msg;
  updateRowCount();
}

function updateRowCount() {
  const total      = scroller.total;
  const hasSeverity = severitySelect.value !== '';
  const hasQ        = searchInput.value.trim() !== '';
  const hasFilter   = hasSeverity || hasQ;

  if (total === 0) {
    rowCountEl.textContent = hasFilter ? '0 matching' : 'Loading…';
  } else if (hasFilter) {
    rowCountEl.textContent = `${total.toLocaleString()} matching`;
  } else {
    rowCountEl.textContent = `${total.toLocaleString()} rows`;
  }
}

// ─── Stats (severity badges) ──────────────────────────────────────────────────
async function loadStats() {
  if (statsAbortCtrl) statsAbortCtrl.abort();
  statsAbortCtrl = new AbortController();

  try {
    const stats = await fetchStats(statsAbortCtrl.signal);
    renderBadges(stats.bySeverity);
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.warn('[stats] Failed to load:', err.message);
  }
}

function renderBadges(bySeverity) {
  const order = ['error', 'warn', 'info', 'debug'];
  severityBadges.innerHTML = '';
  for (const sev of order) {
    const count = bySeverity[sev] ?? 0;
    const badge = document.createElement('span');
    badge.className = `sev-badge ${sev}`;
    badge.textContent = `${sev} ${count.toLocaleString()}`;
    badge.title = `${count.toLocaleString()} ${sev} log entries`;
    severityBadges.appendChild(badge);
  }
}

// ─── Filter application ───────────────────────────────────────────────────────
function applyFilters() {
  const severity = severitySelect.value;
  const q        = searchInput.value;
  scroller.setFilters({ severity, q });
  updateRowCount();
}

// ─── Event listeners ─────────────────────────────────────────────────────────

// Severity dropdown — apply immediately (no debounce needed)
severitySelect.addEventListener('change', () => {
  applyFilters();
});

// Search input — debounced so keystrokes never block
searchInput.addEventListener('input', () => {
  const val = searchInput.value;
  searchClear.classList.toggle('visible', val.length > 0);

  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    searchTimer = null;
    applyFilters();
  }, SEARCH_DEBOUNCE_MS);
});

// Escape clears the search immediately
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    searchInput.value = '';
    searchClear.classList.remove('visible');
    if (searchTimer) { clearTimeout(searchTimer); searchTimer = null; }
    applyFilters();
  }
});

// Clear button
searchClear.addEventListener('click', () => {
  searchInput.value = '';
  searchClear.classList.remove('visible');
  if (searchTimer) { clearTimeout(searchTimer); searchTimer = null; }
  applyFilters();
});

// ─── Boot ────────────────────────────────────────────────────────────────────
function boot() {
  statusTextEl.textContent = 'Connecting to server…';
  rowCountEl.textContent   = 'Loading…';

  // Load stats for the badge counts (fire-and-forget)
  loadStats();

  // Kick off the initial data fetch
  applyFilters();
}

boot();
