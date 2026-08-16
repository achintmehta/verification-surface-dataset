import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || '';
const ROW_HEIGHT = 36;
const OVERSCAN = 12;
const LIMIT = 80;
const SEVERITIES = ['', 'debug', 'info', 'warn', 'error'];

const state = {
  total: 0,
  offset: 0,
  rows: [],
  severity: '',
  q: '',
  requestSeq: 0,
  abortController: null,
  loading: false,
  stats: null,
  debounceTimer: null
};

const app = document.querySelector('#app');
app.innerHTML = `
  <header class="topbar">
    <div>
      <h1>Log Explorer</h1>
      <p>100k deterministic logs • server-windowed API • virtualized DOM</p>
    </div>
    <div class="status" id="status">Starting…</div>
  </header>

  <section class="controls" aria-label="Log filters">
    <label>
      Severity
      <select id="severity">
        ${SEVERITIES.map(s => `<option value="${s}">${s || 'all severities'}</option>`).join('')}
      </select>
    </label>
    <label class="search-label">
      Message contains
      <input id="search" type="search" placeholder="try rare-token-zebra, common-token, payment…" autocomplete="off" />
    </label>
    <button id="clear" type="button">Clear</button>
    <div class="badges" id="badges"></div>
    <div class="count" id="count">0 of 0</div>
  </section>

  <main class="table-card">
    <div class="table-head" role="row">
      <div>Timestamp</div><div>Severity</div><div>Service</div><div>Message</div>
    </div>
    <div id="scroller" class="scroller" tabindex="0" aria-label="Virtualized log rows">
      <div id="spacer" class="spacer"></div>
      <div id="rows" class="rows"></div>
    </div>
  </main>
`;

const els = {
  status: document.querySelector('#status'),
  severity: document.querySelector('#severity'),
  search: document.querySelector('#search'),
  clear: document.querySelector('#clear'),
  badges: document.querySelector('#badges'),
  count: document.querySelector('#count'),
  scroller: document.querySelector('#scroller'),
  spacer: document.querySelector('#spacer'),
  rows: document.querySelector('#rows')
};

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch]));
}

function renderBadges() {
  const stats = state.stats;
  if (!stats) return;
  const sev = stats.severities || {};
  els.badges.innerHTML = `
    <span class="badge">all ${stats.total.toLocaleString()}</span>
    ${['debug', 'info', 'warn', 'error'].map(s => `<span class="badge sev-${s}">${s} ${(sev[s] || 0).toLocaleString()}</span>`).join('')}
  `;
}

async function loadStats() {
  try {
    const res = await fetch(`${API_BASE}/api/stats`);
    if (!res.ok) throw new Error(`stats ${res.status}`);
    state.stats = await res.json();
    renderBadges();
  } catch (err) {
    console.warn(err);
  }
}

function desiredWindowOffset() {
  const viewportRows = Math.ceil(els.scroller.clientHeight / ROW_HEIGHT);
  const firstVisible = Math.floor(els.scroller.scrollTop / ROW_HEIGHT);
  const maxOffset = Math.max(0, state.total - LIMIT);
  const desired = Math.max(0, firstVisible - OVERSCAN);
  return Math.min(desired, maxOffset);
}

function updateCounts() {
  const first = state.total === 0 ? 0 : Math.floor(els.scroller.scrollTop / ROW_HEIGHT) + 1;
  const visible = Math.min(state.total, Math.ceil(els.scroller.clientHeight / ROW_HEIGHT));
  const last = state.total === 0 ? 0 : Math.min(state.total, first + visible - 1);
  els.count.textContent = `${first.toLocaleString()}–${last.toLocaleString()} of ${state.total.toLocaleString()}`;
  els.spacer.style.height = `${state.total * ROW_HEIGHT}px`;
}

function renderRows() {
  updateCounts();
  const offset = state.offset;
  const html = state.rows.map((row, i) => {
    const absolute = offset + i;
    const top = absolute * ROW_HEIGHT;
    const ts = new Date(row.ts).toISOString().replace('T', ' ').replace('.000Z', 'Z');
    return `
      <div class="log-row" role="row" data-index="${absolute}" style="transform: translateY(${top}px)">
        <div class="ts">${escapeHtml(ts)}</div>
        <div><span class="pill sev-${row.severity}">${escapeHtml(row.severity)}</span></div>
        <div class="service">${escapeHtml(row.service)}</div>
        <div class="message">${escapeHtml(row.message)}</div>
      </div>`;
  }).join('');
  els.rows.innerHTML = html || `<div class="empty">${state.loading ? 'Loading…' : 'No matching logs'}</div>`;
}

async function fetchWindow({ resetScroll = false } = {}) {
  if (resetScroll) {
    els.scroller.scrollTop = 0;
    state.offset = 0;
  } else {
    state.offset = desiredWindowOffset();
  }

  const seq = ++state.requestSeq;
  state.abortController?.abort();
  const controller = new AbortController();
  state.abortController = controller;
  state.loading = true;
  els.status.textContent = 'Loading…';

  const params = new URLSearchParams({ offset: String(state.offset), limit: String(LIMIT) });
  if (state.severity) params.set('severity', state.severity);
  if (state.q) params.set('q', state.q);

  try {
    const started = performance.now();
    const res = await fetch(`${API_BASE}/api/logs?${params}`, { signal: controller.signal });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    const payload = await res.json();
    if (seq !== state.requestSeq) return; // stale response
    state.total = payload.total;
    state.rows = payload.rows;
    state.loading = false;
    els.status.textContent = `${payload.rows.length} rows fetched in ${Math.round(performance.now() - started)} ms`;
    renderRows();
  } catch (err) {
    if (err.name === 'AbortError') return;
    if (seq !== state.requestSeq) return;
    state.loading = false;
    state.rows = [];
    els.status.textContent = `Error: ${err.message}`;
    renderRows();
  }
}

let scrollRaf = 0;
els.scroller.addEventListener('scroll', () => {
  updateCounts();
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    const desired = desiredWindowOffset();
    const low = state.offset + OVERSCAN;
    const high = state.offset + state.rows.length - Math.ceil(els.scroller.clientHeight / ROW_HEIGHT) - OVERSCAN;
    if (desired < low || desired > high || state.rows.length === 0) {
      fetchWindow();
    }
  });
});

els.severity.addEventListener('change', () => {
  state.severity = els.severity.value;
  fetchWindow({ resetScroll: true });
});

els.search.addEventListener('input', () => {
  clearTimeout(state.debounceTimer);
  const value = els.search.value.trim();
  state.debounceTimer = setTimeout(() => {
    state.q = value;
    fetchWindow({ resetScroll: true });
  }, 220);
});

els.clear.addEventListener('click', () => {
  els.severity.value = '';
  els.search.value = '';
  state.severity = '';
  state.q = '';
  fetchWindow({ resetScroll: true });
});

window.addEventListener('resize', () => {
  renderRows();
  fetchWindow();
});

loadStats();
fetchWindow({ resetScroll: true });
