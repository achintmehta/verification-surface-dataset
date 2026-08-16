import { fetchLogs, fetchStats } from './api.js';
import { VirtualScroller } from './virtualScroller.js';

// ===== Constants =====
const ROW_HEIGHT = 36;
const FETCH_LIMIT = 100;
const DEBOUNCE_MS = 300;

const SEVERITY_CLASSES = {
  debug: 'severity-debug',
  info:  'severity-info',
  warn:  'severity-warn',
  error: 'severity-error',
};

// ===== DOM refs =====
const scrollContainer  = document.getElementById('scroll-container');
const scrollSpacer     = document.getElementById('scroll-spacer');
const rowsContainer    = document.getElementById('rows-container');
const severityFilter   = document.getElementById('severity-filter');
const searchInput      = document.getElementById('search-input');
const rowCountEl       = document.getElementById('row-count');
const statusText       = document.getElementById('status-text');
const offsetIndicator  = document.getElementById('offset-indicator');
const emptyState       = document.getElementById('empty-state');

// ===== Active filter state =====
let currentSeverity = '';
let currentQ = '';

// ===== Generation counter — discard stale responses =====
let filterGen = 0;

// ===== Helpers =====
function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatTs(isoStr) {
  // "2024-01-31T23:59:43.880Z" → "2024-01-31 23:59:43.880"
  return isoStr.replace('T', ' ').replace('Z', '');
}

// ===== Row renderer =====
function renderRow(row, el) {
  const sevClass = SEVERITY_CLASSES[row.severity] ?? 'severity-debug';
  // Add severity class to row for accent border
  el.className = `log-row sev-${row.severity}`;
  el.innerHTML =
    `<div class="col-ts">${formatTs(row.ts)}</div>` +
    `<div class="col-severity"><span class="severity-badge ${sevClass}">${row.severity}</span></div>` +
    `<div class="col-service">${escapeHtml(row.service)}</div>` +
    `<div class="col-message">${escapeHtml(row.message)}</div>`;
}

// ===== Virtual Scroller =====
const scroller = new VirtualScroller({
  container:    scrollContainer,
  spacer:       scrollSpacer,
  rowsContainer,
  rowHeight:    ROW_HEIGHT,
  overscan:     8,
  fetchLimit:   FETCH_LIMIT,

  fetchWindow: (offset, limit, signal) =>
    fetchLogs({ offset, limit, severity: currentSeverity, q: currentQ }, signal),

  renderRow,

  onStatus: (msg) => {
    statusText.textContent = msg;
  },

  onOffsetChange: (firstVisible, total) => {
    if (total > 0) {
      offsetIndicator.textContent = `row ${(firstVisible + 1).toLocaleString()} / ${total.toLocaleString()}`;
    } else {
      offsetIndicator.textContent = '';
    }
  },
});

// ===== Filter application =====
async function applyFilters() {
  const gen = ++filterGen;

  // Immediately reset UI
  scroller.setTotal(0);
  scroller.reset();
  emptyState.style.display = 'none';
  rowCountEl.textContent = 'Loading…';
  statusText.textContent = 'Fetching…';

  try {
    // Fetch first window + total
    const result = await fetchLogs(
      { offset: 0, limit: FETCH_LIMIT, severity: currentSeverity, q: currentQ }
    );

    // Discard if a newer filter was applied while we were waiting
    if (gen !== filterGen) return;

    // Seed the scroller cache with the first window
    scroller.setTotal(result.total);
    scroller.cache = result.rows;
    scroller.cacheOffset = 0;
    scroller.cacheSize = result.rows.length;

    // Show empty state if no results
    if (result.total === 0) {
      emptyState.style.display = '';
      rowCountEl.textContent = '0 rows';
      statusText.textContent = 'No results';
      return;
    }

    emptyState.style.display = 'none';
    updateRowCount(result.total);
    statusText.textContent = `Rows 1–${result.rows.length} of ${result.total.toLocaleString()}`;

    // Trigger render with the seeded cache
    scroller._scheduleRender();
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error('[applyFilters]', err);
    statusText.textContent = `Error: ${err.message}`;
    rowCountEl.textContent = 'Error';
  }
}

function updateRowCount(total) {
  const hasFilter = currentSeverity || currentQ;
  if (hasFilter) {
    rowCountEl.textContent = `${total.toLocaleString()} matching`;
  } else {
    rowCountEl.textContent = `${total.toLocaleString()} rows`;
  }
}

// ===== Debounce =====
function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

const debouncedSearch = debounce(() => {
  currentQ = searchInput.value.trim();
  applyFilters();
}, DEBOUNCE_MS);

// ===== Event listeners =====
severityFilter.addEventListener('change', () => {
  currentSeverity = severityFilter.value;
  applyFilters();
});

searchInput.addEventListener('input', debouncedSearch);

searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    searchInput.value = '';
    currentQ = '';
    applyFilters();
  }
});

// ===== Initial load =====
async function init() {
  statusText.textContent = 'Connecting to server…';

  try {
    // Load stats to populate severity counts
    const stats = await fetchStats();

    // Update severity dropdown options with counts
    const options = severityFilter.querySelectorAll('option[value]');
    for (const opt of options) {
      const sev = opt.value;
      if (sev && stats.bySeverity[sev] !== undefined) {
        const count = stats.bySeverity[sev].toLocaleString();
        opt.textContent = `${sev.charAt(0).toUpperCase() + sev.slice(1)} (${count})`;
      }
    }

    // Initial data load
    await applyFilters();
  } catch (err) {
    console.error('[init]', err);
    statusText.textContent = `Failed to connect: ${err.message}`;
    rowCountEl.textContent = 'Error';
  }
}

init();
