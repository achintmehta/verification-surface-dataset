import './styles.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3000';
const ROW_HEIGHT = 34;
const PAGE_SIZE = 100;
const SERVER_LIMIT = 200;
const OVERSCAN = 10;
const MAX_DOM_ROWS = 100;

const els = {
  severity: document.getElementById('severity'),
  search: document.getElementById('search'),
  badges: document.getElementById('badges'),
  rowCount: document.getElementById('rowCount'),
  scroller: document.getElementById('scroller'),
  spacer: document.getElementById('spacer'),
  rows: document.getElementById('rows'),
  empty: document.getElementById('empty'),
};

const state = {
  total: 0,
  rows: [],
  windowOffset: 0,
  filters: { severity: '', q: '' },
  requestSeq: 0,
  controller: null,
  loading: false,
};

let debounceTimer = 0;
let raf = 0;
const rowPool = [];

function qs(params) {
  const u = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== '' && v !== undefined && v !== null) u.set(k, String(v));
  });
  return u.toString();
}

function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }

function visibleCapacity() {
  return Math.ceil(els.scroller.clientHeight / ROW_HEIGHT) || 20;
}

function desiredOffset() {
  const firstVisible = Math.floor(els.scroller.scrollTop / ROW_HEIGHT);
  const target = clamp(firstVisible - OVERSCAN, 0, Math.max(0, state.total - PAGE_SIZE));
  return target;
}

function ensurePool(size) {
  while (rowPool.length < size) {
    const row = document.createElement('div');
    row.className = 'logRow';
    row.setAttribute('role', 'row');
    row.innerHTML = '<div class="ts"></div><div class="sev"></div><div class="svc"></div><div class="msg"></div>';
    els.rows.appendChild(row);
    rowPool.push(row);
  }
  for (let i = 0; i < rowPool.length; i++) rowPool[i].style.display = i < size ? 'grid' : 'none';
}

function formatTs(ts) {
  return new Date(ts).toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function renderRows() {
  els.spacer.style.height = `${state.total * ROW_HEIGHT}px`;
  els.empty.classList.toggle('hidden', state.total !== 0 || state.loading);

  const viewportFirst = Math.floor(els.scroller.scrollTop / ROW_HEIGHT);
  const start = clamp(viewportFirst - OVERSCAN, state.windowOffset, state.windowOffset + state.rows.length);
  const end = clamp(viewportFirst + visibleCapacity() + OVERSCAN, start, state.windowOffset + state.rows.length);
  const count = Math.min(MAX_DOM_ROWS, Math.max(0, end - start));
  ensurePool(count);
  els.rows.style.transform = `translateY(${start * ROW_HEIGHT}px)`;

  for (let i = 0; i < count; i++) {
    const absoluteIndex = start + i;
    const log = state.rows[absoluteIndex - state.windowOffset];
    const row = rowPool[i];
    if (!log) { row.style.visibility = 'hidden'; continue; }
    row.style.visibility = 'visible';
    row.dataset.index = String(absoluteIndex);
    row.dataset.id = String(log.id);
    row.children[0].textContent = formatTs(log.ts);
    row.children[1].textContent = log.severity.toUpperCase();
    row.children[1].className = `sev sev-${log.severity}`;
    row.children[2].textContent = log.service;
    row.children[3].textContent = log.message;
  }
  updateRowCount(viewportFirst, count);
}

function updateRowCount(firstVisible = Math.floor(els.scroller.scrollTop / ROW_HEIGHT), rendered = rowPool.filter(r => r.style.display !== 'none').length) {
  const from = state.total ? clamp(firstVisible + 1, 1, state.total) : 0;
  const to = state.total ? clamp(firstVisible + visibleCapacity(), 1, state.total) : 0;
  els.rowCount.textContent = `${rendered} DOM rows • showing ${from}-${to} of ${state.total.toLocaleString()}`;
}

async function loadWindow(offset = desiredOffset()) {
  offset = clamp(offset, 0, Math.max(0, state.total - PAGE_SIZE));
  if (state.controller) state.controller.abort();
  const seq = ++state.requestSeq;
  const controller = new AbortController();
  state.controller = controller;
  state.loading = true;
  updateRowCount();
  const query = qs({ offset, limit: PAGE_SIZE, severity: state.filters.severity, q: state.filters.q });
  try {
    const res = await fetch(`${API_BASE}/api/logs?${query}`, { signal: controller.signal });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    if (seq !== state.requestSeq) return;
    state.total = data.total;
    state.rows = data.rows;
    state.windowOffset = offset;
    state.loading = false;
    state.spacerHeight = state.total * ROW_HEIGHT;
    renderRows();
  } catch (err) {
    if (err.name === 'AbortError') return;
    if (seq !== state.requestSeq) return;
    state.loading = false;
    els.rowCount.textContent = `Error loading logs: ${err.message}`;
  }
}

function windowCoversViewport() {
  const first = Math.floor(els.scroller.scrollTop / ROW_HEIGHT);
  const last = first + visibleCapacity();
  return first >= state.windowOffset + OVERSCAN / 2 && last <= state.windowOffset + state.rows.length - OVERSCAN / 2;
}

function onScroll() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    if (!windowCoversViewport()) loadWindow(desiredOffset());
    else renderRows();
  });
}

function resetAndLoad() {
  state.filters.severity = els.severity.value;
  state.filters.q = els.search.value.trim();
  state.rows = [];
  state.windowOffset = 0;
  state.total = 0;
  els.scroller.scrollTop = 0;
  renderRows();
  loadWindow(0);
}

async function loadStats() {
  try {
    const res = await fetch(`${API_BASE}/api/stats`);
    const stats = await res.json();
    els.badges.innerHTML = '';
    const all = document.createElement('span');
    all.className = 'badge';
    all.textContent = `all ${stats.total.toLocaleString()}`;
    els.badges.appendChild(all);
    for (const sev of ['debug', 'info', 'warn', 'error']) {
      const b = document.createElement('span');
      b.className = `badge sev-${sev}`;
      b.textContent = `${sev} ${Number(stats.severities[sev]).toLocaleString()}`;
      els.badges.appendChild(b);
    }
  } catch {
    els.badges.textContent = 'stats unavailable';
  }
}

els.scroller.addEventListener('scroll', onScroll, { passive: true });
els.severity.addEventListener('change', resetAndLoad);
els.search.addEventListener('input', () => {
  window.clearTimeout(debounceTimer);
  debounceTimer = window.setTimeout(resetAndLoad, 250);
});
window.addEventListener('resize', () => renderRows());

ensurePool(0);
loadStats();
loadWindow(0);
