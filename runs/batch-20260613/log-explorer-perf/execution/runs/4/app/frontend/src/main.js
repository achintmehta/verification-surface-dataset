/**
 * Log Explorer - Main Application
 *
 * Wires together:
 * - Filter controls (severity dropdown + debounced search)
 * - Stats display (total + per-severity badges)
 * - VirtualScroller for the log table
 * - API client with stale-response prevention
 */

import { fetchLogs, fetchStats } from './api.js';
import { VirtualScroller } from './virtualScroller.js';

// ===== Constants =====
const DEBOUNCE_MS = 250;
const FETCH_LIMIT = 100;

// ===== DOM refs =====
const severitySelect = document.getElementById('severity-select');
const searchInput = document.getElementById('search-input');
const searchClear = document.getElementById('search-clear');
const severityBadges = document.getElementById('severity-badges');
const resultCount = document.getElementById('count-display');
const statusText = document.getElementById('status-text');
const statTotal = document.getElementById('stat-total');
const scrollContainer = document.getElementById('scroll-container');
const scrollSpacer = document.getElementById('scroll-spacer');
const virtualRows = document.getElementById('virtual-rows');

// ===== State =====
let currentSeverity = '';
let currentQ = '';
let currentTotal = 0;

// Sequence counter for filter changes (prevents stale total updates)
let filterSeq = 0;

// ===== Utility =====
function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

function formatTs(isoStr) {
  // Format: 2024-01-15 14:32:07.123
  const d = new Date(isoStr);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
         `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function highlightMatch(text, q) {
  if (!q) return escapeHtml(text);
  const escaped = escapeHtml(text);
  const escapedQ = escapeHtml(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return escaped.replace(new RegExp(escapedQ, 'gi'), (m) => `<span class="highlight">${m}</span>`);
}

function setStatus(msg) {
  statusText.textContent = msg;
}

// ===== Row renderer =====
function renderRow(el, row, index) {
  el.className = `log-row ${row.severity}`;

  const ts = formatTs(row.ts);
  const svc = escapeHtml(row.service);
  const msg = highlightMatch(row.message, currentQ);
  const sev = row.severity.toUpperCase().padEnd(5);

  el.innerHTML =
    `<div class="col-ts">${ts}</div>` +
    `<div class="col-severity">${sev}</div>` +
    `<div class="col-service">${svc}</div>` +
    `<div class="col-message">${msg}</div>`;
}

// ===== Virtual Scroller setup =====
const scroller = new VirtualScroller({
  container: scrollContainer,
  spacer: scrollSpacer,
  rowsEl: virtualRows,
  fetchWindow: async (offset, limit, signal) => {
    return fetchLogs({
      offset,
      limit,
      severity: currentSeverity,
      q: currentQ,
    }, signal);
  },
  renderRow,
  onStatus: setStatus,
});

// ===== Stats =====
async function loadStats() {
  try {
    const stats = await fetchStats();
    statTotal.textContent = `${stats.total.toLocaleString()} total rows`;

    // Render severity badges with counts
    severityBadges.innerHTML = '';
    const sevs = ['error', 'warn', 'info', 'debug'];
    for (const sev of sevs) {
      const count = stats.bySeverity[sev] || 0;
      const badge = document.createElement('span');
      badge.className = `sev-badge ${sev}`;
      badge.textContent = `${sev} ${count.toLocaleString()}`;
      badge.title = `${count.toLocaleString()} ${sev} entries`;
      severityBadges.appendChild(badge);
    }
  } catch (err) {
    console.error('Failed to load stats:', err);
    statTotal.textContent = 'Stats unavailable';
  }
}

// ===== Filter application =====
async function applyFilters() {
  const seq = ++filterSeq;
  const severity = currentSeverity;
  const q = currentQ;

  setStatus('Fetching...');

  try {
    // Fetch total count for the current filter
    const { total } = await fetchLogs({ offset: 0, limit: 1, severity, q });

    // Discard if a newer filter was applied
    if (seq !== filterSeq) return;

    currentTotal = total;

    // Update result count display
    const label = total === 0
      ? 'No results'
      : `${total.toLocaleString()} row${total !== 1 ? 's' : ''}`;
    resultCount.textContent = label;

    // Reset scroller with new total
    scroller.reset(total);

    if (total === 0) {
      // Show empty state
      virtualRows.innerHTML =
        '<div class="state-overlay">' +
        '<div class="icon">🔍</div>' +
        '<div class="msg">No log entries match your filters</div>' +
        '</div>';
      setStatus('No results');
    } else {
      setStatus(`Showing ${Math.min(FETCH_LIMIT, total).toLocaleString()} of ${total.toLocaleString()} rows`);
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
    if (seq !== filterSeq) return;
    console.error('Filter error:', err);
    setStatus(`Error: ${err.message}`);
  }
}

// ===== Event handlers =====
severitySelect.addEventListener('change', () => {
  currentSeverity = severitySelect.value;
  applyFilters();
});

const debouncedSearch = debounce(() => {
  currentQ = searchInput.value.trim();
  searchClear.hidden = !currentQ;
  applyFilters();
}, DEBOUNCE_MS);

searchInput.addEventListener('input', debouncedSearch);

searchClear.addEventListener('click', () => {
  searchInput.value = '';
  currentQ = '';
  searchClear.hidden = true;
  applyFilters();
});

// ===== Initialization =====
async function init() {
  setStatus('Connecting to server...');

  // Wait for server to be ready (retry on failure)
  let retries = 0;
  while (retries < 30) {
    try {
      await loadStats();
      break;
    } catch (err) {
      retries++;
      setStatus(`Waiting for server... (${retries})`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  // Initial load
  await applyFilters();
}

init();
