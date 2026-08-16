import './styles.css';

const API = import.meta.env.VITE_API_BASE || '';
const ROW_HEIGHT = 34;
const OVERSCAN = 10;
const PAGE_LIMIT = 100;
const MAX_DOM_ROWS = 100;
const DEBOUNCE_MS = 220;

const app = document.querySelector('#app');
app.innerHTML = `
  <header class="topbar">
    <div>
      <h1>Log Explorer</h1>
      <p>100,000 deterministic service logs, queried in windows and rendered virtually.</p>
    </div>
    <div class="stats" id="stats">Loading…</div>
  </header>

  <section class="filters" aria-label="Log filters">
    <label>Severity
      <select id="severity">
        <option value="">All severities</option>
        <option value="debug">debug</option>
        <option value="info">info</option>
        <option value="warn">warn</option>
        <option value="error">error</option>
      </select>
    </label>
    <label class="searchLabel">Message contains
      <input id="search" type="search" placeholder="try timeout, cache, raretoken…" autocomplete="off" />
    </label>
    <div class="visibleCount" id="visibleCount">0 of 0</div>
  </section>

  <main class="tableShell">
    <div class="thead" role="row">
      <div>Timestamp</div><div>Severity</div><div>Service</div><div>Message</div>
    </div>
    <div id="scroller" class="scroller" tabindex="0">
      <div id="spacer" class="spacer"></div>
      <div id="rows" class="rows"></div>
      <div id="empty" class="empty" hidden>No logs match the active filters.</div>
      <div id="loading" class="loading">Loading…</div>
    </div>
  </main>
`;

const els = {
  stats: document.querySelector('#stats'),
  severity: document.querySelector('#severity'),
  search: document.querySelector('#search'),
  visibleCount: document.querySelector('#visibleCount'),
  scroller: document.querySelector('#scroller'),
  spacer: document.querySelector('#spacer'),
  rows: document.querySelector('#rows'),
  empty: document.querySelector('#empty'),
  loading: document.querySelector('#loading')
};

const state = {
  total: 0,
  rows: [],
  offset: 0,
  limit: PAGE_LIMIT,
  requestSeq: 0,
  controller: null,
  severity: '',
  q: '',
  debounce: null,
  lastRenderWindow: { start: -1, end: -1 }
};

function fmt(n) {
  return Number(n || 0).toLocaleString();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch]));
}

async function loadStats() {
  try {
    const stats = await fetch(`${API}/api/stats`).then((r) => r.json());
    const s = stats.severities || {};
    els.stats.innerHTML = `
      <span>Total <b>${fmt(stats.total)}</b></span>
      <span class="badge debug">debug ${fmt(s.debug)}</span>
      <span class="badge info">info ${fmt(s.info)}</span>
      <span class="badge warn">warn ${fmt(s.warn)}</span>
      <span class="badge error">error ${fmt(s.error)}</span>`;
  } catch {
    els.stats.textContent = 'API unavailable';
  }
}

function queryString(offset, limit) {
  const params = new URLSearchParams({ offset: String(offset), limit: String(limit) });
  if (state.severity) params.set('severity', state.severity);
  if (state.q) params.set('q', state.q);
  return params.toString();
}

async function fetchWindow(offset) {
  const seq = ++state.requestSeq;
  if (state.controller) state.controller.abort();
  state.controller = new AbortController();
  els.loading.hidden = false;

  try {
    const res = await fetch(`${API}/api/logs?${queryString(offset, PAGE_LIMIT)}`, { signal: state.controller.signal });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    if (seq !== state.requestSeq) return; // A stale response must never repaint newer results.
    state.total = data.total;
    state.offset = offset;
    state.rows = data.rows || [];
    state.lastRenderWindow = { start: -1, end: -1 };
    els.spacer.style.height = `${state.total * ROW_HEIGHT}px`;
    els.empty.hidden = state.total !== 0;
    els.loading.hidden = true;
    renderRows();
  } catch (err) {
    if (err.name === 'AbortError') return;
    if (seq === state.requestSeq) {
      els.loading.hidden = true;
      els.rows.innerHTML = `<div class="errorBox">${escapeHtml(err.message || 'Failed to load logs')}</div>`;
    }
  }
}

function neededWindow() {
  const firstVisible = Math.max(0, Math.floor(els.scroller.scrollTop / ROW_HEIGHT) - OVERSCAN);
  const visibleCount = Math.ceil(els.scroller.clientHeight / ROW_HEIGHT) + OVERSCAN * 2;
  const start = Math.min(firstVisible, Math.max(0, state.total - 1));
  const end = Math.min(state.total, start + Math.min(MAX_DOM_ROWS, visibleCount));
  return { start, end };
}

function ensureDataForViewport() {
  if (state.total === 0) return;
  const { start, end } = neededWindow();
  const bufferEnd = state.offset + state.rows.length;
  // Refetch when the viewport is outside, or too close to the edge of, the cached API window.
  if (start < state.offset || end > bufferEnd || start - state.offset < 15 || bufferEnd - end < 15) {
    const target = Math.max(0, Math.min(start, Math.max(0, state.total - PAGE_LIMIT)));
    if (target !== state.offset) fetchWindow(target);
  } else {
    renderRows();
  }
}

function renderRows() {
  const { start, end } = neededWindow();
  if (state.lastRenderWindow.start === start && state.lastRenderWindow.end === end && els.rows.childElementCount) return;
  state.lastRenderWindow = { start, end };

  const frag = document.createDocumentFragment();
  let rendered = 0;
  for (let idx = start; idx < end && rendered < MAX_DOM_ROWS; idx++) {
    const row = state.rows[idx - state.offset];
    if (!row) continue;
    const div = document.createElement('div');
    div.className = 'tr';
    div.style.transform = `translateY(${idx * ROW_HEIGHT}px)`;
    div.dataset.offset = String(idx);
    div.innerHTML = `
      <div class="mono" title="${escapeHtml(row.ts)}">${escapeHtml(row.ts.replace('T', ' ').replace('Z', ''))}</div>
      <div><span class="sev ${row.severity}">${row.severity}</span></div>
      <div>${escapeHtml(row.service)}</div>
      <div class="message">${escapeHtml(row.message)}</div>`;
    frag.appendChild(div);
    rendered++;
  }

  els.rows.replaceChildren(frag);
  const visStart = state.total ? Math.min(state.total, Math.floor(els.scroller.scrollTop / ROW_HEIGHT) + 1) : 0;
  const visEnd = Math.min(state.total, Math.ceil((els.scroller.scrollTop + els.scroller.clientHeight) / ROW_HEIGHT));
  els.visibleCount.textContent = `${fmt(visStart)}–${fmt(visEnd)} of ${fmt(state.total)} (${rendered} DOM rows)`;
}

let raf = 0;
els.scroller.addEventListener('scroll', () => {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    ensureDataForViewport();
  });
}, { passive: true });

function applyFilters() {
  clearTimeout(state.debounce);
  state.debounce = setTimeout(() => {
    state.severity = els.severity.value;
    state.q = els.search.value.trim();
    state.rows = [];
    state.offset = 0;
    state.lastRenderWindow = { start: -1, end: -1 };
    els.scroller.scrollTop = 0;
    els.rows.replaceChildren();
    fetchWindow(0);
  }, DEBOUNCE_MS);
}

els.severity.addEventListener('change', applyFilters);
els.search.addEventListener('input', applyFilters);
window.addEventListener('resize', renderRows);

loadStats();
fetchWindow(0);
