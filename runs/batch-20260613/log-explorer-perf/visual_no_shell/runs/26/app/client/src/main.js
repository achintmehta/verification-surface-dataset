const API_BASE = '/api';

let currentFilter = { severity: '', q: '' };
let currentTotal = 0;
let rowHeight = 42; // approximate row height
let visibleRows = 15;
let overscan = 5;
let isLoading = false;
let lastRequestTime = 0;
let abortController = null;

const container = document.getElementById('virtual-scroller');
const tbody = document.getElementById('log-rows');
const severitySelect = document.getElementById('severity-filter');
const searchInput = document.getElementById('search-input');
const rowCountEl = document.getElementById('row-count');

// Set up virtual scroller height based on total
function updateScrollerHeight(total) {
  const height = Math.max(total * rowHeight, 600);
  container.style.height = '600px';
  // We use a spacer for virtual scroll
  let spacer = container.querySelector('.spacer');
  if (!spacer) {
    spacer = document.createElement('div');
    spacer.className = 'spacer';
    spacer.style.position = 'absolute';
    spacer.style.top = '0';
    spacer.style.left = '0';
    spacer.style.width = '1px';
    spacer.style.pointerEvents = 'none';
    const rowsContainer = document.getElementById('log-rows');
    rowsContainer.appendChild(spacer);
  }
  spacer.style.height = `${height}px`;
}

function updateRowCount() {
  rowCountEl.textContent = `${tbody.children.length} of ${currentTotal.toLocaleString()}`;
}

function getSeverityClass(severity) {
  return `severity severity-${severity}`;
}

function renderRows(rows, startOffset) {
  tbody.innerHTML = '';
  const fragment = document.createDocumentFragment();

  rows.forEach((row, index) => {
    const div = document.createElement('div');
    div.className = 'log-row';
    div.style.top = `${(startOffset + index) * rowHeight}px`;

    const ts = new Date(row.ts).toLocaleString();
    div.innerHTML = `
      <div class="col ts timestamp">${ts}</div>
      <div class="col sev"><span class="${getSeverityClass(row.severity)}">${row.severity}</span></div>
      <div class="col svc service">${row.service}</div>
      <div class="col msg message">${escapeHtml(row.message)}</div>
    `;
    fragment.appendChild(div);
  });

  tbody.appendChild(fragment);
  updateRowCount();
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (m) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

async function fetchLogs(offset, limit, filters) {
  if (abortController) {
    abortController.abort();
  }
  abortController = new AbortController();

  const params = new URLSearchParams({
    offset: offset.toString(),
    limit: limit.toString()
  });
  if (filters.severity) params.append('severity', filters.severity);
  if (filters.q) params.append('q', filters.q);

  const start = performance.now();
  const res = await fetch(`${API_BASE}/logs?${params}`, { signal: abortController.signal });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to fetch');
  }
  const data = await res.json();
  console.log(`Fetch took ${performance.now() - start}ms for offset ${offset}`);
  return data;
}

async function fetchStats() {
  const res = await fetch(`${API_BASE}/stats`);
  return res.json();
}

let debounceTimer = null;
function debounceSearch(fn, delay = 300) {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(fn, delay);
}

async function loadWindow(offset, filters = currentFilter) {
  if (isLoading) return;
  isLoading = true;

  try {
    const limit = visibleRows + overscan * 2;
    const data = await fetchLogs(offset, limit, filters);

    currentTotal = data.total;
    updateScrollerHeight(currentTotal);

    // Render only the window
    renderRows(data.rows, offset);
  } catch (e) {
    if (e.name !== 'AbortError') {
      console.error(e);
    }
  } finally {
    isLoading = false;
  }
}

function onScroll() {
  const scrollTop = container.scrollTop;
  const rowOffset = Math.floor(scrollTop / rowHeight);
  const maxOffset = Math.max(0, currentTotal - visibleRows);

  const targetOffset = Math.min(Math.max(0, rowOffset - overscan), maxOffset);

  // Load if needed - simple: always load current window on scroll (debounced implicitly by request)
  // To avoid too many requests, we can throttle
  loadWindow(targetOffset);
}

function setupScroll() {
  let scrollTimeout;
  container.addEventListener('scroll', () => {
    clearTimeout(scrollTimeout);
    scrollTimeout = setTimeout(onScroll, 50);
  });
}

function setupFilters() {
  severitySelect.addEventListener('change', () => {
    currentFilter.severity = severitySelect.value;
    resetAndLoad();
  });

  searchInput.addEventListener('input', () => {
    debounceSearch(() => {
      currentFilter.q = searchInput.value.trim();
      resetAndLoad();
    }, 250);
  });
}

async function resetAndLoad() {
  // Reset scroll to top
  container.scrollTop = 0;
  await loadWindow(0, currentFilter);
}

async function init() {
  // Initial load
  await loadWindow(0);

  // Also fetch stats if needed, but for now row count is dynamic
  setupScroll();
  setupFilters();

  // Initial row count update
  updateRowCount();

  // Make sure spacer exists
  updateScrollerHeight(currentTotal || 100000);

  // Keyboard support etc, but basic is done
  console.log('Log Explorer initialized');
}

init();