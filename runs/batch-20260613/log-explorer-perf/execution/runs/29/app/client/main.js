const API_BASE = 'http://localhost:3001/api';

let currentFilters = { severity: '', q: '' };
let currentTotal = 0;
let rowHeight = 36;
let overscan = 10;
let visibleRows = 16; // approx for 600px height
let isLoading = false;
let lastRequestId = 0;

const scroller = document.getElementById('scroller');
const spacer = document.getElementById('spacer');
const tbody = document.getElementById('table-body');
const rowCountEl = document.getElementById('row-count');
const statsEl = document.getElementById('stats');
const severitySelect = document.getElementById('severity-filter');
const searchInput = document.getElementById('search-input');

let rowsData = []; // currently rendered rows
let currentOffset = 0;

async function fetchLogs(offset, limit, filters) {
  const params = new URLSearchParams({
    offset: offset.toString(),
    limit: limit.toString(),
    ...(filters.severity && { severity: filters.severity }),
    ...(filters.q && { q: filters.q })
  });
  
  const res = await fetch(`${API_BASE}/logs?${params}`);
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || 'Request failed');
  }
  return res.json();
}

async function fetchStats() {
  const res = await fetch(`${API_BASE}/stats`);
  if (!res.ok) throw new Error('Stats failed');
  return res.json();
}

function updateRowCount() {
  rowCountEl.textContent = `${rowsData.length} of ${currentTotal.toLocaleString()}`;
}

function updateStats(stats) {
  statsEl.innerHTML = `
    Total: <strong>${stats.total.toLocaleString()}</strong> &nbsp;|&nbsp; 
    Debug: ${stats.perSeverity.debug} &nbsp; 
    Info: ${stats.perSeverity.info} &nbsp; 
    Warn: ${stats.perSeverity.warn} &nbsp; 
    Error: ${stats.perSeverity.error}
  `;
}

function renderRows(rows, startOffset) {
  tbody.innerHTML = '';
  rowsData = rows;
  
  rows.forEach((row, i) => {
    const tr = document.createElement('tr');
    tr.className = 'row';
    tr.style.height = `${rowHeight}px`;
    tr.innerHTML = `
      <td>${new Date(row.ts).toLocaleString()}</td>
      <td class="severity-${row.severity}">${row.severity}</td>
      <td>${row.service}</td>
      <td title="${row.message}">${row.message}</td>
    `;
    tbody.appendChild(tr);
  });
  
  updateRowCount();
}

function updateSpacerHeight(total) {
  const totalHeight = total * rowHeight;
  spacer.style.height = `${totalHeight}px`;
}

async function loadWindow(offset, filters, force = false) {
  if (isLoading && !force) return;
  isLoading = true;
  
  const requestId = ++lastRequestId;
  const limit = visibleRows + overscan * 2;
  
  try {
    const { total, rows } = await fetchLogs(offset, limit, filters);
    
    if (requestId !== lastRequestId) {
      // stale response
      return;
    }
    
    currentTotal = total;
    currentOffset = offset;
    updateSpacerHeight(total);
    
    // Position the table body absolutely? For simple virtualization, we use padding or transform
    // Simple approach: set tbody offset via spacer sibling or margin
    const topPadding = offset * rowHeight;
    tbody.style.position = 'absolute';
    tbody.style.top = `${topPadding}px`;
    tbody.style.width = '100%';
    
    renderRows(rows, offset);
    
    // Adjust scroller scroll if needed? No, user controls scroll
  } catch (e) {
    console.error(e);
    if (requestId === lastRequestId) {
      tbody.innerHTML = `<tr><td colspan="4">Error loading data: ${e.message}</td></tr>`;
    }
  } finally {
    if (requestId === lastRequestId) isLoading = false;
  }
}

function getVisibleOffset() {
  const scrollTop = scroller.scrollTop;
  return Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
}

let scrollTimeout;
scroller.addEventListener('scroll', () => {
  clearTimeout(scrollTimeout);
  scrollTimeout = setTimeout(() => {
    const newOffset = getVisibleOffset();
    if (Math.abs(newOffset - currentOffset) > overscan / 2) {
      loadWindow(newOffset, currentFilters);
    }
  }, 50);
});

function debounce(fn, delay) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), delay);
  };
}

async function applyFilters() {
  currentFilters = {
    severity: severitySelect.value,
    q: searchInput.value.trim()
  };
  
  // Reset scroll to top
  scroller.scrollTop = 0;
  tbody.style.top = '0px';
  
  await loadWindow(0, currentFilters, true);
  
  // Also refresh stats? Stats are unfiltered total, but ok to keep or fetch filtered? Task says for filter bar badges, so perhaps always total.
  // But for now, stats are global.
}

severitySelect.addEventListener('change', applyFilters);
searchInput.addEventListener('input', debounce(applyFilters, 300));

async function init() {
  // Initial load
  try {
    const stats = await fetchStats();
    updateStats(stats);
    
    await loadWindow(0, currentFilters, true);
    
    // Set initial spacer
    updateSpacerHeight(currentTotal);
  } catch (e) {
    console.error('Init failed', e);
    statsEl.textContent = 'Failed to connect to server. Is it running?';
  }
  
  // Make table positioned relative for absolute tbody
  const table = tbody.parentElement;
  table.style.position = 'relative';
}

init();