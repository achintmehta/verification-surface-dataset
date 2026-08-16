const API_BASE = 'http://localhost:3000/api';

const ROW_HEIGHT = 36;
const OVERSCAN = 10;

let state = {
  absoluteTotal: 0,
  total: 0,
  rows: [],
  offset: 0, // offset of the currently loaded rows
  fetchOffset: 0, // offset of the in-flight fetch
  limit: 100,
  severity: '',
  q: '',
  scrollTop: 0,
  viewportHeight: 0,
  loading: false,
  abortController: null
};

const elements = {
  severityFilter: document.getElementById('severity-filter'),
  searchInput: document.getElementById('search-input'),
  stats: document.getElementById('stats'),
  viewport: document.getElementById('viewport'),
  spacer: document.getElementById('spacer'),
  rowsContainer: document.getElementById('rows-container')
};

async function fetchStats() {
  try {
    const res = await fetch(`${API_BASE}/stats`);
    const data = await res.json();
    state.absoluteTotal = data.total;
    updateStatsUI();
  } catch (err) {
    console.error('Failed to fetch stats', err);
  }
}

function updateStatsUI() {
  if (state.absoluteTotal > 0) {
    elements.stats.textContent = `${state.total} of ${state.absoluteTotal}`;
  } else {
    elements.stats.textContent = `${state.total} rows found`;
  }
}

async function fetchLogs() {
  if (state.abortController) {
    state.abortController.abort();
  }
  state.abortController = new AbortController();

  try {
    const params = new URLSearchParams({
      offset: state.fetchOffset,
      limit: state.limit
    });
    if (state.severity) params.append('severity', state.severity);
    if (state.q) params.append('q', state.q);

    const res = await fetch(`${API_BASE}/logs?${params.toString()}`, {
      signal: state.abortController.signal
    });
    const data = await res.json();
    
    state.total = data.total;
    state.rows = data.rows;
    state.offset = state.fetchOffset;
    
    updateStatsUI();
    
    render();
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error('Failed to fetch logs', err);
    }
  }
}

function render() {
  elements.spacer.style.height = `${state.total * ROW_HEIGHT}px`;
  
  const startIndex = Math.max(0, Math.floor(state.scrollTop / ROW_HEIGHT));
  const visibleCount = Math.ceil(state.viewportHeight / ROW_HEIGHT);
  const endIndex = Math.min(state.total, startIndex + visibleCount);
  
  let requiredStart = Math.max(0, startIndex - OVERSCAN);
  let requiredEnd = Math.min(state.total, endIndex + OVERSCAN);
  
  if (requiredEnd - requiredStart > state.limit) {
    requiredEnd = requiredStart + state.limit;
  }
  
  const hasData = state.rows.length > 0 && 
                  state.offset <= requiredStart && 
                  (state.offset + state.rows.length >= requiredEnd || state.offset + state.rows.length === state.total);

  if (!hasData && state.total > 0) {
    const requiredWindow = requiredEnd - requiredStart;
    const buffer = Math.max(0, Math.floor((state.limit - requiredWindow) / 2));
    let newOffset = Math.max(0, requiredStart - buffer);
    
    if (newOffset !== state.fetchOffset) {
      state.fetchOffset = newOffset;
      fetchLogs();
    }
  }

  const containerTop = state.offset * ROW_HEIGHT;
  elements.rowsContainer.style.transform = `translateY(${containerTop}px)`;

  const fragment = document.createDocumentFragment();
  
  // Pool of DOM nodes
  if (!state.rowPool) state.rowPool = [];
  let poolIndex = 0;
  
  for (let i = 0; i < state.rows.length; i++) {
    const row = state.rows[i];
    const rowIndex = state.offset + i;
    
    if (rowIndex >= requiredStart && rowIndex < requiredEnd) {
      let div;
      if (poolIndex < state.rowPool.length) {
        div = state.rowPool[poolIndex];
      } else {
        div = document.createElement('div');
        div.className = 'log-row';
        
        const ts = document.createElement('div');
        ts.className = 'col-ts';
        
        const severity = document.createElement('div');
        
        const service = document.createElement('div');
        service.className = 'col-service';
        
        const message = document.createElement('div');
        message.className = 'col-message';
        
        div.appendChild(ts);
        div.appendChild(severity);
        div.appendChild(service);
        div.appendChild(message);
        
        div.style.position = 'absolute';
        div.style.left = '0';
        div.style.right = '0';
        
        state.rowPool.push(div);
      }
      
      div.children[0].textContent = new Date(row.ts).toLocaleString();
      div.children[1].className = `col-severity severity-${row.severity}`;
      div.children[1].textContent = row.severity.toUpperCase();
      div.children[2].textContent = row.service;
      div.children[3].textContent = row.message;
      div.children[3].title = row.message;
      
      div.style.top = `${i * ROW_HEIGHT}px`;
      
      fragment.appendChild(div);
      poolIndex++;
    }
  }
  
  elements.rowsContainer.replaceChildren(fragment);
}

function onScroll() {
  state.scrollTop = elements.viewport.scrollTop;
  render();
}

function onResize() {
  state.viewportHeight = elements.viewport.clientHeight;
  render();
}

let debounceTimer;
function onSearchInput(e) {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    state.q = e.target.value;
    state.fetchOffset = 0;
    state.offset = 0;
    state.rows = [];
    state.scrollTop = 0;
    elements.viewport.scrollTop = 0;
    fetchLogs();
  }, 300);
}

function onSeverityChange(e) {
  state.severity = e.target.value;
  state.fetchOffset = 0;
  state.offset = 0;
  state.rows = [];
  state.scrollTop = 0;
  elements.viewport.scrollTop = 0;
  fetchLogs();
}

elements.viewport.addEventListener('scroll', onScroll);
window.addEventListener('resize', onResize);
elements.searchInput.addEventListener('input', onSearchInput);
elements.severityFilter.addEventListener('change', onSeverityChange);

// Init
state.viewportHeight = elements.viewport.clientHeight;
fetchStats();
fetchLogs();
