const API_BASE = 'http://localhost:3001/api';

let currentFilters = { severity: '', q: '' };
let currentTotal = 0;
let currentOffset = 0;
let rowHeight = 37; // approximate row height
let visibleRows = 20;
let overscan = 5;
let isLoading = false;
let lastRequestTime = 0;

const scroller = document.getElementById('virtual-scroller');
const spacer = document.getElementById('scroll-spacer');
const tbody = document.getElementById('log-tbody');
const severityFilter = document.getElementById('severity-filter');
const searchInput = document.getElementById('search-input');
const rowCountEl = document.getElementById('row-count');

let debounceTimer = null;
let activeRequestController = null;

function updateRowCount() {
  rowCountEl.textContent = `${tbody.children.length} of ${currentTotal.toLocaleString()}`;
}

function getSeverityColor(severity) {
  return `<span class="severity ${severity}">${severity}</span>`;
}

function formatTimestamp(ts) {
  return new Date(ts).toLocaleString();
}

function renderRows(rows, startOffset) {
  tbody.innerHTML = '';
  
  rows.forEach((row, index) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="timestamp">${formatTimestamp(row.ts)}</td>
      <td>${getSeverityColor(row.severity)}</td>
      <td class="service">${row.service}</td>
      <td title="${row.message}">${row.message}</td>
    `;
    tr.dataset.offset = startOffset + index;
    tbody.appendChild(tr);
  });
  
  updateRowCount();
}

async function fetchLogs(offset, limit = 100, filters = {}) {
  const params = new URLSearchParams({
    offset: offset.toString(),
    limit: limit.toString()
  });
  
  if (filters.severity) params.append('severity', filters.severity);
  if (filters.q) params.append('q', filters.q);

  // Cancel previous request
  if (activeRequestController) {
    activeRequestController.abort();
  }
  activeRequestController = new AbortController();

  const requestTime = Date.now();
  lastRequestTime = requestTime;

  try {
    const response = await fetch(`${API_BASE}/logs?${params}`, {
      signal: activeRequestController.signal
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Request failed');
    }
    
    const data = await response.json();
    
    // Ignore stale responses
    if (requestTime < lastRequestTime) {
      return null;
    }
    
    return data;
  } catch (error) {
    if (error.name === 'AbortError') {
      return null;
    }
    console.error('Fetch error:', error);
    return null;
  }
}

async function fetchStats() {
  try {
    const response = await fetch(`${API_BASE}/stats`);
    return await response.json();
  } catch (e) {
    return { total: 0, perSeverity: {} };
  }
}

async function loadWindow(offset, filters) {
  if (isLoading) return;
  isLoading = true;
  
  const limit = visibleRows + overscan * 2;
  const adjustedOffset = Math.max(0, offset - overscan);
  
  const data = await fetchLogs(adjustedOffset, limit, filters);
  
  if (data && data.rows) {
    currentTotal = data.total;
    currentOffset = adjustedOffset;
    
    // Update spacer height
    const totalHeight = currentTotal * rowHeight;
    spacer.style.height = `${totalHeight}px`;
    
    renderRows(data.rows, adjustedOffset);
  }
  
  isLoading = false;
}

function onScroll() {
  const scrollTop = scroller.scrollTop;
  const estimatedOffset = Math.floor(scrollTop / rowHeight);
  
  // Load if we're outside current window
  const windowStart = currentOffset;
  const windowEnd = currentOffset + tbody.children.length;
  
  if (estimatedOffset < windowStart || estimatedOffset > windowEnd - visibleRows) {
    loadWindow(estimatedOffset, currentFilters);
  }
}

function resetScrollAndLoad() {
  scroller.scrollTop = 0;
  currentOffset = 0;
  loadWindow(0, currentFilters);
}

function setupFilters() {
  severityFilter.addEventListener('change', () => {
    currentFilters.severity = severityFilter.value;
    resetScrollAndLoad();
  });

  searchInput.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      currentFilters.q = searchInput.value.trim();
      resetScrollAndLoad();
    }, 300);
  });

  // Prevent scroll blocking
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      clearTimeout(debounceTimer);
      currentFilters.q = searchInput.value.trim();
      resetScrollAndLoad();
    }
  });
}

function setupVirtualization() {
  // Estimate visible rows based on container height
  const resizeObserver = new ResizeObserver(() => {
    const height = scroller.clientHeight;
    visibleRows = Math.ceil(height / rowHeight) + 2;
  });
  resizeObserver.observe(scroller);

  scroller.addEventListener('scroll', () => {
    // Throttle scroll handler
    if (!scroller.scrolling) {
      scroller.scrolling = true;
      requestAnimationFrame(() => {
        onScroll();
        scroller.scrolling = false;
      });
    }
  });

  // Initial load
  setTimeout(() => {
    const height = scroller.clientHeight || 600;
    visibleRows = Math.ceil(height / rowHeight) + 2;
    loadWindow(0, currentFilters);
  }, 100);
}

async function init() {
  setupFilters();
  setupVirtualization();
  
  // Initial stats check (optional)
  const stats = await fetchStats();
  console.log('Initial stats:', stats);
  
  // Make sure first load happens
  setTimeout(() => {
    if (currentTotal === 0) {
      loadWindow(0, currentFilters);
    }
  }, 500);
}

init();