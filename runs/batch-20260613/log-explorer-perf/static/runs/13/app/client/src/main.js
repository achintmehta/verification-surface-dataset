import { VirtualScroller } from './virtualScroller.js';
import { fetchStats } from './api.js';

const scrollerEl = document.getElementById('scroller');
const rowsEl = document.getElementById('rows');
const spacerEl = document.getElementById('spacer');
const severityEl = document.getElementById('severity');
const searchEl = document.getElementById('search');
const countEl = document.getElementById('count');

let grandTotal = 0;

function renderCount(filteredTotal) {
  const filtered = filteredTotal.toLocaleString();
  const grand = grandTotal.toLocaleString();
  countEl.textContent = `${filtered} of ${grand}`;
}

const scroller = new VirtualScroller({
  scroller: scrollerEl,
  rowsEl,
  spacerEl,
  onCount: renderCount,
});

function currentFilter() {
  return {
    severity: severityEl.value,
    q: searchEl.value.trim(),
  };
}

function applyFilter() {
  scroller.setFilter(currentFilter());
}

// Debounced search: never blocks the input; the scroller cancels stale
// in-flight requests internally via its filter token + AbortControllers.
let debounceTimer = null;
function onSearchInput() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    applyFilter();
  }, 200);
}

severityEl.addEventListener('change', applyFilter);
searchEl.addEventListener('input', onSearchInput);

async function init() {
  try {
    const stats = await fetchStats();
    grandTotal = stats.total;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('stats failed', err);
  }
  await applyFilter();
}

init();
