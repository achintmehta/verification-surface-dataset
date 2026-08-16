/**
 * Log Explorer — Main Application
 *
 * Wires together:
 * - Filter controls (severity dropdown + debounced search)
 * - API client (with AbortController for stale-response prevention)
 * - VirtualScroller (DOM-bounded rendering)
 * - Stats display (corpus badge + severity badges)
 */

import { fetchLogs, fetchStats } from './api.js';
import { VirtualScroller } from './virtualScroller.js';

// ── Constants ──────────────────────────────────────────────────────────────
const DEBOUNCE_MS = 250;
const FETCH_LIMIT = 150; // rows per window fetch (≤ 200)

// ── DOM refs ───────────────────────────────────────────────────────────────
const corpusBadge    = document.getElementById('corpus-badge');
const rowCountEl     = document.getElementById('row-count');
const severitySelect = document.getElementById('severity-select');
const searchInput    = document.getElementById('search-input');
const clearSearchBtn = document.getElementById('clear-search');
const severityBadges = document.getElementById('severity-badges');
const scrollContainer = document.getElementById('scroll-container');
const scrollSpacer   = document.getElementById('scroll-spacer');
const virtualRows    = document.getElementById('virtual-rows');
const emptyState     = document.getElementById('empty-state');
const loadingOverlay = document.getElementById('loading-overlay');

// ── State ──────────────────────────────────────────────────────────────────
let currentSeverity = '';
let currentQ = '';
let currentTotal = 0;    // filtered total (from last successful fetch)
let corpusTotal = 0;     // unfiltered corpus total (from stats)
let abortController = null; // for cancelling in-flight requests
let debounceTimer = null;
let isLoading = false;

// ── Row renderer ───────────────────────────────────────────────────────────
function renderRow(row) {
  const el = document.createElement('div');
  el.className = `log-row ${row.severity}`;

  // Format timestamp: "2024-01-15 14:32:07.123"
  const ts = new Date(row.ts);
  const tsStr = ts.toISOString().replace('T', ' ').replace('Z', '').slice(0, 23);

  el.innerHTML = `
    <div class="col-ts">${tsStr}</div>
    <div class="col-severity"><span class="sev-pill ${row.severity}">${row.severity}</span></div>
    <div class="col-service" title="${escHtml(row.service)}">${escHtml(row.service)}</div>
    <div class="col-message" title="${escHtml(row.message)}">${escHtml(row.message)}</div>
  `;

  return el;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Virtual Scroller ───────────────────────────────────────────────────────
const scroller = new VirtualScroller({
  container: scrollContainer,
  spacer: scrollSpacer,
  rowsEl: virtualRows,
  renderRow,
  onWindowChange: (offset, limit) => {
    fetchWindow(offset, Math.min(limit, FETCH_LIMIT));
  },
});

// ── Fetch logic ────────────────────────────────────────────────────────────
async function fetchWindow(offset, limit) {
  // Cancel any in-flight request
  if (abortController) {
    abortController.abort();
  }
  abortController = new AbortController();
  const signal = abortController.signal;

  setLoading(true);

  try {
    const data = await fetchLogs(
      { offset, limit, severity: currentSeverity, q: currentQ },
      signal
    );

    // If this request was aborted, ignore the result
    if (signal.aborted) return;

    currentTotal = data.total;
    scroller.setData(data.rows, data.total, offset);
    updateRowCount(data.total);
    showEmpty(data.total === 0);
    setLoading(false);
  } catch (err) {
    if (err.name === 'AbortError') return; // stale request, ignore
    console.error('[fetchWindow] Error:', err);
    setLoading(false);
  }
}

// ── Filter handlers ────────────────────────────────────────────────────────
function applyFilters() {
  scroller.resetScroll();
  fetchWindow(0, FETCH_LIMIT);
}

severitySelect.addEventListener('change', () => {
  currentSeverity = severitySelect.value;
  applyFilters();
});

searchInput.addEventListener('input', () => {
  const val = searchInput.value;
  clearSearchBtn.style.display = val ? 'block' : 'none';

  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    currentQ = val.trim();
    applyFilters();
  }, DEBOUNCE_MS);
});

clearSearchBtn.addEventListener('click', () => {
  searchInput.value = '';
  clearSearchBtn.style.display = 'none';
  currentQ = '';
  applyFilters();
});

// ── Stats ──────────────────────────────────────────────────────────────────
async function loadStats() {
  try {
    const stats = await fetchStats();
    corpusTotal = stats.total;
    corpusBadge.textContent = `${stats.total.toLocaleString()} entries`;

    // Render severity badges
    severityBadges.innerHTML = '';
    for (const sev of ['error', 'warn', 'info', 'debug']) {
      const count = stats.bySeverity[sev] || 0;
      const badge = document.createElement('button');
      badge.className = `sev-badge ${sev}`;
      badge.title = `Filter by ${sev}`;
      badge.innerHTML = `
        <span>${sev}</span>
        <span class="badge-count">${count.toLocaleString()}</span>
      `;
      badge.addEventListener('click', () => {
        const newVal = severitySelect.value === sev ? '' : sev;
        severitySelect.value = newVal;
        currentSeverity = newVal;
        applyFilters();
      });
      severityBadges.appendChild(badge);
    }
  } catch (err) {
    console.error('[loadStats] Error:', err);
    corpusBadge.textContent = 'Stats unavailable';
  }
}

// ── UI helpers ─────────────────────────────────────────────────────────────
function updateRowCount(total) {
  const isFiltered = currentSeverity || currentQ;
  if (isFiltered) {
    rowCountEl.innerHTML = `<strong>${total.toLocaleString()}</strong> of <strong>${corpusTotal.toLocaleString()}</strong> rows`;
  } else {
    rowCountEl.innerHTML = `<strong>${total.toLocaleString()}</strong> rows`;
  }
}

function showEmpty(isEmpty) {
  emptyState.style.display = isEmpty ? 'flex' : 'none';
  scrollContainer.style.display = isEmpty ? 'none' : 'block';
}

function setLoading(loading) {
  isLoading = loading;
  loadingOverlay.style.display = loading ? 'flex' : 'none';
}

// ── Boot ───────────────────────────────────────────────────────────────────
async function init() {
  setLoading(true);
  await loadStats();
  await fetchWindow(0, FETCH_LIMIT);
}

init();
