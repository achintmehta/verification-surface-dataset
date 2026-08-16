/**
 * Log Explorer - Virtualized Frontend
 *
 * Architecture:
 * - Virtual scroller: only visible rows + overscan exist in DOM
 * - Debounced search with stale-response cancellation
 * - Server-side filtering and windowing
 */

const API_BASE = 'http://localhost:3001';
const ROW_HEIGHT = 36;        // px, must match CSS --row-height
const OVERSCAN = 8;           // extra rows above/below viewport
const FETCH_LIMIT = 150;      // rows per API request (max 200)
const DEBOUNCE_MS = 250;      // search debounce delay

// ===== State =====
const state = {
  total: 0,
  severity: '',
  query: '',
  scrollTop: 0,
  containerHeight: 0,
  // Current window of fetched rows
  fetchedOffset: -1,
  fetchedRows: [],
  // Pending fetch tracking (for stale response cancellation)
  fetchSeq: 0,
  isFetching: false,
  // Stats
  stats: null,
};

// ===== DOM References =====
const scrollContainer = document.getElementById('scroll-container');
const scrollSpacer    = document.getElementById('scroll-spacer');
const virtualRows     = document.getElementById('virtual-rows');
const severityFilter  = document.getElementById('severity-filter');
const searchInput     = document.getElementById('search-input');
const searchClear     = document.getElementById('search-clear');
const resultCount     = document.getElementById('result-count');
const emptyState      = document.getElementById('empty-state');
const loadingOverlay  = document.getElementById('loading-overlay');
const severityBadges  = document.getElementById('severity-badges');

// ===== Row Pool =====
const rowPool = [];

function getRowElement() {
  if (rowPool.length > 0) return rowPool.pop();
  const el = document.createElement('div');
  el.className = 'log-row';
  el.innerHTML =
    '<div class="col-ts"></div>' +
    '<div class="col-severity"><span class="severity-pill"></span></div>' +
    '<div class="col-service"></div>' +
    '<div class="col-message"></div>';
  return el;
}

function recycleRowElement(el) {
  if (el.parentNode) el.parentNode.removeChild(el);
  rowPool.push(el);
}

// ===== Timestamp Formatting =====
function formatTs(raw) {
  if (!raw) return '';
  try {
    let s = typeof raw === 'string' ? raw.trim() : String(raw);
    // Replace space separator with T
    if (s.includes(' ') && !s.includes('T')) s = s.replace(' ', 'T');
    // Append Z if no timezone info present
    if (!s.endsWith('Z') && !/[+-]\d{2}:\d{2}$/.test(s)) s += 'Z';
    const d = new Date(s);
    if (isNaN(d.getTime())) return raw;
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth()+1)}-${p(d.getUTCDate())} ` +
           `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
  } catch {
    return String(raw);
  }
}

// ===== Virtual Scroller =====
// activeRows: Map<rowIndex, DOMElement>
const activeRows = new Map();

function updateVirtualScroller() {
  const { total, scrollTop, containerHeight, fetchedOffset, fetchedRows } = state;

  // The spacer defines the total scrollable height
  scrollSpacer.style.height = (total * ROW_HEIGHT) + 'px';

  if (total === 0) {
    for (const [, el] of activeRows) recycleRowElement(el);
    activeRows.clear();
    return;
  }

  // Visible row index range (with overscan)
  const firstVisible = Math.floor(scrollTop / ROW_HEIGHT);
  const visibleCount = Math.ceil(containerHeight / ROW_HEIGHT);
  const firstRow = Math.max(0, firstVisible - OVERSCAN);
  const lastRow  = Math.min(total - 1, firstVisible + visibleCount + OVERSCAN);

  // Recycle rows that scrolled out of range
  for (const [idx, el] of activeRows) {
    if (idx < firstRow || idx > lastRow) {
      recycleRowElement(el);
      activeRows.delete(idx);
    }
  }

  // Create/update rows in range
  // Since virtual-rows is sticky at top:0, row positions are relative to viewport top
  // So top = (rowIndex * ROW_HEIGHT) - scrollTop
  for (let i = firstRow; i <= lastRow; i++) {
    const localIdx = i - fetchedOffset;
    const rowData = (fetchedOffset >= 0 && localIdx >= 0 && localIdx < fetchedRows.length)
      ? fetchedRows[localIdx]
      : null;

    const topPx = (i * ROW_HEIGHT) - scrollTop;

    if (!activeRows.has(i)) {
      const el = getRowElement();
      el.style.top = topPx + 'px';
      fillRow(el, rowData);
      virtualRows.appendChild(el);
      activeRows.set(i, el);
    } else {
      const el = activeRows.get(i);
      el.style.top = topPx + 'px';
      fillRow(el, rowData);
    }
  }
}

function fillRow(el, data) {
  if (!data) {
    el.className = 'log-row';
    el.querySelector('.col-ts').textContent = '—';
    const pill = el.querySelector('.severity-pill');
    pill.textContent = '';
    pill.className = 'severity-pill';
    el.querySelector('.col-service').textContent = '';
    el.querySelector('.col-message').textContent = '';
    return;
  }
  const sev = data.severity || 'info';
  el.className = `log-row ${sev}`;
  el.querySelector('.col-ts').textContent = formatTs(data.ts);
  const pill = el.querySelector('.severity-pill');
  pill.textContent = sev.toUpperCase();
  pill.className = `severity-pill ${sev}`;
  el.querySelector('.col-service').textContent = data.service || '';
  el.querySelector('.col-message').textContent = data.message || '';
}

// ===== Fetch Logic =====
async function fetchWindow(offset) {
  const params = new URLSearchParams({
    offset: String(offset),
    limit:  String(FETCH_LIMIT),
  });
  if (state.severity) params.set('severity', state.severity);
  if (state.query)    params.set('q', state.query);

  const resp = await fetch(`${API_BASE}/api/logs?${params}`);
  if (!resp.ok) throw new Error(`API ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

function computeFetchOffset() {
  const { scrollTop, containerHeight, total } = state;
  const firstVisible = Math.floor(scrollTop / ROW_HEIGHT);
  const visibleCount = Math.ceil(containerHeight / ROW_HEIGHT);
  // Center the fetch window around the visible area
  const center = firstVisible + Math.floor(visibleCount / 2);
  const half   = Math.floor(FETCH_LIMIT / 2);
  return Math.max(0, Math.min(total - FETCH_LIMIT, center - half));
}

function isCoverageAdequate() {
  const { scrollTop, containerHeight, fetchedOffset, fetchedRows, total } = state;
  if (fetchedRows.length === 0 || fetchedOffset < 0) return false;
  const firstNeed = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const lastNeed  = Math.min(total - 1, Math.ceil((scrollTop + containerHeight) / ROW_HEIGHT) + OVERSCAN);
  return firstNeed >= fetchedOffset && lastNeed < fetchedOffset + fetchedRows.length;
}

async function maybeFetch() {
  if (isCoverageAdequate()) {
    updateVirtualScroller();
    return;
  }

  const offset = computeFetchOffset();
  const seq    = ++state.fetchSeq;
  state.isFetching = true;

  // Show loading overlay only on initial/filter-change loads
  if (state.fetchedRows.length === 0) showLoading(true);

  let result;
  try {
    result = await fetchWindow(offset);
  } catch (err) {
    console.error('Fetch error:', err);
    if (seq === state.fetchSeq) {
      state.isFetching = false;
      showLoading(false);
    }
    return;
  }

  // Discard stale responses
  if (seq !== state.fetchSeq) return;

  state.isFetching   = false;
  state.total        = result.total;
  state.fetchedOffset = offset;
  state.fetchedRows  = result.rows;

  showLoading(false);
  updateResultCount();
  updateEmptyState();
  updateVirtualScroller();
}

// ===== Stats =====
async function fetchStats() {
  try {
    const resp = await fetch(`${API_BASE}/api/stats`);
    if (!resp.ok) return;
    const data = await resp.json();
    state.stats = data;
    renderStats(data);
  } catch (err) {
    console.error('Stats fetch error:', err);
  }
}

function renderStats(data) {
  const statTotal = document.getElementById('stat-total');
  if (statTotal) statTotal.textContent = `${data.total.toLocaleString()} total logs`;

  const severities = ['error', 'warn', 'info', 'debug'];
  severityBadges.innerHTML = '';
  for (const sev of severities) {
    const count = data.bySeverity[sev] || 0;
    const badge = document.createElement('span');
    badge.className = `sev-badge ${sev}`;
    badge.textContent = `${sev}  ${count.toLocaleString()}`;
    badge.title = `Click to filter by ${sev}`;
    badge.addEventListener('click', () => {
      const newSev = state.severity === sev ? '' : sev;
      severityFilter.value = newSev;
      onSeverityChange(newSev);
    });
    severityBadges.appendChild(badge);
  }
}

// ===== UI Updates =====
function updateResultCount() {
  const { total, severity, query } = state;
  const hasFilter = severity || query;
  if (hasFilter) {
    resultCount.innerHTML = `<strong>${total.toLocaleString()}</strong> matching`;
  } else {
    resultCount.innerHTML = `<strong>${total.toLocaleString()}</strong> rows`;
  }
}

function updateEmptyState() {
  const show = state.total === 0 && !state.isFetching;
  emptyState.style.display      = show ? 'flex' : 'none';
  scrollContainer.style.display = show ? 'none' : '';
}

function showLoading(show) {
  loadingOverlay.style.display = show ? 'flex' : 'none';
}

// ===== Filter Handlers =====
function resetAndFetch() {
  state.fetchSeq++;           // invalidate in-flight requests
  scrollContainer.scrollTop = 0;
  state.scrollTop    = 0;
  state.fetchedOffset = -1;
  state.fetchedRows  = [];
  state.total        = 0;

  for (const [, el] of activeRows) recycleRowElement(el);
  activeRows.clear();

  updateResultCount();
  maybeFetch();
}

function onSeverityChange(value) {
  state.severity = value;
  severityFilter.value = value;
  resetAndFetch();
}

function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

const debouncedSearch = debounce((value) => {
  state.query = value;
  resetAndFetch();
}, DEBOUNCE_MS);

// ===== Scroll Handler =====
let scrollRafId = null;

function onScroll() {
  state.scrollTop = scrollContainer.scrollTop;
  if (scrollRafId) cancelAnimationFrame(scrollRafId);
  scrollRafId = requestAnimationFrame(() => {
    scrollRafId = null;
    maybeFetch();
  });
}

// ===== Resize Handler =====
function onResize() {
  state.containerHeight = scrollContainer.clientHeight;
  updateVirtualScroller();
}

// ===== Init =====
async function init() {
  state.containerHeight = scrollContainer.clientHeight;

  scrollContainer.addEventListener('scroll', onScroll, { passive: true });

  severityFilter.addEventListener('change', (e) => onSeverityChange(e.target.value));

  searchInput.addEventListener('input', (e) => {
    const val = e.target.value;
    searchClear.style.display = val ? 'block' : 'none';
    debouncedSearch(val);
  });

  searchClear.addEventListener('click', () => {
    searchInput.value = '';
    searchClear.style.display = 'none';
    state.query = '';
    resetAndFetch();
  });

  window.addEventListener('resize', debounce(onResize, 100));

  showLoading(true);
  await fetchStats();
  await maybeFetch();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
