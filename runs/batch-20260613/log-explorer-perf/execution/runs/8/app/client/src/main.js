import './styles.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3000';
const ROW_HEIGHT = 38;
const LIMIT = 100;
const OVERSCAN = 14;
const MAX_DOM_ROWS = 100;

const els = {
  scroller: document.querySelector('#scroller'),
  spacer: document.querySelector('#spacer'),
  rows: document.querySelector('#rows'),
  severity: document.querySelector('#severity'),
  search: document.querySelector('#search'),
  clear: document.querySelector('#clear'),
  status: document.querySelector('#status'),
  badges: document.querySelector('#badges')
};

let total = 0;
let activeOffset = -1;
let visibleStart = 0;
let pendingController = null;
let requestSeq = 0;
let debounceTimer = null;
let lastRows = [];
let loadedOffset = 0;

const pools = [];

function setStatus(text, isError = false) {
  els.status.textContent = text;
  els.status.classList.toggle('error', isError);
}

function filters() {
  return {
    severity: els.severity.value,
    q: els.search.value.trim()
  };
}

function queryString(params) {
  const sp = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') sp.set(k, v);
  });
  return sp.toString();
}

function computeOffset() {
  const raw = Math.floor(els.scroller.scrollTop / ROW_HEIGHT) - OVERSCAN;
  return Math.max(0, Math.min(Math.max(0, total - 1), raw));
}

function visibleCount() {
  return Math.ceil(els.scroller.clientHeight / ROW_HEIGHT) + OVERSCAN * 2;
}

function ensurePool(count) {
  while (pools.length < count) {
    const row = document.createElement('div');
    row.className = 'logRow';
    row.setAttribute('role', 'row');
    row.innerHTML = '<div class="ts"></div><div class="severity"></div><div class="service"></div><div class="message"></div>';
    pools.push(row);
    els.rows.appendChild(row);
  }
  for (let i = 0; i < pools.length; i++) {
    pools[i].style.display = i < count ? 'grid' : 'none';
  }
}

function renderRows(rows, offset) {
  lastRows = rows;
  loadedOffset = offset;
  const renderCount = Math.min(rows.length, MAX_DOM_ROWS, visibleCount());
  ensurePool(renderCount);
  els.rows.style.transform = `translateY(${offset * ROW_HEIGHT}px)`;

  for (let i = 0; i < renderCount; i++) {
    const row = rows[i];
    const el = pools[i];
    el.dataset.index = String(offset + i);
    el.dataset.id = row.id;
    el.querySelector('.ts').textContent = new Date(row.ts).toISOString().replace('T', ' ').replace('.000Z', 'Z');
    const sev = el.querySelector('.severity');
    sev.textContent = row.severity;
    sev.className = `severity sev-${row.severity}`;
    el.querySelector('.service').textContent = row.service;
    el.querySelector('.message').textContent = row.message;
  }
  setStatus(`${Math.min(total, offset + renderCount).toLocaleString()} of ${total.toLocaleString()} · DOM rows ${renderCount}`);
}

function renderEmpty() {
  total = 0;
  activeOffset = -1;
  lastRows = [];
  els.spacer.style.height = '0px';
  ensurePool(0);
  setStatus('0 of 0');
}

async function fetchLogs(offset, resetScroll = false) {
  if (pendingController) pendingController.abort();
  pendingController = new AbortController();
  const seq = ++requestSeq;
  const f = filters();
  const qs = queryString({ offset, limit: LIMIT, severity: f.severity, q: f.q });
  setStatus('Loading…');
  try {
    const res = await fetch(`${API_BASE}/api/logs?${qs}`, { signal: pendingController.signal });
    if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
    const payload = await res.json();
    if (seq !== requestSeq) return; // stale response; ignore
    total = payload.total;
    els.spacer.style.height = `${Math.max(0, total * ROW_HEIGHT)}px`;
    if (resetScroll) els.scroller.scrollTop = 0;
    activeOffset = offset;
    if (!payload.rows.length) {
      renderEmpty();
      return;
    }
    renderRows(payload.rows, offset);
  } catch (err) {
    if (err.name === 'AbortError') return;
    setStatus(err.message, true);
  }
}

function scheduleForScroll() {
  if (!total && activeOffset !== -1) return;
  const next = computeOffset();
  visibleStart = Math.floor(els.scroller.scrollTop / ROW_HEIGHT);
  // Fetch a new server window when the viewport nears either edge of the loaded window.
  const lowWater = loadedOffset + OVERSCAN / 2;
  const highWater = loadedOffset + Math.max(0, lastRows.length - visibleCount() - OVERSCAN / 2);
  if (activeOffset < 0 || visibleStart < lowWater || visibleStart > highWater) {
    if (next !== activeOffset) fetchLogs(next);
  }
}

function debounceReload() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => fetchLogs(0, true), 250);
}

async function loadStats() {
  try {
    const res = await fetch(`${API_BASE}/api/stats`);
    const stats = await res.json();
    const order = ['debug', 'info', 'warn', 'error'];
    els.badges.innerHTML = `<span class="badge all">all ${stats.total.toLocaleString()}</span>` +
      order.map(s => `<span class="badge sev-${s}">${s} ${Number(stats.severities[s] || 0).toLocaleString()}</span>`).join('');
  } catch {
    els.badges.textContent = 'stats unavailable';
  }
}

let raf = 0;
els.scroller.addEventListener('scroll', () => {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    scheduleForScroll();
  });
});

els.severity.addEventListener('change', () => fetchLogs(0, true));
els.search.addEventListener('input', debounceReload);
els.clear.addEventListener('click', () => {
  els.search.value = '';
  els.severity.value = '';
  fetchLogs(0, true);
});

window.addEventListener('resize', () => {
  if (lastRows.length) renderRows(lastRows, loadedOffset);
  scheduleForScroll();
});

loadStats();
fetchLogs(0, true);
