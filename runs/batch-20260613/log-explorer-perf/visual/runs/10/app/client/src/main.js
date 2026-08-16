import './styles.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3000';
const rowHeight = 34;
const overscan = 12;
const serverLimit = 120;
const maxRenderedRows = 96;

const els = {
  severity: document.querySelector('#severity'),
  search: document.querySelector('#search'),
  badges: document.querySelector('#badges'),
  status: document.querySelector('#status'),
  scroller: document.querySelector('#scroller'),
  spacer: document.querySelector('#spacer'),
  rows: document.querySelector('#rows')
};

let state = {
  total: 0,
  rows: [],
  windowStart: 0,
  desiredStart: 0,
  severity: '',
  q: '',
  requestSeq: 0,
  abort: null,
  loading: false,
  firstLoad: true
};

function fmtInt(n) {
  return Number(n || 0).toLocaleString();
}

function setStatus(text, loading = false) {
  els.status.textContent = text;
  els.status.classList.toggle('loading', loading);
}

async function loadStats() {
  try {
    const res = await fetch(`${API_BASE}/api/stats`);
    if (!res.ok) throw new Error(`stats ${res.status}`);
    const data = await res.json();
    const s = data.severities || {};
    els.badges.innerHTML = `
      <span class="badge all">All ${fmtInt(data.total)}</span>
      <span class="badge debug">Debug ${fmtInt(s.debug)}</span>
      <span class="badge info">Info ${fmtInt(s.info)}</span>
      <span class="badge warn">Warn ${fmtInt(s.warn)}</span>
      <span class="badge error">Error ${fmtInt(s.error)}</span>
    `;
  } catch (err) {
    console.warn(err);
    els.badges.textContent = 'Stats unavailable';
  }
}

function queryString(offset, limit) {
  const params = new URLSearchParams({ offset: String(offset), limit: String(limit) });
  if (state.severity) params.set('severity', state.severity);
  if (state.q) params.set('q', state.q);
  return params.toString();
}

async function fetchWindow(offset) {
  const clampedOffset = Math.max(0, Math.min(offset, Math.max(0, state.total - 1)));
  const seq = ++state.requestSeq;
  if (state.abort) state.abort.abort();
  const controller = new AbortController();
  state.abort = controller;
  state.loading = true;
  setStatus(`Loading rows from ${fmtInt(clampedOffset)}…`, true);

  try {
    const res = await fetch(`${API_BASE}/api/logs?${queryString(clampedOffset, serverLimit)}`, { signal: controller.signal });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Request failed (${res.status})`);
    }
    const data = await res.json();
    if (seq !== state.requestSeq) return;
    state.total = data.total;
    state.windowStart = clampedOffset;
    state.rows = data.rows || [];
    state.loading = false;
    state.firstLoad = false;
    updateSpacer();
    render();
  } catch (err) {
    if (err.name === 'AbortError') return;
    if (seq !== state.requestSeq) return;
    state.loading = false;
    setStatus(`Error: ${err.message}`);
  }
}

function updateSpacer() {
  els.spacer.style.height = `${state.total * rowHeight}px`;
}

function visibleRange() {
  const viewportRows = Math.ceil(els.scroller.clientHeight / rowHeight) || 20;
  const first = Math.max(0, Math.floor(els.scroller.scrollTop / rowHeight) - overscan);
  const count = Math.min(maxRenderedRows, viewportRows + overscan * 2);
  return { first, count, last: Math.min(state.total, first + count) };
}

function render() {
  const { first, count, last } = visibleRange();
  state.desiredStart = first;

  const needFetch = state.firstLoad || first < state.windowStart || last > state.windowStart + state.rows.length;
  if (needFetch && !state.loading) {
    const fetchStart = Math.max(0, first - overscan);
    fetchWindow(fetchStart);
  }

  const frag = document.createDocumentFragment();
  const renderCount = Math.max(0, last - first);
  for (let i = 0; i < renderCount; i++) {
    const absoluteIndex = first + i;
    const row = state.rows[absoluteIndex - state.windowStart];
    const div = document.createElement('div');
    div.className = 'log-row';
    div.style.transform = `translateY(${absoluteIndex * rowHeight}px)`;
    div.dataset.index = String(absoluteIndex);
    if (row) {
      div.innerHTML = `
        <div class="ts">${escapeHtml(formatTs(row.ts))}</div>
        <div><span class="sev ${row.severity}">${row.severity}</span></div>
        <div class="service">${escapeHtml(row.service)}</div>
        <div class="message">${escapeHtml(row.message)}</div>
      `;
    } else {
      div.classList.add('placeholder');
      div.innerHTML = '<div></div><div></div><div></div><div>Loading…</div>';
    }
    frag.appendChild(div);
  }
  els.rows.replaceChildren(frag);

  const showingFrom = state.total === 0 ? 0 : first + 1;
  const showingTo = Math.min(state.total, first + renderCount);
  const domRows = els.rows.children.length;
  if (!state.loading) {
    setStatus(`${fmtInt(showingFrom)}–${fmtInt(showingTo)} of ${fmtInt(state.total)} · ${domRows} DOM rows`);
  }
}

function formatTs(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toISOString().replace('T', ' ').replace('.000Z', 'Z');
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  }[ch]));
}

let scrollRaf = 0;
els.scroller.addEventListener('scroll', () => {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    render();
  });
}, { passive: true });

let debounceTimer = 0;
function filtersChanged() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    state.severity = els.severity.value;
    state.q = els.search.value.trim();
    state.rows = [];
    state.windowStart = 0;
    state.total = 0;
    state.firstLoad = true;
    els.scroller.scrollTop = 0;
    updateSpacer();
    render();
    fetchWindow(0);
  }, 180);
}

els.severity.addEventListener('change', filtersChanged);
els.search.addEventListener('input', filtersChanged);
window.addEventListener('resize', render);

loadStats();
fetchWindow(0);
