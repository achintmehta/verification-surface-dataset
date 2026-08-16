const API_BASE = '/api';

let currentFilter = { severity: '', q: '' };
let currentTotal = 0;
let isLoading = false;
let lastRequestId = 0;
let debounceTimer = null;

const ROW_HEIGHT = 42; // approximate row height
const OVERSCAN = 5;
const VISIBLE_ROWS = 15; // approx visible in 600px

const tableEl = document.getElementById('virtual-table');
const scrollerEl = document.getElementById('virtual-scroller');
const severityFilter = document.getElementById('severity-filter');
const searchInput = document.getElementById('search-input');
const rowCountEl = document.getElementById('row-count');

let renderedRows = new Map(); // offset -> element
let currentOffset = 0;
let scrollRAF = null;

async function fetchLogs(offset, limit, severity, q) {
  const params = new URLSearchParams();
  params.set('offset', offset);
  params.set('limit', limit);
  if (severity) params.set('severity', severity);
  if (q) params.set('q', q);
  
  const res = await fetch(`${API_BASE}/logs?${params}`);
  if (!res.ok) {
    if (res.status === 503) {
      // retry after delay
      await new Promise(r => setTimeout(r, 2000));
      return fetchLogs(offset, limit, severity, q);
    }
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to fetch');
  }
  return res.json();
}

async function fetchStats() {
  const res = await fetch(`${API_BASE}/stats`);
  if (res.status === 503) {
    await new Promise(r => setTimeout(r, 2000));
    return fetchStats();
  }
  return res.json();
}

function updateRowCount(filteredTotal) {
  rowCountEl.textContent = `${filteredTotal.toLocaleString()} of ${currentTotal.toLocaleString()}`;
}

function createRowElement(log, index) {
  const row = document.createElement('div');
  row.className = 'log-row';
  row.style.position = 'absolute';
  row.style.top = `${index * ROW_HEIGHT}px`;
  row.style.width = '100%';
  row.style.height = `${ROW_HEIGHT}px`;
  
  const ts = new Date(log.ts).toISOString().replace('T', ' ').slice(0, 19);
  
  row.innerHTML = `
    <div class="log-ts">${ts}</div>
    <div class="log-severity severity-${log.severity}">${log.severity}</div>
    <div class="log-service">${log.service}</div>
    <div class="log-message">${escapeHtml(log.message)}</div>
  `;
  
  return row;
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (m) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

async function loadWindow(startOffset, force = false) {
  if (isLoading && !force) return;
  
  const requestId = ++lastRequestId;
  isLoading = true;
  
  try {
    const limit = 100; // fetch a good window
    const data = await fetchLogs(startOffset, limit, currentFilter.severity, currentFilter.q);
    
    if (requestId !== lastRequestId) {
      // stale response, ignore
      return;
    }
    
    currentTotal = data.total;
    updateRowCount(data.total);
    
    // Clear existing rows
    scrollerEl.innerHTML = '';
    renderedRows.clear();
    
    // Set scroller height
    scrollerEl.style.height = `${Math.max(data.total * ROW_HEIGHT, 600)}px`;
    
    // Render the fetched rows
    data.rows.forEach((log, i) => {
      const rowEl = createRowElement(log, startOffset + i);
      scrollerEl.appendChild(rowEl);
      renderedRows.set(startOffset + i, rowEl);
    });
    
    currentOffset = startOffset;
  } catch (err) {
    console.error('Load error:', err);
    scrollerEl.innerHTML = `<div class="empty">Error loading logs: ${err.message}</div>`;
  } finally {
    isLoading = false;
  }
}

function handleScroll() {
  if (scrollRAF) cancelAnimationFrame(scrollRAF);
  
  scrollRAF = requestAnimationFrame(() => {
    const scrollTop = tableEl.scrollTop;
    const newOffset = Math.floor(scrollTop / ROW_HEIGHT);
    
    // Only reload if we've scrolled significantly
    const threshold = 20;
    if (Math.abs(newOffset - currentOffset) > threshold || renderedRows.size === 0) {
      const targetOffset = Math.max(0, newOffset - OVERSCAN);
      loadWindow(targetOffset);
    }
  });
}

function resetAndLoad() {
  currentOffset = 0;
  tableEl.scrollTop = 0;
  scrollerEl.style.height = '0px';
  loadWindow(0);
}

function setupFilters() {
  severityFilter.addEventListener('change', () => {
    currentFilter.severity = severityFilter.value;
    resetAndLoad();
  });
  
  searchInput.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      currentFilter.q = searchInput.value.trim();
      resetAndLoad();
    }, 300);
  });
  
  // Prevent scroll blocking
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      clearTimeout(debounceTimer);
      currentFilter.q = searchInput.value.trim();
      resetAndLoad();
    }
  });
}

function setupVirtualScroll() {
  tableEl.addEventListener('scroll', handleScroll, { passive: true });
  
  // Initial load
  setTimeout(() => {
    loadWindow(0);
  }, 100);
  
  // Keyboard support for scrolling
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Home') {
      tableEl.scrollTop = 0;
      e.preventDefault();
    } else if (e.key === 'End') {
      tableEl.scrollTop = scrollerEl.scrollHeight;
      e.preventDefault();
    }
  });
}

async function init() {
  // Try to get initial stats for total
  try {
    const stats = await fetchStats();
    currentTotal = stats.total;
    updateRowCount(stats.total);
  } catch (e) {
    console.warn('Could not fetch initial stats');
  }
  
  setupFilters();
  setupVirtualScroll();
  
  // Load initial data
  console.log('Log Explorer initialized');
}

init();