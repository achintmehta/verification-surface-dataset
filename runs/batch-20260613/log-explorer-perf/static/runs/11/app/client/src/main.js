import { fetchLogs, fetchStats } from './api.js';
import { VirtualScroller } from './virtualScroller.js';

const els = {
  viewport: document.getElementById('viewport'),
  spacer: document.getElementById('spacer'),
  rows: document.getElementById('rows'),
  severity: document.getElementById('severity'),
  search: document.getElementById('search'),
  badges: document.getElementById('badges'),
  rowcount: document.getElementById('rowcount'),
  status: document.getElementById('status'),
};

const scroller = new VirtualScroller({
  viewport: els.viewport,
  spacer: els.spacer,
  rowsEl: els.rows,
  fetchPage: fetchLogs,
  onCounts: (visible, total) => {
    els.rowcount.textContent = `${total.toLocaleString()} rows` +
      (visible ? ` · showing ${visible}` : '');
  },
  onStatus: (msg) => {
    els.status.textContent = msg;
    els.status.classList.toggle('active', Boolean(msg));
  },
});

// --- Filter state + debounce -------------------------------------------------

let debounceTimer = null;
const DEBOUNCE_MS = 200;

function currentFilters() {
  return {
    severity: els.severity.value,
    q: els.search.value.trim(),
  };
}

function applyFilters() {
  // setFilters cancels stale in-flight work and guards against out-of-order
  // responses via its generation counter.
  scroller.setFilters(currentFilters());
}

els.severity.addEventListener('change', applyFilters);

els.search.addEventListener('input', () => {
  // Input is never blocked on a query: we only schedule work.
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(applyFilters, DEBOUNCE_MS);
});

// --- Stats badges ------------------------------------------------------------

async function loadStats() {
  try {
    const stats = await fetchStats();
    const order = ['debug', 'info', 'warn', 'error'];
    els.badges.innerHTML = order
      .map(
        (sev) =>
          `<span class="badge sev-${sev}">${sev}: ${(stats.bySeverity[sev] || 0).toLocaleString()}</span>`
      )
      .join('');
  } catch (err) {
    els.badges.textContent = 'stats unavailable';
  }
}

// --- Boot --------------------------------------------------------------------

loadStats();
scroller.setFilters(currentFilters());
