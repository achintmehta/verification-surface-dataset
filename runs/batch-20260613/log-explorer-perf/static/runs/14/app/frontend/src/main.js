// App entry: wires the toolbar controls to the virtualized table.
import { VirtualTable } from './virtual-table.js';
import { fetchLogs, fetchStats } from './api.js';

const els = {
  severity: document.getElementById('severity'),
  search: document.getElementById('search'),
  count: document.getElementById('count'),
  scroller: document.getElementById('scroller'),
  spacer: document.getElementById('spacer'),
  viewport: document.getElementById('viewport'),
};

// Corpus-wide total (unfiltered), used for the "N of <total>" denominator.
let corpusTotal = 0;

const table = new VirtualTable({
  scroller: els.scroller,
  spacer: els.spacer,
  viewport: els.viewport,
  onCount: (filteredTotal) => {
    els.count.textContent = `${filteredTotal.toLocaleString()} of ${corpusTotal.toLocaleString()}`;
  },
});

// Monotonic token guarding filter-total fetches against out-of-order responses.
let filterEpoch = 0;
let filterController = null;

async function applyFilter() {
  const severity = els.severity.value;
  const q = els.search.value.trim();

  // Cancel any prior filter-total fetch; bump epoch so its result is ignored.
  filterEpoch++;
  const myEpoch = filterEpoch;
  if (filterController) filterController.abort();
  filterController = new AbortController();

  try {
    // Fetch just the head window to learn the exact `total` for these filters.
    const { total } = await fetchLogs(
      { offset: 0, limit: 1, severity, q },
      filterController.signal
    );
    if (myEpoch !== filterEpoch) return; // a newer filter superseded this one
    table.setFilter({ severity, q, total });
  } catch (err) {
    if (err.name === 'AbortError') return;
    // eslint-disable-next-line no-console
    console.error('[main] applyFilter failed', err);
  }
}

// Debounce for the search box (Decision 4): input never blocks on queries.
let debounceTimer = null;
function debouncedApply() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(applyFilter, 200);
}

els.severity.addEventListener('change', applyFilter);
els.search.addEventListener('input', debouncedApply);

async function boot() {
  try {
    const stats = await fetchStats();
    corpusTotal = stats.total;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[main] stats failed', err);
  }
  await applyFilter();
}

boot();
