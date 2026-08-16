const API_BASE = ''; // uses proxy in dev

let currentFilters = { severity: '', q: '' };
let currentTotal = 0;
let rowHeight = 32;
let visibleRows = 20; // approx
let overscan = 5;
let isLoading = false;
let lastRequestId = 0;

const scroller = document.getElementById('virtual-scroller');
const content = document.getElementById('virtual-content');
const visibleContainer = document.getElementById('visible-rows');
const rowCountEl = document.getElementById('row-count');
const severitySelect = document.getElementById('severity-filter');
const searchInput = document.getElementById('search-input');

let debounceTimer = null;
let loadedRows = new Map(); // offset -> rows for current filter, but we fetch on demand

function updateRowCount(displayed) {
  rowCountEl.textContent = `${displayed} of ${currentTotal.toLocaleString()}`;
}

async function fetchLogs(offset, limit, filters) {
  const params = new URLSearchParams({
    offset: offset.toString(),
    limit: limit.toString()
  });
  if (filters.severity) params.set('severity', filters.severity);
  if (filters.q) params.set('q', filters.q);

  const requestId = ++lastRequestId;
  const res = await fetch(`${API_BASE}/api/logs?${params}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to fetch');
  }
  const data = await res.json();
  if (requestId !== lastRequestId) {
    return null; // stale
  }
  return data;
}

async function fetchStats() {
  const res = await fetch(`${API_BASE}/api/stats`);
  return res.json();
}

function renderRows(rows, startOffset) {
  visibleContainer.innerHTML = '';
  rows.forEach((row, i) => {
    const el = document.createElement('div');
    el.className = 'row';
    el.style.height = `${rowHeight}px`;
    el.innerHTML = `
      <div class="col ts">${new Date(row.ts).toISOString().replace('T', ' ').slice(0,19)}</div>
      <div class="col severity severity-${row.severity}">${row.severity}</div>
      <div class="col service">${row.service}</div>
      <div class="col message" title="${row.message}">${row.message}</div>
    `;
    visibleContainer.appendChild(el);
  });
}

function positionVisibleRows(startIndex) {
  const top = startIndex * rowHeight;
  visibleContainer.style.transform = `translateY(${top}px)`;
}

async function loadAndRenderWindow(startIndex, count) {
  if (isLoading) return;
  isLoading = true;

  try {
    const data = await fetchLogs(startIndex, count + overscan * 2, currentFilters);
    if (!data) {
      isLoading = false;
      return; // stale
    }

    currentTotal = data.total;
    updateRowCount(data.rows.length); // approx visible

    // Set content height
    content.style.height = `${currentTotal * rowHeight}px`;

    renderRows(data.rows, startIndex);
    positionVisibleRows(startIndex);
  } catch (e) {
    console.error(e);
  } finally {
    isLoading = false;
  }
}

function getVisibleRange() {
  const scrollTop = scroller.scrollTop;
  const viewportHeight = scroller.clientHeight;
  const startIndex = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const endIndex = Math.min(currentTotal, Math.ceil((scrollTop + viewportHeight) / rowHeight) + overscan);
  return { startIndex, count: endIndex - startIndex };
}

let scrollHandler = null;

function setupVirtualization() {
  scroller.addEventListener('scroll', () => {
    if (scrollHandler) clearTimeout(scrollHandler);
    scrollHandler = setTimeout(() => {
      const { startIndex, count } = getVisibleRange();
      if (count > 0 && currentTotal > 0) {
        loadAndRenderWindow(startIndex, count);
      }
    }, 16); // ~60fps throttle-ish
  });

  // Initial load
  setTimeout(() => {
    const { startIndex, count } = getVisibleRange();
    loadAndRenderWindow(0, Math.max(count, 50));
  }, 100);
}

function applyFilters() {
  currentFilters = {
    severity: severitySelect.value,
    q: searchInput.value.trim()
  };
  // Reset scroll and content
  scroller.scrollTop = 0;
  content.style.height = '0px';
  visibleContainer.innerHTML = '';
  visibleContainer.style.transform = 'translateY(0)';
  currentTotal = 0;
  updateRowCount(0);

  // Load initial window
  setTimeout(() => {
    loadAndRenderWindow(0, 50);
  }, 10);
}

function setupFilters() {
  severitySelect.addEventListener('change', () => {
    applyFilters();
  });

  searchInput.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      applyFilters();
    }, 300);
  });
}

async function init() {
  setupFilters();
  setupVirtualization();

  // Initial stats not strictly needed but could show badges, omitted for simplicity
  // Load initial data
  setTimeout(() => {
    loadAndRenderWindow(0, 50);
  }, 50);
}

init();