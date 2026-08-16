import { VirtualTable } from './virtual-table.js';
import { fetchStats } from './api.js';

const viewport = document.getElementById('viewport');
const spacer = document.getElementById('spacer');
const rowsEl = document.getElementById('rows');
const emptyEl = document.getElementById('empty');
const severityEl = document.getElementById('severity');
const searchEl = document.getElementById('search');
const countEl = document.getElementById('count');

let grandTotal = null;

const table = new VirtualTable({
  viewport,
  spacer,
  rowsEl,
  emptyEl,
  onCount(total) {
    const suffix = grandTotal != null ? ` of ${grandTotal.toLocaleString()}` : '';
    countEl.textContent = `${total.toLocaleString()}${suffix}`;
  },
});

function currentFilter() {
  return {
    severity: severityEl.value || null,
    q: searchEl.value.trim() || null,
  };
}

async function applyFilter() {
  try {
    await table.setFilter(currentFilter());
  } catch (err) {
    console.error('filter apply failed', err);
  }
}

// Debounced search: input never blocks; fires 200ms after last keystroke.
let debounceTimer = null;
searchEl.addEventListener('input', () => {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(applyFilter, 200);
});

severityEl.addEventListener('change', applyFilter);

async function boot() {
  // Wait for the server to finish seeding.
  for (;;) {
    try {
      const stats = await fetchStats();
      grandTotal = stats.total;
      break;
    } catch {
      countEl.textContent = 'seeding…';
      await new Promise((r) => setTimeout(r, 750));
    }
  }
  await applyFilter();
}

boot();
