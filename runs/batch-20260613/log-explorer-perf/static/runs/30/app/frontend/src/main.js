const API_BASE = '/api';
const ROW_HEIGHT = 32;
const OVERSCAN = 5;
const PAGE_SIZE = 100;

let state = {
  total: 0,
  offset: 0,
  rows: [],
  filters: { severity: '', q: '' },
  loading: false,
  lastRequestId: 0,
  stats: { total: 0, perSeverity: {} }
};

let scroller, content, severityFilter, searchInput, rowCountEl, statsEl;

function formatTimestamp(ts) {
  const d = new Date(ts);
  return d.toISOString().replace('T', ' ').substring(0, 19);
}

function createRowElement(row) {
  const div = document.createElement('div');
  div.className = 'log-row';
  div.style.height = `${ROW_HEIGHT}px`;
  div.innerHTML = `
    <div class="log-ts">${formatTimestamp(row.ts)}</div>
    <div class="log-severity severity-${row.severity}">${row.severity}</div>
    <div class="log-service">${row.service}</div>
    <div class="log-message">${escapeHtml(row.message)}</div>
  `;
  return div;
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (m) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}

async function fetchLogs(offset, limit, filters, requestId) {
  const params = new URLSearchParams({
    offset: offset.toString(),
    limit: limit.toString()
  });
  if (filters.severity) params.set('severity', filters.severity);
  if (filters.q) params.set('q', filters.q);

  const res = await fetch(`${API_BASE}/logs?${params}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to fetch logs');
  }
  const data = await res.json();
  return { data, requestId };
}

async function fetchStats() {
  const res = await fetch(`${API_BASE}/stats`);
  if (!res.ok) throw new Error('Failed to fetch stats');
  return res.json();
}

function updateRowCount() {
  rowCountEl.textContent = `${state.rows.length} of ${state.total.toLocaleString()}`;
}

function updateStats() {
  statsEl.innerHTML = `
    <div class="stat-badge">Total: ${state.stats.total.toLocaleString()}</div>
    <div class="stat-badge">Debug: ${state.stats.perSeverity.debug || 0}</div>
    <div class="stat-badge">Info: ${state.stats.perSeverity.info || 0}</div>
    <div class="stat-badge">Warn: ${state.stats.perSeverity.warn || 0}</div>
    <div class="stat-badge">Error: ${state.stats.perSeverity.error || 0}</div>
  `;
}

function renderVisibleRows() {
  if (!content) return;

  const scrollTop = scroller.scrollTop;
  const viewportHeight = scroller.clientHeight;
  
  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const endIndex = Math.min(state.total, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN);

  // Clear existing
  content.innerHTML = '';
  content.style.height = `${state.total * ROW_HEIGHT}px`;
  content.style.position = 'relative';

  // Render only visible + overscan
  for (let i = startIndex; i < endIndex; i++) {
    const rowIndex = i - state.offset;
    if (rowIndex >= 0 && rowIndex < state.rows.length) {
      const rowEl = createRowElement(state.rows[rowIndex]);
      rowEl.style.position = 'absolute';
      rowEl.style.top = `${i * ROW_HEIGHT}px`;
      rowEl.style.left = '0';
      rowEl.style.right = '0';
      content.appendChild(rowEl);
    }
  }
}

function debounce(fn, delay) {
  let timeout;
  return (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn(...args), delay);
  };
}

async function loadWindow(newOffset, filtersChanged = false) {
  if (state.loading) return;

  const requestId = ++state.lastRequestId;
  state.loading = true;

  try {
    // Fetch a window around the offset
    const fetchOffset = Math.max(0, newOffset - 20);
    const { data } = await fetchLogs(fetchOffset, PAGE_SIZE + 40, state.filters, requestId);

    if (requestId !== state.lastRequestId) {
      // Stale response, ignore
      return;
    }

    state.total = data.total;
    state.offset = fetchOffset;
    state.rows = data.rows;

    // Update content height
    if (content) {
      content.style.height = `${state.total * ROW_HEIGHT}px`;
    }

    updateRowCount();
    renderVisibleRows();
  } catch (err) {
    console.error(err);
    if (content) content.innerHTML = `<div class="loading">Error: ${err.message}</div>`;
  } finally {
    state.loading = false;
  }
}

function onScroll() {
  const scrollTop = scroller.scrollTop;
  const currentRowOffset = Math.floor(scrollTop / ROW_HEIGHT);

  // Check if we need to fetch new window
  const relativeOffset = currentRowOffset - state.offset;
  const needsRefetch = relativeOffset < 10 || relativeOffset > state.rows.length - 30;

  if (needsRefetch && !state.loading && state.total > 0) {
    const targetOffset = Math.max(0, currentRowOffset - 30);
    loadWindow(targetOffset);
  } else {
    renderVisibleRows();
  }
}

function resetAndLoad() {
  state.offset = 0;
  state.rows = [];
  state.total = 0;
  if (content) {
    content.innerHTML = '';
    content.style.height = '0px';
  }
  scroller.scrollTop = 0;
  loadWindow(0, true);
}

async function init() {
  scroller = document.getElementById('scroller');
  content = document.getElementById('virtual-content');
  severityFilter = document.getElementById('severity-filter');
  searchInput = document.getElementById('search-input');
  rowCountEl = document.getElementById('row-count');
  statsEl = document.getElementById('stats');

  // Initial stats
  try {
    state.stats = await fetchStats();
    updateStats();
  } catch (e) {
    console.error(e);
  }

  // Initial load
  await loadWindow(0);

  // Event listeners
  severityFilter.addEventListener('change', () => {
    state.filters.severity = severityFilter.value;
    resetAndLoad();
  });

  const debouncedSearch = debounce(() => {
    state.filters.q = searchInput.value.trim();
    resetAndLoad();
  }, 300);

  searchInput.addEventListener('input', debouncedSearch);

  // Scroll handler with throttling
  let scrollTimeout;
  scroller.addEventListener('scroll', () => {
    clearTimeout(scrollTimeout);
    scrollTimeout = setTimeout(onScroll, 16);
  });

  // Initial render
  setTimeout(() => {
    renderVisibleRows();
  }, 100);

  // Poll stats occasionally? No need, static.
  console.log('Log Explorer initialized');
}

init();