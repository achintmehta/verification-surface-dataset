/**
 * Log Explorer – main entry point
 *
 * Wires together:
 *   - VirtualScroller (virtualized row rendering)
 *   - Severity filter buttons
 *   - Debounced search input
 *   - Stats badges
 *   - Row count label
 */

import { VirtualScroller } from './virtualScroller.js';
import { fetchStats } from './api.js';

// ── DOM refs ───────────────────────────────────────────────────────────────
const scrollContainer  = document.getElementById('scroll-container');
const scrollSpacer     = document.getElementById('scroll-spacer');
const rowsViewport     = document.getElementById('rows-viewport');
const rowCountLabel    = document.getElementById('row-count-label');
const loadingIndicator = document.getElementById('loading-indicator');
const searchInput      = document.getElementById('search-input');
const searchClear      = document.getElementById('search-clear');
const severityFilter   = document.getElementById('severity-filter');

// ── State ──────────────────────────────────────────────────────────────────
let currentSeverity = '';
let currentQ        = '';
let currentTotal    = 0;
let searchDebounce  = null;

// ── VirtualScroller ────────────────────────────────────────────────────────
const scroller = new VirtualScroller({
  scrollContainer,
  spacer:          scrollSpacer,
  viewport:        rowsViewport,
  onTotalChange:   (total) => {
    currentTotal = total;
    updateRowCountLabel();
  },
  onLoadingChange: (loading) => {
    loadingIndicator.hidden = !loading;
  },
});

// ── Severity filter ────────────────────────────────────────────────────────
severityFilter.addEventListener('click', (e) => {
  const btn = e.target.closest('.sev-btn');
  if (!btn) return;

  const sev = btn.dataset.severity;
  if (sev === currentSeverity) return; // no change

  // Update active state
  severityFilter.querySelectorAll('.sev-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');

  currentSeverity = sev;
  applyFilters();
});

// ── Search input ───────────────────────────────────────────────────────────
const DEBOUNCE_MS = 250;

searchInput.addEventListener('input', () => {
  const val = searchInput.value;
  searchClear.hidden = val === '';

  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    const newQ = val.trim();
    if (newQ === currentQ) return;
    currentQ = newQ;
    applyFilters();
  }, DEBOUNCE_MS);
});

searchClear.addEventListener('click', () => {
  searchInput.value = '';
  searchClear.hidden = true;
  clearTimeout(searchDebounce);
  if (currentQ !== '') {
    currentQ = '';
    applyFilters();
  }
  searchInput.focus();
});

// ── Apply filters ──────────────────────────────────────────────────────────
function applyFilters() {
  scroller.setFilters({ severity: currentSeverity, q: currentQ });
}

// ── Row count label ────────────────────────────────────────────────────────
function updateRowCountLabel() {
  const filterDesc = buildFilterDesc();
  if (currentTotal === 0) {
    rowCountLabel.textContent = filterDesc
      ? `0 rows match "${filterDesc}"`
      : '0 rows';
  } else {
    rowCountLabel.textContent = filterDesc
      ? `${currentTotal.toLocaleString()} rows matching ${filterDesc}`
      : `${currentTotal.toLocaleString()} rows`;
  }
}

function buildFilterDesc() {
  const parts = [];
  if (currentSeverity) parts.push(`severity=${currentSeverity}`);
  if (currentQ)        parts.push(`"${currentQ}"`);
  return parts.join(' + ');
}

// ── Stats badges ───────────────────────────────────────────────────────────
async function loadStats() {
  try {
    const stats = await fetchStats();
    document.getElementById('badge-debug').textContent = fmtCount(stats.bySeverity.debug);
    document.getElementById('badge-info').textContent  = fmtCount(stats.bySeverity.info);
    document.getElementById('badge-warn').textContent  = fmtCount(stats.bySeverity.warn);
    document.getElementById('badge-error').textContent = fmtCount(stats.bySeverity.error);
  } catch (err) {
    console.warn('[stats] Failed to load stats:', err.message);
  }
}

function fmtCount(n) {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

// ── Boot ───────────────────────────────────────────────────────────────────
rowCountLabel.textContent = 'Loading…';

// Initial data load
scroller.setFilters({ severity: '', q: '' });
loadStats();
