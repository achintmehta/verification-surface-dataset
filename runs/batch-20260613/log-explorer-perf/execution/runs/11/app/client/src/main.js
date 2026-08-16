import { VirtualTable } from './virtual-table.js';
import { fetchStats } from './api.js';

const els = {
  severity: document.getElementById('severity'),
  search: document.getElementById('search'),
  count: document.getElementById('count'),
  status: document.getElementById('status'),
  viewport: document.getElementById('viewport'),
  spacer: document.getElementById('spacer'),
  rows: document.getElementById('rows'),
};

let grandTotal = 0;

function fmtNum(n) {
  return n.toLocaleString('en-US');
}

const table = new VirtualTable({
  viewport: els.viewport,
  spacer: els.spacer,
  rowsEl: els.rows,
  onCount(total) {
    els.count.textContent = `${fmtNum(total)} of ${fmtNum(grandTotal)}`;
  },
  onStatus(cls, text) {
    els.status.className = `status ${cls}`.trim();
    els.status.textContent = text;
  },
});

// ---- Filter wiring -----------------------------------------------------------

function currentFilters() {
  return { severity: els.severity.value, q: els.search.value.trim() };
}

function applyFilters() {
  // Never blocks the input; setFilters runs async and guards stale responses.
  table.setFilters(currentFilters());
}

els.severity.addEventListener('change', applyFilters);

// Debounced search: fires 200ms after the last keystroke. The input event
// itself does no work beyond scheduling, so typing stays responsive.
let debounceTimer = null;
els.search.addEventListener('input', () => {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(applyFilters, 200);
});

// ---- Boot --------------------------------------------------------------------

async function boot() {
  try {
    const stats = await fetchStats();
    grandTotal = stats.total;
  } catch (err) {
    console.error('stats load failed', err);
  }
  await table.setFilters(currentFilters());
}

boot();
