const API_BASE = '/api';

const state = {
  severity: '',
  q: '',
  total: 0,
  rowHeight: 32,
  overscan: 8,
  visibleStart: 0,
  visibleEnd: 0,
  rows: new Map(), // offset -> row data
  fetchController: null,
  lastFetchId: 0,
  isLoading: false,
};

const container = document.getElementById('table-container');
const scroller = document.getElementById('scroller');
const severitySelect = document.getElementById('severity-filter');
const searchInput = document.getElementById('search-input');
const rowCountEl = document.getElementById('row-count');
const statsEl = document.getElementById('stats');

let debounceTimer = null;

function updateRowCount() {
  rowCountEl.textContent = `${state.rows.size} of ${state.total.toLocaleString()}`;
}

function updateStats(stats) {
  if (!stats) {
    statsEl.textContent = '';
    return;
  }
  const parts = Object.entries(stats.perSeverity).map(([k, v]) => `${k}:${v}`);
  statsEl.textContent = `Total: ${stats.total.toLocaleString()} | ${parts.join(' ')}`;
}

function createRowElement(row, top) {
  const el = document.createElement('div');
  el.className = `log-row severity-${row.severity}`;
  el.style.top = `${top}px`;
  el.style.height = `${state.rowHeight}px`;

  const ts = new Date(row.ts).toISOString().replace('T', ' ').slice(0, 19);
  el.innerHTML = `
    <div class="col col-ts">${ts}</div>
    <div class="col col-sev">${row.severity}</div>
    <div class="col col-service">${row.service}</div>
    <div class="col col-msg" title="${row.message}">${row.message}</div>
  `;
  return el;
}

function renderVisibleRows() {
  scroller.innerHTML = '';
  scroller.style.height = `${state.total * state.rowHeight}px`;

  if (state.total === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No logs match the current filters.';
    scroller.appendChild(empty);
    return;
  }

  const startIdx = Math.max(0, state.visibleStart - state.overscan);
  const endIdx = Math.min(state.total, state.visibleEnd + state.overscan);

  for (let i = startIdx; i < endIdx; i++) {
    const row = state.rows.get(i);
    if (row) {
      const top = i * state.rowHeight;
      const rowEl = createRowElement(row, top);
      scroller.appendChild(rowEl);
    }
  }
}

async function fetchWindow(offset, limit, signal) {
  const params = new URLSearchParams();
  params.set('offset', offset);
  params.set('limit', limit);
  if (state.severity) params.set('severity', state.severity);
  if (state.q) params.set('q', state.q);

  const res = await fetch(`${API_BASE}/logs?${params}`, { signal });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to fetch logs');
  }
  return res.json();
}

async function fetchStats() {
  try {
    const res = await fetch(`${API_BASE}/stats`);
    if (res.ok) {
      const stats = await res.json();
      updateStats(stats);
    }
  } catch (e) {
    console.warn('Stats fetch failed', e);
  }
}

async function loadData(reset = false) {
  if (state.fetchController) {
    state.fetchController.abort();
  }
  state.fetchController = new AbortController();
  const fetchId = ++state.lastFetchId;

  state.isLoading = true;

  try {
    // Fetch first window to get total and initial rows
    const windowSize = 100;
    const data = await fetchWindow(0, windowSize, state.fetchController.signal);

    if (fetchId !== state.lastFetchId) return; // stale

    state.total = data.total;
    state.rows.clear();

    data.rows.forEach((row, idx) => {
      state.rows.set(idx, row);
    });

    // If scrolled, fetch current visible window too
    if (!reset && state.visibleStart > 0) {
      const neededStart = Math.max(0, state.visibleStart - state.overscan);
      const neededEnd = Math.min(state.total, state.visibleEnd + state.overscan);
      const neededLimit = Math.min(200, neededEnd - neededStart);

      if (neededLimit > 0) {
        const moreData = await fetchWindow(neededStart, neededLimit, state.fetchController.signal);
        if (fetchId !== state.lastFetchId) return;

        moreData.rows.forEach((row, idx) => {
          state.rows.set(neededStart + idx, row);
        });
      }
    }

    renderVisibleRows();
    updateRowCount();

    if (reset) {
      container.scrollTop = 0;
      state.visibleStart = 0;
      state.visibleEnd = Math.ceil(container.clientHeight / state.rowHeight);
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error('Fetch error:', err);
      scroller.innerHTML = `<div class="empty">Error loading logs: ${err.message}</div>`;
    }
  } finally {
    state.isLoading = false;
  }
}

function onScroll() {
  const scrollTop = container.scrollTop;
  const viewportHeight = container.clientHeight;

  const newStart = Math.floor(scrollTop / state.rowHeight);
  const newEnd = Math.ceil((scrollTop + viewportHeight) / state.rowHeight);

  const startChanged = Math.abs(newStart - state.visibleStart) > 3;
  const endChanged = Math.abs(newEnd - state.visibleEnd) > 3;

  state.visibleStart = newStart;
  state.visibleEnd = newEnd;

  // Check if we need to fetch more data
  const needFetch = Array.from({ length: newEnd - newStart }, (_, i) => newStart + i)
    .some(i => i < state.total && !state.rows.has(i));

  if (needFetch || startChanged || endChanged) {
    // Debounce the actual fetch a bit for scroll
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      fetchVisibleWindow();
    }, 50);
  }

  renderVisibleRows();
}

async function fetchVisibleWindow() {
  if (state.fetchController) state.fetchController.abort();
  state.fetchController = new AbortController();
  const fetchId = ++state.lastFetchId;

  const start = Math.max(0, state.visibleStart - state.overscan);
  const end = Math.min(state.total, state.visibleEnd + state.overscan);
  const limit = Math.min(200, end - start);

  if (limit <= 0) return;

  try {
    const data = await fetchWindow(start, limit, state.fetchController.signal);
    if (fetchId !== state.lastFetchId) return;

    data.rows.forEach((row, idx) => {
      state.rows.set(start + idx, row);
    });

    renderVisibleRows();
    updateRowCount();
  } catch (err) {
    if (err.name !== 'AbortError') console.error(err);
  }
}

function applyFilters() {
  state.severity = severitySelect.value;
  state.q = searchInput.value.trim();
  state.rows.clear();
  state.visibleStart = 0;
  state.visibleEnd = Math.ceil(container.clientHeight / state.rowHeight) || 30;
  loadData(true);
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

  container.addEventListener('scroll', onScroll, { passive: true });

  // Initial viewport calc
  window.addEventListener('resize', () => {
    state.visibleEnd = Math.ceil(container.clientHeight / state.rowHeight) + state.visibleStart;
    renderVisibleRows();
  });
}

async function init() {
  setupEventListeners();

  // Initial viewport
  state.visibleEnd = Math.ceil(container.clientHeight / state.rowHeight) || 40;

  await loadData(true);
  await fetchStats();

  // Prefetch a bit more
  setTimeout(() => {
    if (state.total > 100) {
      fetchWindow(100, 50).then(d => {
        d.rows.forEach((row, idx) => state.rows.set(100 + idx, row));
      }).catch(() => {});
    }
  }, 500);
}

init();