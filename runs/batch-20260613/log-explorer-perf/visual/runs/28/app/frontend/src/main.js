import './style.css';

const API_BASE = '/api';
const ROW_HEIGHT = 36;
const OVERSCAN = 8;
const VISIBLE_ROWS = 17; // approx for 600px height

let currentFilter = { severity: '', q: '' };
let currentTotal = 0;
let currentOffset = 0;
let isLoading = false;
let abortController = null;
let lastFetchTime = 0;

const app = document.getElementById('app');

function createUI() {
  app.innerHTML = `
    <div class="header">
      <h1 style="margin:0; font-size:24px;">Log Explorer</h1>
      <div class="filters">
        <select id="severity-filter">
          <option value="">All Severities</option>
          <option value="debug">Debug</option>
          <option value="info">Info</option>
          <option value="warn">Warn</option>
          <option value="error">Error</option>
        </select>
        <input type="text" id="search" placeholder="Search message..." />
        <div class="row-count" id="row-count">0 of 0</div>
      </div>
    </div>
    <div id="virtual-container" class="virtual-container">
      <div id="virtual-inner" class="virtual-inner"></div>
    </div>
  `;

  const severitySelect = document.getElementById('severity-filter');
  const searchInput = document.getElementById('search');
  const container = document.getElementById('virtual-container');

  severitySelect.addEventListener('change', () => {
    currentFilter.severity = severitySelect.value;
    resetAndFetch();
  });

  let debounceTimer;
  searchInput.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      currentFilter.q = searchInput.value.trim();
      resetAndFetch();
    }, 300);
  });

  container.addEventListener('scroll', handleScroll);

  // Initial load
  fetchStats();
  resetAndFetch();
}

async function fetchStats() {
  try {
    const res = await fetch(`${API_BASE}/stats`);
    const data = await res.json();
    // Could update badges but simple for now
    console.log('Stats:', data);
  } catch (e) {}
}

function updateRowCount() {
  const el = document.getElementById('row-count');
  if (el) {
    el.textContent = `${currentTotal.toLocaleString()} rows`;
  }
}

function resetAndFetch() {
  currentOffset = 0;
  const container = document.getElementById('virtual-container');
  if (container) container.scrollTop = 0;
  fetchLogs(0);
}

async function fetchLogs(offset, force = false) {
  if (isLoading && !force) return;

  if (abortController) {
    abortController.abort();
  }
  abortController = new AbortController();

  isLoading = true;
  const limit = 50; // small window for virtualization

  const params = new URLSearchParams({
    offset: offset.toString(),
    limit: limit.toString()
  });
  if (currentFilter.severity) params.set('severity', currentFilter.severity);
  if (currentFilter.q) params.set('q', currentFilter.q);

  const url = `${API_BASE}/logs?${params}`;

  try {
    const start = performance.now();
    const res = await fetch(url, { signal: abortController.signal });
    if (!res.ok) {
      if (res.status === 400) {
        console.warn('Bad request params');
        return;
      }
      throw new Error(res.statusText);
    }
    const data = await res.json();
    const duration = performance.now() - start;
    console.log(`Fetch offset=${offset} took ${duration.toFixed(1)}ms`);

    currentTotal = data.total;
    updateRowCount();

    renderWindow(offset, data.rows, limit);
    lastFetchTime = Date.now();
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error('Fetch error:', err);
    }
  } finally {
    isLoading = false;
  }
}

let renderedRows = [];
let renderedStartOffset = 0;

function renderWindow(offset, rows, windowSize) {
  const container = document.getElementById('virtual-container');
  const inner = document.getElementById('virtual-inner');

  if (!container || !inner) return;

  currentOffset = offset;
  renderedStartOffset = offset;
  renderedRows = rows;

  // Set total height
  const totalHeight = Math.max(currentTotal * ROW_HEIGHT, 600);
  inner.style.height = `${totalHeight}px`;

  // Clear previous rows
  inner.innerHTML = '';

  // Render only visible + overscan rows
  const scrollTop = container.scrollTop;
  const startIdx = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const endIdx = Math.min(currentTotal, startIdx + VISIBLE_ROWS + OVERSCAN * 2);

  // But use the fetched window if it overlaps
  const fetchedStart = offset;
  const fetchedEnd = offset + rows.length;

  for (let i = startIdx; i < endIdx; i++) {
    if (i >= fetchedStart && i < fetchedEnd) {
      const rowData = rows[i - fetchedStart];
      if (rowData) {
        const rowEl = createRowElement(rowData, i);
        inner.appendChild(rowEl);
      }
    }
  }

  // Attach scroll listener if not already (done in createUI)
}

function createRowElement(row, absoluteIndex) {
  const div = document.createElement('div');
  div.className = 'log-row';
  div.style.top = `${absoluteIndex * ROW_HEIGHT}px`;

  const ts = new Date(row.ts).toISOString().replace('T', ' ').slice(0, 19);
  const sevClass = `severity-${row.severity}`;

  div.innerHTML = `
    <div class="log-ts">${ts}</div>
    <div class="log-severity ${sevClass}">${row.severity}</div>
    <div class="log-service">${row.service}</div>
    <div class="log-message" title="${escapeHtml(row.message)}">${escapeHtml(row.message)}</div>
  `;
  return div;
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

function handleScroll() {
  const container = document.getElementById('virtual-container');
  if (!container) return;

  const scrollTop = container.scrollTop;
  const newOffset = Math.floor(scrollTop / ROW_HEIGHT);

  // Re-render visible window from cached if possible
  const inner = document.getElementById('virtual-inner');
  if (inner) {
    inner.innerHTML = '';
    const startIdx = Math.max(0, newOffset - OVERSCAN);
    const endIdx = Math.min(currentTotal, newOffset + VISIBLE_ROWS + OVERSCAN * 2);

    const fetchedStart = renderedStartOffset;
    const fetchedEnd = renderedStartOffset + renderedRows.length;

    for (let i = startIdx; i < endIdx; i++) {
      if (i >= fetchedStart && i < fetchedEnd) {
        const rowData = renderedRows[i - fetchedStart];
        if (rowData) {
          const rowEl = createRowElement(rowData, i);
          inner.appendChild(rowEl);
        }
      }
    }
  }

  // If scrolled far from current fetched window, fetch new window
  const distance = Math.abs(newOffset - currentOffset);
  if (distance > 30 && !isLoading) {
    const fetchOffset = Math.max(0, newOffset - 10);
    fetchLogs(fetchOffset);
  }
}

// Boot
createUI();

// Bonus: keyboard hint
console.log('%c[Log Explorer] Virtualized table ready. Scroll or filter to test performance.', 'color:#888');