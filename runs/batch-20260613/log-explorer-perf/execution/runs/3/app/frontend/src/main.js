import { fetchLogs, fetchStats } from './api.js';
import { VirtualScroller } from './virtualScroller.js';

// ===== DOM references =====
const severitySelect = document.getElementById('severity-select');
const searchInput = document.getElementById('search-input');
const rowCountEl = document.getElementById('row-count');
const severityBadge = document.getElementById('severity-badge');
const scrollerEl = document.getElementById('scroller');
const spacerEl = document.getElementById('spacer');
const rowsContainer = document.getElementById('rows-container');
const statusText = document.getElementById('status-text');

// ===== State =====
let currentSeverity = '';
let currentQ = '';
let searchDebounceTimer = null;

// Request sequencing: only the latest filter-change response is applied
// (prevents stale responses from overwriting newer ones)
let filterSeq = 0;

// ===== Severity color map =====
const SEV_CLASS = {
  debug: 'sev-debug',
  info: 'sev-info',
  warn: 'sev-warn',
  error: 'sev-error',
};

// ===== Format timestamp =====
function formatTs(isoStr) {
  // "2023-11-14T12:34:56.000Z" → "2023-11-14 12:34:56"
  if (!isoStr) return '';
  return isoStr.replace('T', ' ').replace(/\.\d+Z?$/, '').replace('Z', '');
}

// ===== HTML escaping =====
function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ===== Highlight search term in message =====
function highlightMessage(message, q) {
  const escaped = escapeHtml(message);
  if (!q) return escaped;
  // Escape regex special chars in the search term
  const escapedQ = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    return escaped.replace(
      new RegExp(escapedQ.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'), 'gi'),
      (m) => `<mark>${escapeHtml(m)}</mark>`
    );
  } catch {
    return escaped;
  }
}

// ===== Render a single row into a pool element =====
function renderRow(el, row) {
  el.innerHTML = `
    <div class="col-ts">${formatTs(row.ts)}</div>
    <div class="col-severity ${SEV_CLASS[row.severity] || ''}">${escapeHtml(row.severity)}</div>
    <div class="col-service" title="${escapeHtml(row.service)}">${escapeHtml(row.service)}</div>
    <div class="col-message" title="${escapeHtml(row.message)}">${highlightMessage(row.message, currentQ)}</div>
  `;
}

// ===== Update UI =====
function updateRowCount(total) {
  const hasFilter = currentSeverity || currentQ;
  if (hasFilter) {
    rowCountEl.textContent = `${total.toLocaleString()} matching rows`;
  } else {
    rowCountEl.textContent = `${total.toLocaleString()} rows`;
  }
}

function setStatus(msg) {
  statusText.textContent = msg;
}

// ===== Virtual scroller =====
const scroller = new VirtualScroller({
  scroller: scrollerEl,
  spacer: spacerEl,
  container: rowsContainer,
  onFetch: async (offset, limit, signal) => {
    const result = await fetchLogs(
      { offset, limit, severity: currentSeverity, q: currentQ },
      signal
    );
    setStatus(
      `Rows ${offset + 1}–${Math.min(offset + result.rows.length, result.total).toLocaleString()} of ${result.total.toLocaleString()}`
    );
    return result;
  },
  renderRow,
});

// ===== Apply filters =====
// This is called whenever severity or search changes.
// It fetches the first window, updates the total, and resets the scroller.
async function applyFilters() {
  const seq = ++filterSeq;
  const severity = currentSeverity;
  const q = currentQ;

  setStatus('Loading...');

  // Cancel any in-flight scroller fetch
  if (scroller.fetchAbort) {
    scroller.fetchAbort.abort();
    scroller.fetchAbort = null;
  }

  try {
    const result = await fetchLogs({ offset: 0, limit: 100, severity, q });

    // Check if this response is still current
    if (seq !== filterSeq) return;

    updateRowCount(result.total);

    // Prime the cache with the first window before resetting
    // so the initial render doesn't need to fetch again
    scroller.primeCache(0, result.rows);
    scroller.reset(result.total);

    if (result.total === 0) {
      setStatus('No matching rows');
    } else {
      setStatus(`${result.total.toLocaleString()} rows`);
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
    if (seq !== filterSeq) return;
    console.error('[applyFilters]', err);
    setStatus('Error loading logs');
  }
}

// ===== Load stats for badges =====
async function loadStats() {
  try {
    const stats = await fetchStats();
    if (currentSeverity && stats.bySeverity[currentSeverity] !== undefined) {
      severityBadge.textContent = stats.bySeverity[currentSeverity].toLocaleString();
      severityBadge.classList.remove('hidden');
    } else {
      severityBadge.classList.add('hidden');
    }
  } catch (err) {
    console.error('[loadStats]', err);
  }
}

// ===== Event listeners =====
severitySelect.addEventListener('change', () => {
  currentSeverity = severitySelect.value;
  loadStats();
  applyFilters();
});

searchInput.addEventListener('input', () => {
  clearTimeout(searchDebounceTimer);
  // Show immediate feedback that we received the input
  setStatus('Typing...');
  searchDebounceTimer = setTimeout(() => {
    currentQ = searchInput.value.trim();
    applyFilters();
  }, 300); // 300ms debounce — input is never blocked
});

// ===== Initial load =====
(async () => {
  setStatus('Connecting...');
  try {
    await applyFilters();
    await loadStats();
  } catch (err) {
    setStatus('Failed to connect to backend');
    console.error(err);
  }
})();
