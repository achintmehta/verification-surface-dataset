const ROW_HEIGHT = 36;
const OVERSCAN = 20;
const FETCH_LIMIT = 100;

let currentTotal = 0;
let globalTotal = 0;
let currentFilters = { severity: '', q: '' };
let rowCache = new Map();
let fetchController = null;
let pendingFetchRange = null;

const viewport = document.getElementById('viewport');
const spacer = document.getElementById('spacer');
const rowsContainer = document.getElementById('rows-container');
const severityFilter = document.getElementById('severity-filter');
const searchInput = document.getElementById('search-input');
const statsDiv = document.getElementById('stats');

async function fetchStats() {
  try {
    const res = await fetch('/api/stats');
    const stats = await res.json();
    globalTotal = stats.total;
    updateStatsDisplay();
    
    const options = severityFilter.options;
    for (let i = 0; i < options.length; i++) {
      const opt = options[i];
      if (opt.value === '') {
        opt.textContent = `All Severities (${stats.total})`;
      } else if (stats.severities[opt.value] !== undefined) {
        const label = opt.value.charAt(0).toUpperCase() + opt.value.slice(1);
        opt.textContent = `${label} (${stats.severities[opt.value]})`;
      }
    }
  } catch (e) {
    console.error('Failed to fetch stats', e);
  }
}

function updateStatsDisplay() {
  if (globalTotal > 0) {
    statsDiv.textContent = `${currentTotal} of ${globalTotal} rows`;
  } else {
    statsDiv.textContent = `${currentTotal} rows`;
  }
}

async function fetchLogs(offset, limit) {
  if (fetchController) {
    fetchController.abort();
  }
  fetchController = new AbortController();
  
  const params = new URLSearchParams({
    offset,
    limit,
    ...(currentFilters.severity && { severity: currentFilters.severity }),
    ...(currentFilters.q && { q: currentFilters.q })
  });

  try {
    const res = await fetch(`/api/logs?${params.toString()}`, {
      signal: fetchController.signal
    });
    if (!res.ok) throw new Error('Network response was not ok');
    const data = await res.json();
    
    currentTotal = data.total;
    spacer.style.height = `${currentTotal * ROW_HEIGHT}px`;
    
    updateStatsDisplay();

    for (let i = 0; i < data.rows.length; i++) {
      rowCache.set(offset + i, data.rows[i]);
    }
    
    render();
  } catch (e) {
    if (e.name !== 'AbortError') {
      console.error('Failed to fetch logs', e);
    }
  }
}

const domRows = [];

function render() {
  const scrollTop = viewport.scrollTop;
  const viewportHeight = viewport.clientHeight;
  
  if (viewportHeight === 0) return;

  let startIndex = Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN;
  startIndex = Math.max(0, startIndex);
  
  let visibleCount = Math.ceil(viewportHeight / ROW_HEIGHT) + 2 * OVERSCAN;
  let endIndex = Math.min(currentTotal - 1, startIndex + visibleCount - 1);
  
  if (currentTotal === 0) {
    for (let i = 0; i < domRows.length; i++) {
      domRows[i].style.display = 'none';
    }
    return;
  }

  let missingStart = -1;
  let missingEnd = -1;
  
  for (let i = startIndex; i <= endIndex; i++) {
    if (!rowCache.has(i)) {
      if (missingStart === -1) missingStart = i;
      missingEnd = i;
    }
  }

  if (missingStart !== -1) {
    let fetchOffset = Math.floor(missingStart / 50) * 50;
    let fetchLimit = Math.ceil((missingEnd - fetchOffset + 1) / 50) * 50;
    fetchLimit = Math.min(200, fetchLimit + 50);
    
    const rangeKey = `${fetchOffset}-${fetchLimit}`;
    if (pendingFetchRange !== rangeKey) {
      pendingFetchRange = rangeKey;
      fetchLogs(fetchOffset, fetchLimit).finally(() => {
        if (pendingFetchRange === rangeKey) pendingFetchRange = null;
      });
    }
  }

  const requiredCount = endIndex - startIndex + 1;
  
  while (domRows.length < requiredCount) {
    const el = document.createElement('div');
    el.className = 'log-row';
    el.style.position = 'absolute';
    el.style.left = '0';
    el.style.right = '0';
    rowsContainer.appendChild(el);
    domRows.push(el);
  }
  
  for (let i = requiredCount; i < domRows.length; i++) {
    domRows[i].style.display = 'none';
  }
  
  for (let i = 0; i < requiredCount; i++) {
    const rowIndex = startIndex + i;
    const rowData = rowCache.get(rowIndex);
    const el = domRows[i];
    
    el.style.display = 'flex';
    el.style.top = `${rowIndex * ROW_HEIGHT}px`;
    
    if (rowData) {
      el.innerHTML = `
        <div class="col-ts">${new Date(rowData.ts).toLocaleString()}</div>
        <div class="col-sev sev-${rowData.severity}">${rowData.severity}</div>
        <div class="col-svc">${rowData.service}</div>
        <div class="col-msg" title="${escapeHtml(rowData.message)}">${escapeHtml(rowData.message)}</div>
      `;
    } else {
      el.innerHTML = `<div style="padding: 0 16px; color: #999;">Loading...</div>`;
    }
  }
}

function escapeHtml(unsafe) {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

viewport.addEventListener('scroll', () => {
  requestAnimationFrame(render);
});

window.addEventListener('resize', () => {
  requestAnimationFrame(render);
});

function applyFilters() {
  currentFilters.severity = severityFilter.value;
  currentFilters.q = searchInput.value.trim();
  rowCache.clear();
  currentTotal = 0;
  spacer.style.height = '0px';
  viewport.scrollTop = 0;
  
  const fetchOffset = 0;
  const fetchLimit = 100;
  pendingFetchRange = `${fetchOffset}-${fetchLimit}`;
  fetchLogs(fetchOffset, fetchLimit).finally(() => {
    if (pendingFetchRange === `${fetchOffset}-${fetchLimit}`) pendingFetchRange = null;
  });
}

severityFilter.addEventListener('change', applyFilters);

let debounceTimer;
searchInput.addEventListener('input', () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(applyFilters, 300);
});

// Initial load
fetchStats();
applyFilters();
