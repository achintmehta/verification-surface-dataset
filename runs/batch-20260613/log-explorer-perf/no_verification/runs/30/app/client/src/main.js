const API_BASE = '/api';

let currentFilter = { severity: '', q: '' };
let unfilteredTotal = 0;
let currentTotal = 0; // filtered
let rowHeight = 35; // approx
let visibleRows = 20;
let overscan = 5;
let isLoading = false;
let debounceTimer = null;
let requestId = 0;

const scroller = document.getElementById('virtual-scroller');
const content = document.getElementById('virtual-content');
const severitySelect = document.getElementById('severity-filter');
const searchBox = document.getElementById('search-box');
const rowCountEl = document.getElementById('row-count');
const statsEl = document.getElementById('stats');

let renderedRows = new Map(); // offset -> element

async function fetchLogs(offset, limit, severity, q) {
  const params = new URLSearchParams({ offset, limit });
  if (severity) params.append('severity', severity);
  if (q) params.append('q', q);
  const start = Date.now();
  const res = await fetch(`${API_BASE}/logs?${params}`);
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || 'Fetch failed');
  }
  const data = await res.json();
  console.log(`Fetch took ${Date.now() - start}ms for offset ${offset}`);
  return data;
}

async function fetchStats() {
  const res = await fetch(`${API_BASE}/stats`);
  return res.json();
}

function updateRowCount(filteredTotal) {
  rowCountEl.textContent = `${filteredTotal.toLocaleString()} of ${unfilteredTotal.toLocaleString()}`;
}

function updateStats(stats) {
  statsEl.innerHTML = `Total: ${stats.total.toLocaleString()} | ` +
    `Debug: ${stats.perSeverity.debug} | Info: ${stats.perSeverity.info} | ` +
    `Warn: ${stats.perSeverity.warn} | Error: ${stats.perSeverity.error}`;
}

function createRowElement(log, absoluteIndex) {
  const row = document.createElement('div');
  row.className = 'log-row';
  row.style.position = 'absolute';
  row.style.top = `${absoluteIndex * rowHeight}px`;
  row.style.height = `${rowHeight}px`;
  row.style.width = '100%';
  row.innerHTML = `
    <div class="col-ts">${new Date(log.ts).toISOString().replace('T', ' ').slice(0,19)}</div>
    <div class="col-sev sev-${log.severity}">${log.severity.toUpperCase()}</div>
    <div class="col-svc">${log.service}</div>
    <div class="col-msg">${log.message}</div>
  `;
  return row;
}

function renderWindow(startOffset, rows, total) {
  // Clear previous
  content.innerHTML = '';
  renderedRows.clear();

  content.style.height = `${total * rowHeight}px`;

  const endOffset = Math.min(startOffset + visibleRows + overscan * 2, total);

  for (let i = startOffset; i < endOffset; i++) {
    const logIndex = i - startOffset;
    if (logIndex < rows.length) {
      const rowEl = createRowElement(rows[logIndex], i);
      content.appendChild(rowEl);
      renderedRows.set(i, rowEl);
    }
  }
}

function updateVisibleWindow(currentOffset, allRows, total) {
  // Recycle: remove out of view
  const minVisible = Math.max(0, currentOffset - overscan);
  const maxVisible = Math.min(total, currentOffset + visibleRows + overscan);

  // Remove old
  for (const [idx, el] of renderedRows) {
    if (idx < minVisible || idx >= maxVisible) {
      el.remove();
      renderedRows.delete(idx);
    }
  }

  // Add missing in range
  for (let i = minVisible; i < maxVisible; i++) {
    if (!renderedRows.has(i)) {
      const rowIdx = i - currentOffset;
      if (rowIdx >= 0 && rowIdx < allRows.length) {
        const rowEl = createRowElement(allRows[rowIdx], i);
        content.appendChild(rowEl);
        renderedRows.set(i, rowEl);
      }
    }
  }
}

let currentData = { rows: [], offset: 0, total: 0 };

async function loadWindow(offset, limit = 100) {
  const myRequestId = ++requestId;
  if (isLoading) return;
  isLoading = true;
  try {
    const { severity, q } = currentFilter;
    const data = await fetchLogs(offset, limit, severity, q);
    if (myRequestId !== requestId) return; // stale response
    currentData = { rows: data.rows, offset, total: data.total };
    currentTotal = data.total;
    renderWindow(offset, data.rows, data.total);
    updateRowCount(data.total);
  } catch (e) {
    console.error(e);
    if (myRequestId === requestId) {
      alert('Error loading logs: ' + e.message);
    }
  } finally {
    if (myRequestId === requestId) {
      isLoading = false;
    }
  }
}

function onScroll() {
  const scrollTop = scroller.scrollTop;
  const newOffset = Math.floor(scrollTop / rowHeight);
  const { rows, offset: currentOffset, total } = currentData;

  // If scrolled far, reload window
  if (Math.abs(newOffset - currentOffset) > 50 || newOffset < currentOffset || newOffset > currentOffset + rows.length - 20) {
    loadWindow(Math.max(0, newOffset - overscan));
  } else {
    updateVisibleWindow(newOffset, rows, total);
  }
}

function applyFilters() {
  currentFilter.severity = severitySelect.value;
  currentFilter.q = searchBox.value.trim();
  // reset scroll
  scroller.scrollTop = 0;
  loadWindow(0);
}

function debounceSearch() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    applyFilters();
  }, 300);
}

async function init() {
  // Load initial stats
  try {
    const stats = await fetchStats();
    updateStats(stats);
    unfilteredTotal = stats.total;
    currentTotal = stats.total;
  } catch (e) {
    console.error('Stats failed', e);
  }

  // Initial load
  await loadWindow(0, 100);

  // Event listeners
  severitySelect.addEventListener('change', applyFilters);
  searchBox.addEventListener('input', debounceSearch);

  scroller.addEventListener('scroll', onScroll);

  // Set initial content height
  content.style.height = `${currentTotal * rowHeight}px`;

  // Keyboard hint
  console.log('Log explorer initialized. Scroll or filter.');
}

init();