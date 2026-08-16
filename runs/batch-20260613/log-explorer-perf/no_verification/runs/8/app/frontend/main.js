const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3000';
const ROW_HEIGHT = 36;
const OVERSCAN = 12;
const HARD_ROW_LIMIT = 200;

const scroller = document.getElementById('scroller');
const spacer = document.getElementById('spacer');
const rowsEl = document.getElementById('rows');
const severityEl = document.getElementById('severity');
const searchEl = document.getElementById('search');
const statusEl = document.getElementById('status');
const badgesEl = document.getElementById('badges');
const visibleCountEl = document.getElementById('visibleCount');

const state = {
  total: 0,
  offset: 0,
  rows: [],
  severity: '',
  q: '',
  requestSeq: 0,
  abortController: null,
  raf: 0,
  debounceTimer: 0
};

function fmt(n) { return Number(n || 0).toLocaleString(); }

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', isError);
}

function apiUrl(path, params = {}) {
  const url = new URL(path, API_BASE);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
  }
  return url;
}

async function loadStats() {
  try {
    const res = await fetch(apiUrl('/api/stats'));
    if (!res.ok) throw new Error(`stats ${res.status}`);
    const stats = await res.json();
    const sev = stats.severities || {};
    badgesEl.innerHTML = ['debug', 'info', 'warn', 'error']
      .map(s => `<span class="badge ${s}">${s}: ${fmt(sev[s])}</span>`)
      .join('');
  } catch (err) {
    console.warn(err);
    badgesEl.innerHTML = '<span class="badge">stats unavailable</span>';
  }
}

function computeWindow() {
  const firstVisible = Math.max(0, Math.floor(scroller.scrollTop / ROW_HEIGHT));
  const visibleRows = Math.ceil(scroller.clientHeight / ROW_HEIGHT);
  const offset = Math.max(0, firstVisible - OVERSCAN);
  const limit = Math.min(HARD_ROW_LIMIT, visibleRows + OVERSCAN * 2);
  return { offset, limit };
}

function scheduleWindowLoad() {
  if (state.raf) return;
  state.raf = requestAnimationFrame(() => {
    state.raf = 0;
    const { offset, limit } = computeWindow();
    const loadedStart = state.offset;
    const loadedEnd = state.offset + state.rows.length;
    const neededEnd = offset + limit;
    if (offset >= loadedStart && neededEnd <= loadedEnd && state.rows.length > 0) {
      renderRows();
      return;
    }
    fetchWindow(offset, limit);
  });
}

async function fetchWindow(offset = 0, limit = computeWindow().limit) {
  const seq = ++state.requestSeq;
  if (state.abortController) state.abortController.abort();
  const controller = new AbortController();
  state.abortController = controller;
  setStatus('Loading window…');

  try {
    const res = await fetch(apiUrl('/api/logs', {
      offset,
      limit,
      severity: state.severity,
      q: state.q
    }), { signal: controller.signal });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `request failed (${res.status})`);
    }
    const data = await res.json();
    if (seq !== state.requestSeq) return; // stale response: ignored
    state.total = data.total;
    state.offset = offset;
    state.rows = data.rows || [];
    spacer.style.height = `${state.total * ROW_HEIGHT}px`;
    renderRows();
    setStatus(`Ready · ${fmt(state.total)} matching rows`);
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error(err);
    if (seq === state.requestSeq) {
      rowsEl.innerHTML = `<div class="empty">${escapeHtml(err.message)}</div>`;
      setStatus(err.message, true);
    }
  }
}

function renderRows() {
  const firstVisible = Math.floor(scroller.scrollTop / ROW_HEIGHT);
  const lastVisible = Math.min(state.total, firstVisible + Math.ceil(scroller.clientHeight / ROW_HEIGHT));
  visibleCountEl.textContent = `${fmt(Math.max(0, lastVisible - firstVisible))} of ${fmt(state.total)}`;

  if (state.total === 0) {
    rowsEl.innerHTML = '<div class="empty">No logs match the active filters.</div>';
    return;
  }

  const html = state.rows.map((row, idx) => {
    const absoluteIndex = state.offset + idx;
    const top = absoluteIndex * ROW_HEIGHT;
    return `<div class="log-row" data-offset="${absoluteIndex}" style="transform: translateY(${top}px)">
      <div class="ts">${escapeHtml(formatTs(row.ts))}</div>
      <div><span class="severity sev-${row.severity}">${escapeHtml(row.severity)}</span></div>
      <div class="service">${escapeHtml(row.service)}</div>
      <div class="message" title="${escapeHtml(row.message)}">${escapeHtml(row.message)}</div>
    </div>`;
  }).join('');
  rowsEl.innerHTML = html || '<div class="loading">Loading…</div>';
}

function formatTs(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toISOString().replace('T', ' ').replace('Z', ' UTC');
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function resetAndLoad() {
  state.severity = severityEl.value;
  state.q = searchEl.value.trim();
  state.rows = [];
  state.offset = 0;
  state.total = 0;
  spacer.style.height = '0px';
  scroller.scrollTop = 0;
  fetchWindow(0, computeWindow().limit);
}

severityEl.addEventListener('change', resetAndLoad);
searchEl.addEventListener('input', () => {
  clearTimeout(state.debounceTimer);
  state.debounceTimer = setTimeout(resetAndLoad, 180);
});
scroller.addEventListener('scroll', scheduleWindowLoad, { passive: true });
window.addEventListener('resize', scheduleWindowLoad);

loadStats();
fetchWindow(0, computeWindow().limit);
