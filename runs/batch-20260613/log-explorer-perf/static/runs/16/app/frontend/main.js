const ROW_HEIGHT = 36;
const FETCH_LIMIT = 100;
const OVERSCAN = 20;

let globalTotal = 0;
let totalRows = 0;
let currentSeverity = '';
let currentQuery = '';
let abortController = null;

let rowCache = new Map();
let pendingFetches = new Set();

const viewport = document.getElementById('viewport');
const scrollContent = document.getElementById('scroll-content');
const totalCountEl = document.getElementById('total-count');
const severityFilter = document.getElementById('severity-filter');
const searchInput = document.getElementById('search-input');

async function fetchStats() {
  const res = await fetch('/api/stats');
  const data = await res.json();
  globalTotal = data.total;
  
  // Update severity filter badges
  const options = severityFilter.options;
  for (let i = 0; i < options.length; i++) {
    const opt = options[i];
    if (opt.value === '') {
      opt.textContent = `All Severities (${data.total})`;
    } else if (data.severities[opt.value] !== undefined) {
      const label = opt.value.charAt(0).toUpperCase() + opt.value.slice(1);
      opt.textContent = `${label} (${data.severities[opt.value]})`;
    }
  }
}

async function fetchLogs(offset, limit, signal) {
  const url = new URL('/api/logs', window.location.origin);
  url.searchParams.set('offset', offset);
  url.searchParams.set('limit', limit);
  if (currentSeverity) url.searchParams.set('severity', currentSeverity);
  if (currentQuery) url.searchParams.set('q', currentQuery);

  const res = await fetch(url.toString(), { signal });
  if (!res.ok) throw new Error('Network response was not ok');
  return res.json();
}

async function updateFilters() {
  currentSeverity = severityFilter.value;
  currentQuery = searchInput.value;
  
  if (abortController) {
    abortController.abort();
  }
  abortController = new AbortController();
  const signal = abortController.signal;
  
  rowCache.clear();
  pendingFetches.clear();
  totalRows = 0;
  scrollContent.style.height = '0px';
  renderViewport(); // Clear existing rows
  
  viewport.scrollTop = 0;
  
  try {
    const data = await fetchLogs(0, FETCH_LIMIT, signal);
    totalRows = data.total;
    totalCountEl.textContent = `${totalRows} of ${globalTotal} rows`;
    scrollContent.style.height = `${totalRows * ROW_HEIGHT}px`;
    
    for (let i = 0; i < data.rows.length; i++) {
      rowCache.set(i, data.rows[i]);
    }
    
    renderViewport();
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error(err);
    }
  }
}

function renderRow(index, rowData) {
  let el = document.getElementById(`row-${index}`);
  if (!el) {
    el = document.createElement('div');
    el.id = `row-${index}`;
    el.className = 'log-row';
    el.style.top = `${index * ROW_HEIGHT}px`;
    scrollContent.appendChild(el);
  }
  
  if (rowData) {
    el.innerHTML = `
      <div class="col-ts">${new Date(rowData.ts).toISOString().replace('T', ' ').substring(0, 19)}</div>
      <div class="col-severity severity-${rowData.severity}">${rowData.severity}</div>
      <div class="col-service">${rowData.service}</div>
      <div class="col-message" title="${escapeHtml(rowData.message)}">${escapeHtml(rowData.message)}</div>
    `;
  } else {
    el.innerHTML = `<div style="padding-left: 16px; color: #999;">Loading...</div>`;
  }
  return el;
}

function escapeHtml(unsafe) {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function renderViewport() {
  const scrollTop = viewport.scrollTop;
  const viewportHeight = viewport.clientHeight;
  
  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const endIndex = totalRows === 0 ? -1 : Math.min(totalRows - 1, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN);
  
  const existingRows = scrollContent.querySelectorAll('.log-row');
  existingRows.forEach(row => {
    const index = parseInt(row.id.replace('row-', ''), 10);
    if (index < startIndex || index > endIndex) {
      row.remove();
    }
  });
  
  const missingWindows = new Set();
  
  for (let i = startIndex; i <= endIndex; i++) {
    const rowData = rowCache.get(i);
    renderRow(i, rowData);
    
    if (!rowData) {
      const windowStart = Math.floor(i / FETCH_LIMIT) * FETCH_LIMIT;
      missingWindows.add(windowStart);
    }
  }
  
  missingWindows.forEach(windowStart => {
    if (!pendingFetches.has(windowStart)) {
      pendingFetches.add(windowStart);
      const signal = abortController.signal;
      fetchLogs(windowStart, FETCH_LIMIT, signal).then(data => {
        for (let i = 0; i < data.rows.length; i++) {
          rowCache.set(windowStart + i, data.rows[i]);
        }
        pendingFetches.delete(windowStart);
        renderViewport();
      }).catch(err => {
        if (err.name !== 'AbortError') {
          console.error(err);
          pendingFetches.delete(windowStart);
        }
      });
    }
  });
}

let debounceTimeout;
searchInput.addEventListener('input', () => {
  clearTimeout(debounceTimeout);
  debounceTimeout = setTimeout(() => {
    updateFilters();
  }, 300);
});

severityFilter.addEventListener('change', () => {
  updateFilters();
});

let ticking = false;
viewport.addEventListener('scroll', () => {
  if (!ticking) {
    window.requestAnimationFrame(() => {
      renderViewport();
      ticking = false;
    });
    ticking = true;
  }
});

async function init() {
  try {
    await fetchStats();
  } catch (err) {
    console.error('Failed to fetch stats:', err);
  }
  updateFilters();
}

init();