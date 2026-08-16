// App wiring: filter controls, debounced search, and the virtual table.
import { VirtualTable } from './virtual-table.js';
import { fetchStats } from './api.js';

const els = {
  severity: document.getElementById('severity-select'),
  search: document.getElementById('search-input'),
  countBadge: document.getElementById('count-badge'),
  status: document.getElementById('status'),
  viewport: document.getElementById('scroll-viewport'),
  spacer: document.getElementById('scroll-spacer'),
  rowsLayer: document.getElementById('rows-layer'),
  emptyState: document.getElementById('empty-state'),
};

// The whole-corpus total (unfiltered), used to render "N of <corpusTotal>".
let corpusTotal = 0;

function renderCount(filteredTotal) {
  const filtered = Number(filteredTotal) || 0;
  const base = corpusTotal || filtered;
  els.countBadge.innerHTML = `<strong>${filtered.toLocaleString()}</strong> of ${base.toLocaleString()}`;
}

const table = new VirtualTable({
  viewport: els.viewport,
  spacer: els.spacer,
  rowsLayer: els.rowsLayer,
  emptyState: els.emptyState,
  onCount: renderCount,
});

function currentFilter() {
  return {
    severity: els.severity.value,
    q: els.search.value.trim(),
  };
}

function applyFilter() {
  table.setFilter(currentFilter());
}

// Severity changes apply immediately.
els.severity.addEventListener('change', applyFilter);

// Search is debounced: typing never blocks, and only the latest keystroke
// after the debounce window triggers a query. Stale responses are already
// discarded inside VirtualTable via its generation token.
const DEBOUNCE_MS = 200;
let debounceTimer = null;
els.search.addEventListener('input', () => {
  els.status.textContent = 'typing…';
  els.status.classList.add('loading');
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    els.status.textContent = '';
    els.status.classList.remove('loading');
    applyFilter();
  }, DEBOUNCE_MS);
});

// Load corpus-wide stats for the "of <total>" denominator, then do the initial
// load. If stats fail (e.g. backend still booting), fall back gracefully.
async function init() {
  try {
    const stats = await fetchStats();
    corpusTotal = stats.total;
  } catch (err) {
    console.warn('[main] stats unavailable, will derive total from queries', err);
  }
  applyFilter();
}

init();
