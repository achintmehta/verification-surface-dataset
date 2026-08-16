import { VirtualList } from './virtual-list.js';
import { fetchStats } from './api.js';

const $ = (id) => document.getElementById(id);

const severityEl = $('severity');
const searchEl = $('search');
const countEl = $('count');
const statusEl = $('status');

let corpusTotal = 0;

function updateCount(filteredTotal) {
  const fmt = (n) => n.toLocaleString('en-US');
  countEl.textContent = `${fmt(filteredTotal)} of ${fmt(corpusTotal)}`;
}

const list = new VirtualList({
  viewport: $('viewport'),
  spacer: $('spacer'),
  rows: $('rows'),
  onCount: updateCount,
});

// --- Debounced search -------------------------------------------------------
// The input never blocks on network. Keystrokes update the field immediately;
// the query is applied after a short debounce and prior in-flight queries are
// superseded by the VirtualList's request sequencing.
let debounceTimer = null;
const DEBOUNCE_MS = 200;

function scheduleFilterUpdate() {
  statusEl.textContent = 'typing…';
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(applyFilter, DEBOUNCE_MS);
}

async function applyFilter() {
  statusEl.textContent = 'loading…';
  const severity = severityEl.value;
  const q = searchEl.value.trim();
  try {
    await list.setFilter({ severity, q });
    statusEl.textContent = '';
  } catch (err) {
    statusEl.textContent = 'error';
    console.error(err);
  }
}

searchEl.addEventListener('input', scheduleFilterUpdate);
severityEl.addEventListener('change', () => {
  // Severity change is applied immediately (no need to debounce a dropdown).
  if (debounceTimer) clearTimeout(debounceTimer);
  applyFilter();
});

// --- Boot -------------------------------------------------------------------
async function boot() {
  try {
    const stats = await fetchStats();
    corpusTotal = stats.total;
  } catch (err) {
    console.error('stats fetch failed', err);
  }
  await list.setFilter({ severity: '', q: '' });
}

boot();
