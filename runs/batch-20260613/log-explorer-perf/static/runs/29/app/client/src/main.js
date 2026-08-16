const API_BASE = '/api';

let currentFilters = { severity: '', q: '' };
let currentTotal = 0;
let isLoading = false;
let lastRequestId = 0;

// Virtualization constants
const ROW_HEIGHT = 42; // approx row height
const OVERSCAN = 10;
const VISIBLE_ROWS = 25; // approx

let scrollOffset = 0;
let fetchedRows = []; // currently loaded window
let fetchedOffset = 0;
let fetchedLimit = 100;

const scroller = document.getElementById('scroller');
const tbody = document.getElementById('tbody');
const virtualContent = document.getElementById('virtual-content');
const rowCountEl = document.getElementById('row-count');
const statsEl = document.getElementById('stats');
const severitySelect = document.getElementById('severity');
const searchInput = document.getElementById('search');

let debounceTimer = null;

function formatTimestamp(ts) {
  const d = new Date(ts);
  return d.toISOString().replace('T', ' ').substring(0, 19);
}

function getSeverityClass(sev) {
  return `severity severity-${sev}`;
}

function renderRows(rows, startOffset) {
  tbody.innerHTML = '';

  if (!rows || rows.length === 0) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="4" class="empty">No logs found for current filters.</td>`;
    tbody.appendChild(tr);
    return;
  }

  rows.forEach((row, idx) => {
    const tr = document.createElement('tr');
    tr.className = 'row';
    tr.innerHTML = `
      <td><span class="timestamp">${formatTimestamp(row.ts)}</span></td>
      <td><span class="${getSeverityClass(row.severity)}">${row.severity.toUpperCase()}</span></td>
      <td><span class="service">${row.service}</span></td>
      <td><div class="message">${escapeHtml(row.message)}</div></td>
    `;
    tbody.appendChild(tr);
  });
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function updateRowCount() {
  rowCountEl.textContent = `${fetchedRows.length} rows visible • ${currentTotal.toLocaleString()} total`;
}

function updateStats(stats) {
  if (!stats) return;
  const parts = [];
  parts.push(`Total: ${stats.total.toLocaleString()}`);
  Object.entries(stats.bySeverity).forEach(([sev, cnt]) => {
    if (cnt > 0) parts.push(`${sev}: ${cnt.toLocaleString()}`);
  });
  statsEl.innerHTML = parts.join(' • ');
}

async function fetchLogs(offset, limit, filters) {
  const requestId = ++lastRequestId;
  const params = new URLSearchParams();
  params.set('offset', offset);
  params.set('limit', limit);
  if (filters.severity) params.set('severity', filters.severity);
  if (filters.q) params.set('q', filters.q);

  const res = await fetch(`${API_BASE}/logs?${params}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to fetch logs');
  }
  const data = await res.json();

  // Ignore stale responses
  if (requestId !== lastRequestId) {
    return null;
  }

  return data;
}

async function fetchStats() {
  try {
    const res = await fetch(`${API_BASE}/stats`);
    if (res.ok) {
      const stats = await res.json();
      updateStats(stats);
    }
  } catch (e) {
    console.warn('Failed to fetch stats', e);
  }
}

async function loadWindow(offset, filters, force = false) {
  if (isLoading) return;
  isLoading = true;

  try {
    const limit = 100; // window size
    const data = await fetchLogs(offset, limit, filters);

    if (data === null) return; // stale

    currentTotal = data.total;
    fetchedRows = data.rows;
    fetchedOffset = offset;
    fetchedLimit = limit;

    // Set virtual height
    const totalHeight = Math.max(currentTotal * ROW_HEIGHT, 1);
    virtualContent.style.height = `${totalHeight}px`;
    virtualContent.style.position = 'relative';

    // Position the table content at correct scroll offset
    const tableOffset = offset * ROW_HEIGHT;
    tbody.style.transform = `translateY(${tableOffset}px)`;
    tbody.style.position = 'absolute';
    tbody.style.width = '100%';

    renderRows(fetchedRows, offset);
    updateRowCount();
  } catch (err) {
    console.error('Load error:', err);
    tbody.innerHTML = `<tr><td colspan="4" class="empty">Error loading logs: ${err.message}</td></tr>`;
  } finally {
    isLoading = false;
  }
}

function onScroll() {
  const scrollTop = scroller.scrollTop;
  const targetOffset = Math.floor(scrollTop / ROW_HEIGHT);

  // Only reload if outside current window +/- overscan
  const windowStart = fetchedOffset;
  const windowEnd = fetchedOffset + fetchedLimit;

  const needsReload = targetOffset < windowStart - OVERSCAN || targetOffset > windowEnd - VISIBLE_ROWS - OVERSCAN;

  if (needsReload && !isLoading) {
    const newOffset = Math.max(0, targetOffset - OVERSCAN);
    loadWindow(newOffset, currentFilters);
  }
}

function resetScrollAndLoad() {
  scroller.scrollTop = 0;
  scrollOffset = 0;
  loadWindow(0, currentFilters, true);
}

function setupFilters() {
  severitySelect.addEventListener('change', () => {
    currentFilters.severity = severitySelect.value;
    resetScrollAndLoad();
  });

  searchInput.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      currentFilters.q = searchInput.value.trim();
      resetScrollAndLoad();
    }, 250);
  });

  // Prevent scroll blocking
  scroller.addEventListener('scroll', () => {
    // Throttled scroll handler
    if (!window._scrollRaf) {
      window._scrollRaf = requestAnimationFrame(() => {
        onScroll();
        window._scrollRaf = null;
      });
    }
  });
}

async function init() {
  // Initial load
  await loadWindow(0, currentFilters);
  await fetchStats();

  setupFilters();

  // Keyboard focus
  searchInput.focus();

  // Handle window resize
  window.addEventListener('resize', () => {
    // Could recalculate visible but simple keep
  });

  // Initial status
  document.getElementById('status').innerHTML = '<span style="color:#4ade80">●</span> Connected';
}

init();
