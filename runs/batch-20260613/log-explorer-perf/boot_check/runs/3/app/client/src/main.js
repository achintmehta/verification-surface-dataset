import { fetchLogs, fetchStats } from './api.js';
import { VirtualScroller } from './virtualScroller.js';

// ── DOM refs ───────────────────────────────────────────────────────────────
const severitySelect  = document.getElementById('severity-select');
const searchInput     = document.getElementById('search-input');
const rowCountEl      = document.getElementById('row-count');
const statusBar       = document.getElementById('status-bar');
const scrollerContainer = document.getElementById('scroller-container');
const scrollSpacer    = document.getElementById('scroll-spacer');
const rowsViewport    = document.getElementById('rows-viewport');

const badgeEls = {
  debug: document.getElementById('badge-debug'),
  info:  document.getElementById('badge-info'),
  warn:  document.getElementById('badge-warn'),
  error: document.getElementById('badge-error'),
};

// ── State ──────────────────────────────────────────────────────────────────
let currentSeverity = '';
let currentQ        = '';
let currentTotal    = 0;

// Abort controller for in-flight requests (prevents stale responses)
let fetchController = null;
// Monotonic request counter — only the latest response is applied
let requestSeq = 0;

// ── Virtual scroller ───────────────────────────────────────────────────────
const scroller = new VirtualScroller({
  container: scrollerContainer,
  spacer:    scrollSpacer,
  viewport:  rowsViewport,
  onWindowChange: (offset, limit) => {
    loadWindow(offset, limit);
  },
});

// ── Debounce helper ────────────────────────────────────────────────────────
function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

// ── Core data loading ──────────────────────────────────────────────────────

/**
 * Load a window of rows at the given offset.
 * Cancels any in-flight request and ignores stale responses.
 */
async function loadWindow(offset, limit) {
  // Cancel previous in-flight request
  if (fetchController) {
    fetchController.abort();
  }
  fetchController = new AbortController();
  const seq = ++requestSeq;

  setStatus('Loading…');

  try {
    const t0 = performance.now();
    const data = await fetchLogs(
      { offset, limit, severity: currentSeverity, q: currentQ },
      fetchController.signal
    );
    const elapsed = Math.round(performance.now() - t0);

    // Discard stale responses
    if (seq !== requestSeq) return;

    currentTotal = data.total;
    scroller.setTotal(data.total);
    updateRowCount(data.total);

    if (data.rows.length === 0 && data.total === 0) {
      scroller.showEmpty('No log entries match your filters');
      setStatus('No results');
    } else {
      scroller.renderRows(data.rows, offset);
      setStatus(`Fetched rows ${offset}–${offset + data.rows.length - 1} of ${data.total} in ${elapsed}ms`);
    }
  } catch (err) {
    if (err.name === 'AbortError') return; // cancelled — ignore
    console.error('[main] fetchLogs error:', err);
    setStatus(`Error: ${err.message}`);
  }
}

/**
 * Reset filters, scroll to top, and reload.
 */
function resetAndLoad() {
  scroller.reset();
  scroller.setTotal(0);
  updateRowCount(0);
  const limit = scroller.getWindowSize();
  loadWindow(0, limit);
}

// ── Stats ──────────────────────────────────────────────────────────────────
async function loadStats() {
  try {
    const stats = await fetchStats();
    for (const [sev, el] of Object.entries(badgeEls)) {
      el.textContent = (stats.bySeverity[sev] ?? 0).toLocaleString();
    }
  } catch (err) {
    console.warn('[main] fetchStats error:', err);
  }
}

// ── UI helpers ─────────────────────────────────────────────────────────────
function updateRowCount(total) {
  const filterActive = currentSeverity || currentQ;
  if (filterActive) {
    rowCountEl.textContent = `${total.toLocaleString()} of 100,000 rows`;
  } else {
    rowCountEl.textContent = `${total.toLocaleString()} rows`;
  }
}

function setStatus(msg) {
  statusBar.textContent = msg;
}

// ── Event listeners ────────────────────────────────────────────────────────
severitySelect.addEventListener('change', () => {
  currentSeverity = severitySelect.value;
  resetAndLoad();
});

const debouncedSearch = debounce((value) => {
  currentQ = value.trim();
  resetAndLoad();
}, 300);

searchInput.addEventListener('input', (e) => {
  // Input is never blocked — debounce fires the actual query
  debouncedSearch(e.target.value);
});

// ── Boot ───────────────────────────────────────────────────────────────────
async function init() {
  setStatus('Connecting to server…');

  // Wait for server to be ready (it may still be seeding on first boot)
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const res = await fetch('http://localhost:3001/health');
      if (res.ok) { ready = true; break; }
    } catch (_) { /* not ready yet */ }
    await new Promise(r => setTimeout(r, 500));
    setStatus(`Waiting for server… (${Math.round(attempt * 0.5)}s)`);
  }

  if (!ready) {
    setStatus('Could not connect to server. Is it running?');
    return;
  }

  // Load stats (badges) and initial window in parallel
  await Promise.all([
    loadStats(),
    loadWindow(0, scroller.getWindowSize()),
  ]);
}

init();
