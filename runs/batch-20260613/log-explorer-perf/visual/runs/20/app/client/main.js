const ROW_HEIGHT = 35;
const PAGE_SIZE = 100;
const OVERSCAN = 20;

let currentTotal = 0;
let currentRows = new Map(); // offset -> row data
let currentFilter = { severity: '', q: '' };
let fetchController = new AbortController();
let pendingFetches = new Set();

const viewport = document.getElementById('viewport');
const spacer = document.getElementById('spacer');
const content = document.getElementById('content');
const severityFilter = document.getElementById('severity-filter');
const searchInput = document.getElementById('search-input');
const statsContainer = document.getElementById('stats-container');

let statsTotal = 0;

async function fetchStats() {
  try {
    const res = await fetch('http://localhost:3000/api/stats');
    const stats = await res.json();
    statsTotal = stats.total;
    renderStats(stats);
  } catch (e) {
    console.error('Failed to fetch stats', e);
  }
}

function renderStats(stats) {
  statsContainer.innerHTML = \`
    <span id="visible-count"></span>
    <span class="badge debug">Debug: \${stats.severities.debug || 0}</span>
    <span class="badge info">Info: \${stats.severities.info || 0}</span>
    <span class="badge warn">Warn: \${stats.severities.warn || 0}</span>
    <span class="badge error">Error: \${stats.severities.error || 0}</span>
  \`;
  updateVisibleCount();
}

function updateVisibleCount() {
  const el = document.getElementById('visible-count');
  if (el) {
    el.textContent = \`\${currentTotal} of \${statsTotal} rows\`;
  }
}

async function fetchRows(offset, limit, filter, signal) {
  const params = new URLSearchParams({ offset, limit });
  if (filter.severity) params.set('severity', filter.severity);
  if (filter.q) params.set('q', filter.q);
  
  const url = `http://localhost:3000/api/logs?${params.toString()}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error('Failed to fetch');
  return res.json();
}

async function loadRange(startOffset, endOffset) {
  // Align to PAGE_SIZE
  const startPage = Math.floor(startOffset / PAGE_SIZE) * PAGE_SIZE;
  const endPage = Math.ceil(endOffset / PAGE_SIZE) * PAGE_SIZE;
  
  for (let offset = startPage; offset < endPage; offset += PAGE_SIZE) {
    if (currentRows.has(offset) || pendingFetches.has(offset)) continue;
    
    pendingFetches.add(offset);
    
    try {
      const data = await fetchRows(offset, PAGE_SIZE, currentFilter, fetchController.signal);
      
      if (currentTotal !== data.total) {
        currentTotal = data.total;
        spacer.style.height = `${currentTotal * ROW_HEIGHT}px`;
        updateVisibleCount();
      }
      
      for (let i = 0; i < data.rows.length; i++) {
        currentRows.set(offset + i, data.rows[i]);
      }
      
      renderViewport();
    } catch (e) {
      if (e.name !== 'AbortError') {
        console.error('Fetch error', e);
      }
    } finally {
      pendingFetches.delete(offset);
    }
  }
}

function renderViewport() {
  const scrollTop = viewport.scrollTop;
  const viewportHeight = viewport.clientHeight;
  
  let startIdx = Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN;
  let endIdx = Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN;
  
  startIdx = Math.max(0, startIdx);
  endIdx = Math.min(currentTotal, endIdx);
  
  content.style.transform = `translateY(${startIdx * ROW_HEIGHT}px)`;
  
  let html = '';
  for (let i = startIdx; i < endIdx; i++) {
    const row = currentRows.get(i);
    if (row) {
      const d = new Date(row.ts);
      const tsStr = d.toISOString().replace('T', ' ').substring(0, 19);
      html += `
        <div class="log-row" style="height: ${ROW_HEIGHT}px">
          <div class="col-ts">${tsStr}</div>
          <div class="col-sev row-severity ${row.severity}">${row.severity.toUpperCase()}</div>
          <div class="col-svc">${row.service}</div>
          <div class="col-msg">${escapeHtml(row.message)}</div>
        </div>
      `;
    } else {
      html += `<div class="log-row" style="height: ${ROW_HEIGHT}px">Loading...</div>`;
    }
  }
  
  content.innerHTML = html;
  
  loadRange(startIdx, endIdx);
}

function escapeHtml(str) {
  return str.replace(/[&<>'"]/g, 
    tag => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[tag] || tag)
  );
}

function applyFilter() {
  fetchController.abort();
  fetchController = new AbortController();
  
  currentFilter = {
    severity: severityFilter.value,
    q: searchInput.value.trim()
  };
  
  currentRows.clear();
  pendingFetches.clear();
  currentTotal = 0;
  spacer.style.height = '0px';
  viewport.scrollTop = 0;
  
  // Initial fetch to get total
  loadRange(0, Math.ceil(viewport.clientHeight / ROW_HEIGHT) + OVERSCAN);
}

let debounceTimer;
searchInput.addEventListener('input', () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(applyFilter, 300);
});

severityFilter.addEventListener('change', applyFilter);

viewport.addEventListener('scroll', () => {
  requestAnimationFrame(renderViewport);
});

// Init
fetchStats();
applyFilter();
