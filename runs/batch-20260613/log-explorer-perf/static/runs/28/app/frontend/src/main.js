const API_BASE = ''; // proxied in dev

let currentFilters = { severity: '', q: '' };
let currentTotal = 0;
let rowHeight = 32; // approx
let overscan = 10;
let visibleRows = [];
let isLoading = false;
let lastRequestId = 0;

const container = document.getElementById('virtual-container');
const scroller = document.getElementById('virtual-scroller');
const tbody = document.getElementById('log-tbody');
const severitySelect = document.getElementById('severity-filter');
const searchInput = document.getElementById('search-input');
const visibleCountEl = document.getElementById('visible-count');
const totalCountEl = document.getElementById('total-count');

let debounceTimer = null;

function updateCount(visible) {
  visibleCountEl.textContent = visible;
  totalCountEl.textContent = currentTotal.toLocaleString();
}

async function fetchLogs(offset, limit, filters) {
  const params = new URLSearchParams();
  params.set('offset', offset);
  params.set('limit', limit);
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
  tbody.innerHTML = '';
  visibleRows = rows;

  // Set scroller height to simulate total
  const totalHeight = currentTotal * rowHeight;
  scroller.style.height = `${totalHeight}px`;

  // Position the tbody at the correct scroll offset (thead stays fixed)
  tbody.style.position = 'absolute';
  tbody.style.top = `${startOffset * rowHeight}px`;
  tbody.style.width = '100%';

  rows.forEach((row, idx) => {
    const tr = document.createElement('tr');
    tr.className = 'row';
    const ts = new Date(row.ts).toISOString().replace('T', ' ').substring(0, 19);
    tr.innerHTML = `
      <td>${ts}</td>
      <td class="severity-${row.severity}">${row.severity}</td>
      <td>${row.service}</td>
      <td style="word-break: break-all;">${escapeHtml(row.message)}</td>
    `;
    tbody.appendChild(tr);
  });

  updateCount(rows.length);
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (m) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

async function loadWindow(scrollTop) {
  if (isLoading) return;
  isLoading = true;

  const startRow = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const endRow = Math.min(currentTotal, startRow + Math.ceil(container.clientHeight / rowHeight) + overscan * 2);
  const limit = Math.min(200, endRow - startRow);

  if (limit <= 0) {
    isLoading = false;
    return;
  }

  try {
    const data = await fetchLogs(startRow, limit, currentFilters);
    if (data === null) { // stale
      isLoading = false;
      return;
    }
    currentTotal = data.total; // update in case changed? but static
    renderRows(data.rows, startRow);
  } catch (e) {
    console.error(e);
    tbody.innerHTML = `<tr><td colspan="4">Error loading logs: ${e.message}</td></tr>`;
  }
  isLoading = false;
}

function resetAndLoad() {
  tbody.innerHTML = '';
  scroller.style.height = '0px';
  container.scrollTop = 0;
  currentTotal = 0;
  updateCount(0);
  loadWindow(0);
}

function applyFilters() {
  currentFilters = {
    severity: severitySelect.value,
    q: searchInput.value.trim()
  };
  resetAndLoad();
}

function setupEventListeners() {
  severitySelect.addEventListener('change', () => {
    applyFilters();
  });

  searchInput.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      applyFilters();
    }, 300);
  });

  container.addEventListener('scroll', () => {
    const scrollTop = container.scrollTop;
    // Throttle load? but for simplicity reload window on scroll
    // To avoid too many, use requestAnimationFrame or simple
    if (!isLoading) {
      loadWindow(scrollTop);
    }
  });

  // Initial load stats for badges? but we use total from logs
  // For completeness, could show per sev but not required
}

async function init() {
  setupEventListeners();

  // Initial load
  try {
    const stats = await fetchStats();
    currentTotal = stats.total;
    totalCountEl.textContent = currentTotal.toLocaleString();
  } catch (e) {
    console.error('Failed to fetch stats', e);
  }

  // Set initial scroller height
  scroller.style.height = `${currentTotal * rowHeight}px`;

  // Load initial window
  await loadWindow(0);

  // Handle window resize
  window.addEventListener('resize', () => {
    if (container.scrollTop !== undefined) {
      loadWindow(container.scrollTop);
    }
  });
}

init();