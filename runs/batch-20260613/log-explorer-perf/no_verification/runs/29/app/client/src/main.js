const API_BASE = 'http://localhost:3001/api';

let currentFilters = { severity: '', q: '' };
let currentTotal = 0;
let rowHeight = 32;
let overscan = 5;
let isFetching = false;
let fetchSeq = 0;
let abortController = null;

const scroller = document.getElementById('virtual-scroller');
const content = document.getElementById('virtual-content');
const tbody = document.getElementById('log-rows');
const severitySelect = document.getElementById('severity-filter');
const searchInput = document.getElementById('search-input');
const rowCountEl = document.getElementById('row-count');

let debounceTimer = null;

function updateRowCount() {
  rowCountEl.textContent = `${currentTotal.toLocaleString()} rows`;
}

async function fetchLogs(offset, limit, filters, seq) {
  if (abortController) {
    abortController.abort();
  }
  abortController = new AbortController();

  const params = new URLSearchParams({
    offset: offset.toString(),
    limit: limit.toString(),
    ...(filters.severity && { severity: filters.severity }),
    ...(filters.q && { q: filters.q })
  });

  const res = await fetch(`${API_BASE}/logs?${params}`, {
    signal: abortController.signal
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to fetch');
  }

  const data = await res.json();

  // Check if stale
  if (seq !== fetchSeq) {
    return null; // stale, ignore
  }

  return data;
}

async function fetchStats() {
  try {
    const res = await fetch(`${API_BASE}/stats`);
    if (res.ok) {
      const stats = await res.json();
      // Could update badges but for now just total from logs
    }
  } catch (e) {}
}

function renderRows(rows, startOffset) {
  tbody.innerHTML = '';
  tbody.style.position = 'relative';

  if (rows.length === 0) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="4" style="padding: 40px; text-align: center; color: #999;">No logs found</td>`;
    tbody.appendChild(tr);
    return;
  }

  // Set virtual height via padding or content height
  const totalHeight = currentTotal * rowHeight;
  content.style.height = `${totalHeight}px`;

  rows.forEach((row, i) => {
    const tr = document.createElement('tr');
    tr.className = `log-row severity-${row.severity}`;
    tr.style.top = `${(startOffset + i) * rowHeight}px`;
    tr.style.height = `${rowHeight}px`;

    const ts = new Date(row.ts).toISOString().replace('T', ' ').slice(0, 19);
    tr.innerHTML = `
      <td style="width: 180px;">${ts}</td>
      <td style="width: 80px;"><span class="severity-${row.severity}">${row.severity.toUpperCase()}</span></td>
      <td style="width: 100px;">${row.service}</td>
      <td>${row.message}</td>
    `;
    tbody.appendChild(tr);
  });
}

async function loadWindow(offset, force = false) {
  if (isFetching && !force) return;
  isFetching = true;

  const limit = 100;
  const seq = ++fetchSeq;

  try {
    const data = await fetchLogs(offset, limit, currentFilters, seq);
    if (data === null) return; // stale

    currentTotal = data.total;
    updateRowCount();

    // Render the window
    renderRows(data.rows, offset);

    // Adjust scroller scroll if needed? No, keep position
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error('Fetch error:', err);
    }
  } finally {
    isFetching = false;
  }
}

function getVisibleOffset() {
  const scrollTop = scroller.scrollTop;
  return Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
}

function handleScroll() {
  const offset = getVisibleOffset();
  // Only refetch if offset changed significantly, e.g. by more than limit/2
  // For simplicity, always check current rendered and load if needed
  // But to avoid constant, we can load every time but debounce scroll
  loadWindow(offset);
}

let scrollTimer = null;
function throttledScroll() {
  if (scrollTimer) clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => {
    handleScroll();
  }, 50);
}

function applyFilters() {
  currentFilters = {
    severity: severitySelect.value,
    q: searchInput.value.trim()
  };

  // Reset scroll to top
  scroller.scrollTop = 0;
  content.style.height = '0px';
  tbody.innerHTML = '';

  loadWindow(0, true);
}

function setupEventListeners() {
  severitySelect.addEventListener('change', () => {
    applyFilters();
  });

  searchInput.addEventListener('input', () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      applyFilters();
    }, 300);
  });

  scroller.addEventListener('scroll', throttledScroll);

  // Initial load
  window.addEventListener('load', () => {
    loadWindow(0, true);
    fetchStats();
  });

  // Keyboard support etc, but basic ok
}

// Handle window resize? but fixed height ok
setupEventListeners();