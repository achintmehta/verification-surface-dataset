import { fetchStats } from './api.js';
import { VirtualScroller } from './virtual-scroller.js';

// DOM elements
const severityFilter = document.getElementById('severity-filter');
const searchInput = document.getElementById('search-input');
const rowCountEl = document.getElementById('row-count');
const loadingEl = document.getElementById('loading-indicator');
const badgesEl = document.getElementById('severity-badges');
const scrollerEl = document.getElementById('virtual-scroller');
const spacerEl = document.getElementById('scroll-spacer');
const containerEl = document.getElementById('row-container');

let totalCorpusSize = 0;

// Virtual scroller
const scroller = new VirtualScroller({
  scrollerEl,
  spacerEl,
  containerEl,
  onTotalChange: (filteredTotal) => {
    updateRowCount(filteredTotal);
  }
});

function updateRowCount(filteredTotal) {
  if (filteredTotal === totalCorpusSize) {
    rowCountEl.textContent = `${filteredTotal.toLocaleString()} logs`;
  } else {
    rowCountEl.textContent = `${filteredTotal.toLocaleString()} of ${totalCorpusSize.toLocaleString()} logs`;
  }
}

// Debounce helper
function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

// Filter change handlers
severityFilter.addEventListener('change', () => {
  scroller.setFilters({ severity: severityFilter.value });
});

const debouncedSearch = debounce((value) => {
  scroller.setFilters({ q: value });
}, 250);

searchInput.addEventListener('input', (e) => {
  // Input is never blocked: debounce only delays the network request
  debouncedSearch(e.target.value);
});

// Load stats for badges
async function loadStats() {
  try {
    const stats = await fetchStats();
    totalCorpusSize = stats.total;
    badgesEl.innerHTML = '';
    for (const sev of ['debug', 'info', 'warn', 'error']) {
      const count = stats.severities[sev] || 0;
      const badge = document.createElement('span');
      badge.className = `badge badge-${sev}`;
      badge.textContent = `${sev}: ${count.toLocaleString()}`;
      badgesEl.appendChild(badge);
    }
  } catch (err) {
    console.error('Failed to load stats:', err);
  }
}

// Initial load
async function init() {
  await loadStats();
  await scroller.setFilters({ severity: '', q: '' });
}

init();
