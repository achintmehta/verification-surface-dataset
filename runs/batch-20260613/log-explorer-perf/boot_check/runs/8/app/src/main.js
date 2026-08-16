import './styles.css';

const API = '';
const ROW_HEIGHT = 34;
const PAGE_SIZE = 100;
const MAX_DOM_ROWS = 96;
const OVERSCAN = 14;
const DEBOUNCE_MS = 220;

const app = document.querySelector('#app');
app.innerHTML = `
  <div class="app">
    <header class="header">
      <h1>Log Explorer</h1>
      <div class="controls">
        <div class="control">
          <label for="severity">Severity</label>
          <select id="severity">
            <option value="">All severities</option>
            <option value="debug">Debug</option>
            <option value="info">Info</option>
            <option value="warn">Warn</option>
            <option value="error">Error</option>
          </select>
        </div>
        <div class="control">
          <label for="query">Message contains</label>
          <input id="query" type="search" spellcheck="false" autocomplete="off" placeholder="Try timeout, cache, req-000100..." />
        </div>
        <div class="stats" id="stats">
          <span class="badge" id="visibleCount">0 of 0</span>
          <span class="badge" id="severityCounts">Loading stats…</span>
        </div>
      </div>
    </header>
    <section class="table-shell">
      <div class="table-head"><div>Timestamp</div><div>Severity</div><div>Service</div><div>Message</div></div>
      <div class="scroller" id="scroller" aria-label="Virtualized log rows" tabindex="0">
        <div class="spacer" id="spacer"></div>
        <div class="rows" id="rows"></div>
        <div class="loading" id="status">Loading logs…</div>
      </div>
      <div class="footer" id="footer">Only visible rows plus overscan are mounted in the DOM.</div>
    </section>
  </div>`;

const els = {
  severity: document.querySelector('#severity'),
  query: document.querySelector('#query'),
  scroller: document.querySelector('#scroller'),
  spacer: document.querySelector('#spacer'),
  rows: document.querySelector('#rows'),
  status: document.querySelector('#status'),
  visibleCount: document.querySelector('#visibleCount'),
  severityCounts: document.querySelector('#severityCounts'),
  footer: document.querySelector('#footer')
};

const state = {
  total: 0,
  rows: new Map(),
  filters: { severity: '', q: '' },
  firstNeeded: 0,
  lastNeeded: -1,
  generation: 0,
  loadingPages: new Map(),
  debounce: null,
  rowPool: [],
  raf: 0
};

function makeRow() {
  const el = document.createElement('div');
  el.className = 'log-row';
  el.innerHTML = '<div class="ts"></div><div class="severity"></div><div class="service"></div><div class="message"></div>';
  return el;
}

function ensurePool() {
  if (state.rowPool.length) return;
  for (let i = 0; i < MAX_DOM_ROWS; i++) {
    const row = makeRow();
    els.rows.appendChild(row);
    state.rowPool.push(row);
  }
}

function setStatus(text, cls = 'loading') {
  els.status.textContent = text;
  els.status.className = cls;
  els.status.style.display = text ? 'block' : 'none';
}

function activeParams() {
  const p = new URLSearchParams();
  if (state.filters.severity) p.set('severity', state.filters.severity);
  if (state.filters.q) p.set('q', state.filters.q);
  return p;
}

async function fetchWindow(offset, limit, generation, signal) {
  const p = activeParams();
  p.set('offset', String(offset));
  p.set('limit', String(limit));
  const res = await fetch(`${API}/api/logs?${p}`, { signal });
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  if (generation !== state.generation) return;
  state.total = data.total;
  els.spacer.style.height = `${state.total * ROW_HEIGHT}px`;
  for (let i = 0; i < data.rows.length; i++) state.rows.set(offset + i, data.rows[i]);
  updateVisibleCount();
}

function abortAll() {
  for (const page of state.loadingPages.values()) page.controller.abort();
  state.loadingPages.clear();
}

function requestPage(pageOffset) {
  if (pageOffset < 0 || pageOffset >= state.total && state.total !== 0) return;
  if (state.loadingPages.has(pageOffset)) return;
  let complete = true;
  for (let i = pageOffset; i < pageOffset + PAGE_SIZE && i < state.total; i++) {
    if (!state.rows.has(i)) { complete = false; break; }
  }
  if (complete && state.total !== 0) return;

  const controller = new AbortController();
  const generation = state.generation;
  state.loadingPages.set(pageOffset, { controller });
  fetchWindow(pageOffset, PAGE_SIZE, generation, controller.signal)
    .then(() => {
      if (generation === state.generation) render();
    })
    .catch((err) => {
      if (err.name !== 'AbortError' && generation === state.generation) {
        console.error(err);
        setStatus('Failed to load logs. Check the API server.', 'error');
      }
    })
    .finally(() => state.loadingPages.delete(pageOffset));
}

function scheduleRender() {
  if (state.raf) return;
  state.raf = requestAnimationFrame(() => {
    state.raf = 0;
    render();
  });
}

function render() {
  ensurePool();
  const viewportRows = Math.ceil(els.scroller.clientHeight / ROW_HEIGHT);
  const first = Math.max(0, Math.floor(els.scroller.scrollTop / ROW_HEIGHT) - OVERSCAN);
  const count = Math.min(MAX_DOM_ROWS, Math.max(0, viewportRows + OVERSCAN * 2));
  const last = Math.min(state.total - 1, first + count - 1);
  state.firstNeeded = first;
  state.lastNeeded = last;

  if (state.total === 0) {
    for (const rowEl of state.rowPool) rowEl.style.display = 'none';
    setStatus(state.loadingPages.size ? 'Loading logs…' : 'No logs match the active filters.', state.loadingPages.size ? 'loading' : 'empty');
    updateVisibleCount();
    return;
  }

  let missing = 0;
  for (let idx = first; idx <= last; idx++) {
    if (!state.rows.has(idx)) missing++;
  }

  const firstPage = Math.floor(first / PAGE_SIZE) * PAGE_SIZE;
  const lastPage = Math.floor(Math.max(first, last) / PAGE_SIZE) * PAGE_SIZE;
  for (let p = firstPage; p <= lastPage; p += PAGE_SIZE) requestPage(p);

  for (let poolIdx = 0; poolIdx < state.rowPool.length; poolIdx++) {
    const dataIdx = first + poolIdx;
    const rowEl = state.rowPool[poolIdx];
    if (dataIdx > last) {
      rowEl.style.display = 'none';
      continue;
    }
    const row = state.rows.get(dataIdx);
    rowEl.style.display = 'grid';
    rowEl.style.transform = `translateY(${dataIdx * ROW_HEIGHT}px)`;
    if (row) {
      rowEl.children[0].textContent = formatTs(row.ts);
      rowEl.children[1].textContent = row.severity;
      rowEl.children[1].className = `severity sev-${row.severity}`;
      rowEl.children[2].textContent = row.service;
      rowEl.children[3].textContent = row.message;
      rowEl.style.opacity = '1';
    } else {
      rowEl.children[0].textContent = '…';
      rowEl.children[1].textContent = '';
      rowEl.children[1].className = 'severity';
      rowEl.children[2].textContent = '';
      rowEl.children[3].textContent = 'Loading…';
      rowEl.style.opacity = '.55';
    }
  }
  setStatus(missing && state.rows.size === 0 ? 'Loading logs…' : '', 'loading');
  updateVisibleCount();
}

function updateVisibleCount() {
  const mounted = state.total === 0 ? 0 : Math.max(0, Math.min(state.lastNeeded, state.total - 1) - state.firstNeeded + 1);
  els.visibleCount.textContent = `${mounted.toLocaleString()} of ${state.total.toLocaleString()}`;
  els.footer.textContent = `Offset ${Math.max(0, Math.floor(els.scroller.scrollTop / ROW_HEIGHT)).toLocaleString()} • ${els.rows.childElementCount} row elements mounted`;
}

function formatTs(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts).replace('T', ' ').slice(0, 19);
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

async function loadFirstPage() {
  const generation = ++state.generation;
  abortAll();
  state.rows.clear();
  state.total = 0;
  els.spacer.style.height = '0px';
  els.scroller.scrollTop = 0;
  setStatus('Loading logs…');
  const controller = new AbortController();
  state.loadingPages.set(0, { controller });
  try {
    await fetchWindow(0, PAGE_SIZE, generation, controller.signal);
    if (generation === state.generation) render();
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error(err);
      setStatus('Failed to load logs. Is the backend running?', 'error');
    }
  } finally {
    state.loadingPages.delete(0);
  }
}

function applyFilters() {
  state.filters.severity = els.severity.value;
  state.filters.q = els.query.value.trim();
  loadFirstPage();
}

async function loadStats() {
  try {
    const res = await fetch(`${API}/api/stats`);
    const data = await res.json();
    els.severityCounts.textContent = `debug ${data.severities.debug.toLocaleString()} • info ${data.severities.info.toLocaleString()} • warn ${data.severities.warn.toLocaleString()} • error ${data.severities.error.toLocaleString()}`;
  } catch {
    els.severityCounts.textContent = 'stats unavailable';
  }
}

els.scroller.addEventListener('scroll', scheduleRender, { passive: true });
els.severity.addEventListener('change', applyFilters);
els.query.addEventListener('input', () => {
  clearTimeout(state.debounce);
  state.debounce = setTimeout(applyFilters, DEBOUNCE_MS);
});
window.addEventListener('resize', scheduleRender);

ensurePool();
loadStats();
loadFirstPage();
