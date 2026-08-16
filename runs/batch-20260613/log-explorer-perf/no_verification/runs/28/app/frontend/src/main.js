const API_BASE = '/api';
const ROW_HEIGHT = 32;
const VISIBLE_ROWS = 20; // approx for 600px height
const OVERSCAN = 5;

let currentFilter = { severity: '', q: '' };
let currentTotal = 0;
let currentOffset = 0;
let isLoading = false;
let lastRequestTime = 0;
let debounceTimer = null;

const container = document.getElementById('virtual-container');
const scroller = document.getElementById('virtual-scroller');
const severitySelect = document.getElementById('severity-filter');
const searchInput = document.getElementById('search-input');
const rowCountEl = document.getElementById('row-count');
const statsEl = document.getElementById('stats');

let renderedRows = new Map(); // offset -> element

async function fetchLogs(offset, limit, severity, q) {
  const params = new URLSearchParams({ offset, limit });
  if (severity) params.append('severity', severity);
  if (q) params.append('q', q);
  
  const res = await fetch(`${API_BASE}/logs?${params}`);
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || 'Request failed');
  }
  return res.json();
}

async function fetchStats() {
  const res = await fetch(`${API_BASE}/stats`);
  return res.json();
}

function updateRowCount() {
  rowCountEl.textContent = `${currentTotal.toLocaleString()} rows`;
}

function updateStats(stats) {
  const { total, perSeverity } = stats;
  statsEl.innerHTML = `
    Total: <strong>${total.toLocaleString()}</strong> | 
    Debug: ${perSeverity.debug} | Info: ${perSeverity.info} | 
    Warn: ${perSeverity.warn} | Error: ${perSeverity.error}
  `;
}

function createRowElement(row, top) {
  const el = document.createElement('div');
  el.className = `log-row ${row.severity}`;
  el.style.top = `${top}px`;
  el.innerHTML = `
    <div class="col-ts">${new Date(row.ts).toISOString().replace('T', ' ').slice(0, 19)}</div>
    <div class="col-sev">${row.severity.toUpperCase()}</div>
    <div class="col-svc">${row.service}</div>
    <div class="col-msg" title="${row.message}">${row.message}</div>
  `;
  return el;
}

function renderWindow(rows, startOffset) {
  // Clear previous
  scroller.innerHTML = '';
  renderedRows.clear();
  
  const fragment = document.createDocumentFragment();
  
  rows.forEach((row, i) => {
    const offset = startOffset + i;
    const top = offset * ROW_HEIGHT;
    const el = createRowElement(row, top);
    fragment.appendChild(el);
    renderedRows.set(offset, el);
  });
  
  scroller.style.height = `${currentTotal * ROW_HEIGHT}px`;
  scroller.appendChild(fragment);
}

async function loadWindow(offset, force = false) {
  if (isLoading && !force) return;
  isLoading = true;
  
  try {
    const limit = 50; // fetch a bit more for smooth scroll
    const data = await fetchLogs(offset, limit, currentFilter.severity, currentFilter.q);
    
    // Update total if changed
    if (data.total !== currentTotal) {
      currentTotal = data.total;
      updateRowCount();
      scroller.style.height = `${currentTotal * ROW_HEIGHT}px`;
    }
    
    renderWindow(data.rows, offset);
    currentOffset = offset;
  } catch (e) {
    console.error('Load failed:', e);
  } finally {
    isLoading = false;
  }
}

function handleScroll() {
  const scrollTop = container.scrollTop;
  const newOffset = Math.floor(scrollTop / ROW_HEIGHT);
  
  // Load if we scrolled beyond current window significantly
  const windowStart = currentOffset;
  const windowEnd = currentOffset + 50;
  
  if (newOffset < windowStart - OVERSCAN || newOffset > windowEnd - 10) {
    // Debounce load a bit for scroll perf
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      loadWindow(Math.max(0, newOffset - OVERSCAN));
    }, 50);
  }
}

function resetAndLoad() {
  currentOffset = 0;
  container.scrollTop = 0;
  scroller.style.height = `${currentTotal * ROW_HEIGHT}px`;
  loadWindow(0, true);
}

async function initFilters() {
  // Severity filter
  severitySelect.addEventListener('change', () => {
    currentFilter.severity = severitySelect.value;
    resetAndLoad();
  });
  
  // Debounced search
  searchInput.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      currentFilter.q = searchInput.value.trim();
      resetAndLoad();
    }, 300);
  });
  
  // Initial stats
  try {
    const stats = await fetchStats();
    updateStats(stats);
    currentTotal = stats.total;
    updateRowCount();
    scroller.style.height = `${currentTotal * ROW_HEIGHT}px`;
  } catch (e) {
    console.error(e);
  }
  
  // Initial load
  await loadWindow(0);
  
  // Scroll listener
  container.addEventListener('scroll', handleScroll);
  
  // Keyboard support etc, but basic ok
  console.log('Log explorer initialized');
}

initFilters();