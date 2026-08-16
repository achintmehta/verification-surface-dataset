import { VirtualScroller } from './virtualScroller.js';
import { fetchStats } from './api.js';

// ── DOM refs ──────────────────────────────────────────────────────────────────
const scrollerContainer = document.getElementById('scroller-container');
const scrollerInner     = document.getElementById('scroller-inner');
const rowsViewport      = document.getElementById('rows-viewport');
const rowCountEl        = document.getElementById('row-count');
const statusTextEl      = document.getElementById('status-text');
const severitySelect    = document.getElementById('severity-select');
const searchInput       = document.getElementById('search-input');
const clearSearchBtn    = document.getElementById('clear-search');

// ── Filter state ──────────────────────────────────────────────────────────────
let currentSeverity = '';
let currentQ        = '';
let debounceTimer   = null;
const DEBOUNCE_MS   = 300;

// ── Virtual Scroller ──────────────────────────────────────────────────────────
const scroller = new VirtualScroller({
  container: scrollerContainer,
  inner:     scrollerInner,
  viewport:  rowsViewport,

  onTotalChange(total) {
    updateRowCount(total);
  },

  onStatusChange(msg) {
    statusTextEl.textContent = msg;
  },
});

// ── Row-count badge ───────────────────────────────────────────────────────────
function updateRowCount(total) {
  const parts = [];
  if (currentSeverity) parts.push(currentSeverity);
  if (currentQ)        parts.push(`"${currentQ}"`);
  const suffix = parts.length ? ` (${parts.join(', ')})` : '';
  rowCountEl.textContent = `${total.toLocaleString()} rows${suffix}`;
}

// ── Severity filter ───────────────────────────────────────────────────────────
severitySelect.addEventListener('change', () => {
  currentSeverity = severitySelect.value;
  applyFilters();
});

// ── Search filter (debounced) ─────────────────────────────────────────────────
searchInput.addEventListener('input', () => {
  const val = searchInput.value;
  clearSearchBtn.classList.toggle('visible', val.length > 0);

  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    currentQ = val.trim();
    applyFilters();
  }, DEBOUNCE_MS);
});

clearSearchBtn.addEventListener('click', () => {
  searchInput.value = '';
  clearSearchBtn.classList.remove('visible');
  if (debounceTimer) clearTimeout(debounceTimer);
  currentQ = '';
  applyFilters();
  searchInput.focus();
});

function applyFilters() {
  scroller.setFilters({ severity: currentSeverity, q: currentQ });
}

// ── Stats (severity badge counts) ─────────────────────────────────────────────
async function loadStats() {
  try {
    const stats = await fetchStats();

    // Annotate each severity option with its count
    for (const opt of severitySelect.querySelectorAll('option[value]')) {
      const sev = opt.value;
      if (sev && stats.bySeverity[sev] != null) {
        const label = sev.charAt(0).toUpperCase() + sev.slice(1);
        opt.textContent = `${label} (${stats.bySeverity[sev].toLocaleString()})`;
      }
    }
  } catch (err) {
    console.warn('[stats]', err);
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────
async function init() {
  statusTextEl.textContent = 'Connecting…';
  rowCountEl.textContent   = 'Loading…';

  // Fire stats fetch in parallel — it only updates labels, not critical path
  loadStats();

  try {
    await scroller.init();
  } catch (err) {
    statusTextEl.textContent = `Failed to connect: ${err.message}`;
    rowCountEl.textContent   = 'Error';
    console.error('[init]', err);
  }
}

init();
