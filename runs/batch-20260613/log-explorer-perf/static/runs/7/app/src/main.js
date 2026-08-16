import './styles.css';

const API = '/api';
const ROW_HEIGHT = 38;
const OVERSCAN = 12;
const MAX_LIMIT = 200;
const SEARCH_DEBOUNCE_MS = 250;

const app = document.querySelector('#app');
app.innerHTML = `
  <main class="shell">
    <header class="hero">
      <div>
        <h1>Log Explorer</h1>
        <p>100,000 deterministic log entries, queried in server-side windows and rendered virtually.</p>
      </div>
      <div class="stats" id="stats">Loading corpus…</div>
    </header>

    <section class="toolbar" aria-label="Log filters">
      <label>
        Severity
        <select id="severity">
          <option value="">All severities</option>
          <option value="debug">debug</option>
          <option value="info">info</option>
          <option value="warn">warn</option>
          <option value="error">error</option>
        </select>
      </label>
      <label class="search-label">
        Message contains
        <input id="search" type="search" maxlength="200" placeholder="Try needle-alpha, exception, common-heartbeat…" autocomplete="off" />
      </label>
      <button id="clear" type="button">Clear</button>
      <output id="visible-count" class="visible-count">0 of 0</output>
    </section>

    <section class="table-card">
      <div class="table-head" role="row">
        <div>Timestamp</div>
        <div>Severity</div>
        <div>Service</div>
        <div>Message</div>
      </div>
      <div id="scroller" class="scroller" tabindex="0" aria-label="Virtualized log rows">
        <div id="spacer" class="spacer"></div>
        <div id="rows" class="rows"></div>
        <div id="empty" class="empty hidden">No logs match the active filters.</div>
        <div id="loading" class="loading hidden">Loading window…</div>
      </div>
    </section>

    <footer class="notes">
      The DOM row pool is bounded to the visible window plus overscan; the API caps every response at 200 rows.
    </footer>
  </main>
`;

const els = {
  stats: document.querySelector('#stats'),
  severity: document.querySelector('#severity'),
  search: document.querySelector('#search'),
  clear: document.querySelector('#clear'),
  visibleCount: document.querySelector('#visible-count'),
  scroller: document.querySelector('#scroller'),
  spacer: document.querySelector('#spacer'),
  rows: document.querySelector('#rows'),
  empty: document.querySelector('#empty'),
  loading: document.querySelector('#loading')
};

const state = {
  total: 0,
  rows: [],
  windowOffset: 0,
  requested: { offset: -1, limit: 0, key: '' },
  severity: '',
  q: '',
  requestSeq: 0,
  abortController: null,
  raf: 0,
  debounce: 0,
  lastRenderedOffset: -1
};

function filterKey() {
  return `${state.severity}\u0000${state.q}`;
}

function fmtTime(value) {
  const d = new Date(value);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour12: false })}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function rowTemplate(row) {
  return `
    <div class="cell ts" title="${escapeHtml(row.ts)}">${escapeHtml(fmtTime(row.ts))}</div>
    <div class="cell severity"><span class="pill ${row.severity}">${row.severity}</span></div>
    <div class="cell service">${escapeHtml(row.service)}</div>
    <div class="cell message" title="${escapeHtml(row.message)}">${escapeHtml(row.message)}</div>
  `;
}

async function loadStats() {
  try {
    const res = await fetch(`${API}/stats`);
    if (!res.ok) throw new Error(`stats failed ${res.status}`);
    const data = await res.json();
    els.stats.innerHTML = `
      <strong>${data.total.toLocaleString()}</strong> rows
      <span class="pill debug">debug ${data.severity.debug.toLocaleString()}</span>
      <span class="pill info">info ${data.severity.info.toLocaleString()}</span>
      <span class="pill warn">warn ${data.severity.warn.toLocaleString()}</span>
      <span class="pill error">error ${data.severity.error.toLocaleString()}</span>
    `;
    for (const option of els.severity.options) {
      if (option.value && data.severity[option.value] !== undefined) {
        option.textContent = `${option.value} (${data.severity[option.value].toLocaleString()})`;
      }
    }
  } catch (err) {
    els.stats.textContent = `Stats unavailable: ${err.message}`;
  }
}

function getVisibleRange() {
  const first = Math.max(0, Math.floor(els.scroller.scrollTop / ROW_HEIGHT) - OVERSCAN);
  const visible = Math.ceil(els.scroller.clientHeight / ROW_HEIGHT) + OVERSCAN * 2;
  const limit = Math.min(MAX_LIMIT, Math.max(1, visible));
  return { first, limit };
}

function setLoading(on) {
  els.loading.classList.toggle('hidden', !on);
}

function updateCount(renderedCount) {
  const firstVisible = state.total === 0 ? 0 : Math.floor(els.scroller.scrollTop / ROW_HEIGHT) + 1;
  const lastVisible = Math.min(state.total, firstVisible + Math.ceil(els.scroller.clientHeight / ROW_HEIGHT) - 1);
  const windowText = state.total === 0 ? '0' : `${firstVisible.toLocaleString()}–${lastVisible.toLocaleString()}`;
  els.visibleCount.textContent = `${renderedCount} rows in DOM · showing ${windowText} of ${state.total.toLocaleString()}`;
}

function renderRows() {
  els.spacer.style.height = `${state.total * ROW_HEIGHT}px`;
  els.empty.classList.toggle('hidden', state.total !== 0);

  const fragment = document.createDocumentFragment();
  for (let i = 0; i < state.rows.length; i++) {
    const row = state.rows[i];
    const absoluteIndex = state.windowOffset + i;
    if (absoluteIndex >= state.total) continue;
    const node = document.createElement('div');
    node.className = 'log-row';
    node.style.transform = `translateY(${absoluteIndex * ROW_HEIGHT}px)`;
    node.style.height = `${ROW_HEIGHT}px`;
    node.dataset.offset = String(absoluteIndex);
    node.dataset.id = String(row.id);
    node.innerHTML = rowTemplate(row);
    fragment.appendChild(node);
  }
  els.rows.replaceChildren(fragment);
  updateCount(els.rows.children.length);
}

async function fetchWindow(offset, limit) {
  const key = filterKey();
  if (state.requested.offset === offset && state.requested.limit === limit && state.requested.key === key) return;
  state.requested = { offset, limit, key };

  if (state.abortController) state.abortController.abort();
  const controller = new AbortController();
  state.abortController = controller;
  const seq = ++state.requestSeq;
  setLoading(true);

  const params = new URLSearchParams({ offset: String(offset), limit: String(limit) });
  if (state.severity) params.set('severity', state.severity);
  if (state.q) params.set('q', state.q);

  try {
    const started = performance.now();
    const res = await fetch(`${API}/logs?${params}`, { signal: controller.signal });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `request failed (${res.status})`);
    }
    const data = await res.json();
    if (seq !== state.requestSeq || key !== filterKey()) return;
    state.total = data.total;
    state.rows = data.rows;
    state.windowOffset = offset;
    renderRows();
    setLoading(false);
    els.scroller.dataset.latency = `${Math.round(performance.now() - started)}ms`;
  } catch (err) {
    if (err.name === 'AbortError') return;
    if (seq === state.requestSeq) {
      setLoading(false);
      els.rows.innerHTML = `<div class="error-row">${escapeHtml(err.message)}</div>`;
    }
  }
}

function scheduleWindowLoad() {
  if (state.raf) return;
  state.raf = requestAnimationFrame(() => {
    state.raf = 0;
    const { first, limit } = getVisibleRange();
    updateCount(els.rows.children.length);
    const loadedStart = state.windowOffset;
    const loadedEnd = state.windowOffset + state.rows.length;
    if (first < loadedStart || first + limit > loadedEnd || filterKey() !== state.requested.key) {
      const safeOffset = Math.max(0, Math.min(first, Math.max(0, state.total - 1)));
      fetchWindow(safeOffset, limit);
    }
  });
}

function applyFiltersNow() {
  state.severity = els.severity.value;
  state.q = els.search.value.trim();
  state.total = 0;
  state.rows = [];
  state.windowOffset = 0;
  state.requested = { offset: -1, limit: 0, key: '' };
  els.scroller.scrollTop = 0;
  renderRows();
  const { first, limit } = getVisibleRange();
  fetchWindow(first, limit);
}

function applyFiltersDebounced() {
  clearTimeout(state.debounce);
  state.debounce = setTimeout(applyFiltersNow, SEARCH_DEBOUNCE_MS);
}

els.scroller.addEventListener('scroll', scheduleWindowLoad, { passive: true });
els.severity.addEventListener('change', applyFiltersNow);
els.search.addEventListener('input', applyFiltersDebounced);
els.clear.addEventListener('click', () => {
  els.severity.value = '';
  els.search.value = '';
  clearTimeout(state.debounce);
  applyFiltersNow();
});
window.addEventListener('resize', scheduleWindowLoad);

loadStats();
applyFiltersNow();
