import './styles.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3000';
const ROW_HEIGHT = 34;
const OVERSCAN = 12;
const MAX_CLIENT_WINDOW = 100;
const SEARCH_DEBOUNCE_MS = 250;

const scroller = document.querySelector('#scroller');
const spacer = document.querySelector('#spacer');
const rowsLayer = document.querySelector('#rows');
const severityFilter = document.querySelector('#severityFilter');
const searchBox = document.querySelector('#searchBox');
const statsEl = document.querySelector('#stats');
const visibleCountEl = document.querySelector('#visibleCount');
const windowInfoEl = document.querySelector('#windowInfo');
const connectionEl = document.querySelector('#connection');

const state = {
  total: 0,
  rows: new Map(),
  windowStart: 0,
  windowLimit: 0,
  loading: false,
  severity: '',
  q: '',
  requestSeq: 0,
  abortController: null,
  renderScheduled: false,
};

function apiUrl(path, params = {}) {
  const url = new URL(path, API_BASE);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
  }
  return url.toString();
}

function setConnection(status, className = '') {
  connectionEl.textContent = status;
  connectionEl.className = `connection ${className}`.trim();
}

function formatTimestamp(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toISOString().replace('T', ' ').replace('.000Z', 'Z');
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
  })[char]);
}

function computeWindow() {
  const viewportRows = Math.ceil(scroller.clientHeight / ROW_HEIGHT) || 1;
  const rawStart = Math.max(0, Math.floor(scroller.scrollTop / ROW_HEIGHT) - OVERSCAN);
  const limit = Math.min(MAX_CLIENT_WINDOW, state.total - rawStart, viewportRows + OVERSCAN * 2);
  return { start: rawStart, limit: Math.max(0, limit) };
}

function renderPlaceholder(index) {
  const row = document.createElement('div');
  row.className = 'logRow placeholder';
  row.style.transform = `translateY(${index * ROW_HEIGHT}px)`;
  row.innerHTML = `<div>loading…</div><div></div><div></div><div>offset ${index}</div>`;
  return row;
}

function renderLogRow(index, log) {
  const row = document.createElement('div');
  row.className = 'logRow';
  row.dataset.offset = String(index);
  row.dataset.logId = String(log.id);
  row.style.transform = `translateY(${index * ROW_HEIGHT}px)`;
  row.innerHTML = `
    <div title="${escapeHtml(formatTimestamp(log.ts))}">${escapeHtml(formatTimestamp(log.ts))}</div>
    <div><span class="severity severity-${escapeHtml(log.severity)}">${escapeHtml(log.severity)}</span></div>
    <div title="${escapeHtml(log.service)}">${escapeHtml(log.service)}</div>
    <div title="${escapeHtml(log.message)}">${escapeHtml(log.message)}</div>
  `;
  return row;
}

function render() {
  state.renderScheduled = false;
  const { start, limit } = computeWindow();

  if (start !== state.windowStart || limit !== state.windowLimit) {
    fetchWindow(start, limit);
  }

  const fragment = document.createDocumentFragment();
  let materialized = 0;
  for (let i = start; i < start + limit; i += 1) {
    const log = state.rows.get(i);
    fragment.appendChild(log ? renderLogRow(i, log) : renderPlaceholder(i));
    materialized += 1;
  }
  rowsLayer.replaceChildren(fragment);
  visibleCountEl.textContent = `${Math.min(materialized, state.total).toLocaleString()} of ${state.total.toLocaleString()}`;
  windowInfoEl.textContent = state.total
    ? `offsets ${start.toLocaleString()}–${Math.max(start, start + limit - 1).toLocaleString()}`
    : 'no rows match the active filters';
}

function scheduleRender() {
  if (state.renderScheduled) return;
  state.renderScheduled = true;
  requestAnimationFrame(render);
}

async function fetchWindow(start, limit) {
  if (limit <= 0) {
    state.windowStart = start;
    state.windowLimit = 0;
    rowsLayer.replaceChildren();
    return;
  }

  state.windowStart = start;
  state.windowLimit = limit;

  if (state.abortController) state.abortController.abort();
  const controller = new AbortController();
  const seq = ++state.requestSeq;
  state.abortController = controller;
  state.loading = true;
  setConnection('loading window…');

  try {
    const url = apiUrl('/api/logs', {
      offset: start,
      limit,
      severity: state.severity,
      q: state.q,
    });
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(await response.text());
    const payload = await response.json();

    // Stale responses are ignored, so an older slow request cannot overwrite a
    // newer filter or scroll position.
    if (seq !== state.requestSeq) return;

    state.total = payload.total;
    spacer.style.height = `${state.total * ROW_HEIGHT}px`;
    state.rows.clear();
    payload.rows.forEach((row, i) => state.rows.set(start + i, row));
    setConnection(`ready (${response.headers.get('x-query-time-ms') || '?'} ms)`, 'ok');
    scheduleRender();
  } catch (err) {
    if (err.name === 'AbortError') return;
    setConnection('request failed', 'error');
    console.error(err);
  } finally {
    if (seq === state.requestSeq) state.loading = false;
  }
}

async function loadStats() {
  try {
    const response = await fetch(apiUrl('/api/stats'));
    if (!response.ok) throw new Error(await response.text());
    const stats = await response.json();
    statsEl.innerHTML = `
      <span class="badge">all ${stats.total.toLocaleString()}</span>
      <span class="badge">debug ${stats.severities.debug.toLocaleString()}</span>
      <span class="badge">info ${stats.severities.info.toLocaleString()}</span>
      <span class="badge">warn ${stats.severities.warn.toLocaleString()}</span>
      <span class="badge">error ${stats.severities.error.toLocaleString()}</span>
    `;
  } catch (err) {
    statsEl.textContent = 'stats unavailable';
    console.error(err);
  }
}

function initialWindowLimit() {
  return Math.min(MAX_CLIENT_WINDOW, Math.ceil(scroller.clientHeight / ROW_HEIGHT) + OVERSCAN * 2);
}

function resetAndFetch() {
  state.severity = severityFilter.value;
  state.q = searchBox.value.trim();
  state.rows.clear();
  state.windowStart = -1;
  state.windowLimit = -1;
  scroller.scrollTop = 0;
  state.total = 0;
  spacer.style.height = '0px';
  rowsLayer.replaceChildren(renderPlaceholder(0));
  fetchWindow(0, initialWindowLimit());
}

let searchTimer = null;
searchBox.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(resetAndFetch, SEARCH_DEBOUNCE_MS);
});

severityFilter.addEventListener('change', resetAndFetch);
scroller.addEventListener('scroll', scheduleRender, { passive: true });
window.addEventListener('resize', scheduleRender);

async function boot() {
  setConnection('connecting…');
  await loadStats();
  state.windowStart = -1;
  state.windowLimit = -1;
  await fetchWindow(0, initialWindowLimit());
}

boot().catch((err) => {
  setConnection('startup failed', 'error');
  console.error(err);
});
