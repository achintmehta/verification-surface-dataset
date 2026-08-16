const ROW_H = 30; // must match --row-h in CSS
const LIMIT = 100; // window size fetched per request (<= server cap of 200)
const OVERSCAN = 10; // extra rows above/below viewport
const DEBOUNCE_MS = 220;

const els = {
  severity: document.getElementById('severity'),
  search: document.getElementById('search'),
  count: document.getElementById('count'),
  badges: document.getElementById('badges'),
  viewport: document.getElementById('viewport'),
  spacer: document.getElementById('spacer'),
  rows: document.getElementById('rows'),
  status: document.getElementById('status'),
};

const state = {
  total: 0,
  severity: '',
  q: '',
  // Cache of fetched windows keyed by starting offset.
  cache: new Map(),
  // Monotonic request id; results tagged with an older id are discarded.
  reqSeq: 0,
  // The generation of the current filter set; bumped on any filter change so
  // in-flight fetches for a stale filter never write into the current view.
  filterGen: 0,
  pending: new Set(), // offsets currently being fetched (for current gen)
  rowPool: [], // recycled DOM row elements
};

// ---- DOM row pool -----------------------------------------------------------

function makeRow() {
  const row = document.createElement('div');
  row.className = 'row';
  const ts = document.createElement('div'); ts.className = 'col-ts';
  const sev = document.createElement('div'); sev.className = 'col-sev';
  const svc = document.createElement('div'); svc.className = 'col-svc';
  const msg = document.createElement('div'); msg.className = 'col-msg';
  const sevBadge = document.createElement('span');
  sev.appendChild(sevBadge);
  row.append(ts, sev, svc, msg);
  row._parts = { ts, sevBadge, svc, msg };
  return row;
}

function fmtTs(iso) {
  // Compact, deterministic timestamp display.
  return iso.replace('T', ' ').replace(/\.\d+/, '').replace('Z', '');
}

// ---- Fetching ---------------------------------------------------------------

// Round an arbitrary row index down to the nearest window boundary.
function windowStart(index) {
  return Math.floor(index / LIMIT) * LIMIT;
}

async function fetchWindow(offset, gen) {
  const key = offset;
  if (state.cache.has(key)) return;
  if (state.pending.has(key)) return;
  state.pending.add(key);

  const seq = ++state.reqSeq;
  const params = new URLSearchParams({ offset: String(offset), limit: String(LIMIT) });
  if (state.severity) params.set('severity', state.severity);
  if (state.q) params.set('q', state.q);

  try {
    const resp = await fetch('/api/logs?' + params.toString());
    if (!resp.ok) throw new Error('bad response ' + resp.status);
    const data = await resp.json();

    // Discard if the filter generation changed while in flight (stale).
    if (gen !== state.filterGen) return;

    // total may drift only if seeding; keep authoritative value in sync.
    if (data.total !== state.total) {
      state.total = data.total;
      applyTotal();
    }
    state.cache.set(key, data.rows);
    render();
  } catch (err) {
    // Network/other error: leave slot uncached so it can be retried on scroll.
    if (gen === state.filterGen) {
      els.status.textContent = 'fetch error: ' + err.message;
    }
  } finally {
    state.pending.delete(key);
  }
}

// ---- Rendering --------------------------------------------------------------

function applyTotal() {
  els.spacer.style.height = state.total * ROW_H + 'px';
  updateCount();
}

function updateCount() {
  const filtered = state.severity || state.q;
  els.count.textContent = filtered
    ? `${state.total.toLocaleString()} matching`
    : `${state.total.toLocaleString()} total`;
}

function getRow(rowData) {
  let el = state.rowPool.pop();
  if (!el) el = makeRow();
  const p = el._parts;
  p.ts.textContent = fmtTs(rowData.ts);
  p.sevBadge.textContent = rowData.severity;
  p.sevBadge.className = 'sev ' + rowData.severity;
  p.svc.textContent = rowData.service;
  p.msg.textContent = rowData.message;
  return el;
}

function render() {
  const scrollTop = els.viewport.scrollTop;
  const viewH = els.viewport.clientHeight;

  const firstVisible = Math.floor(scrollTop / ROW_H);
  const visibleCount = Math.ceil(viewH / ROW_H);
  const start = Math.max(0, firstVisible - OVERSCAN);
  const end = Math.min(state.total, firstVisible + visibleCount + OVERSCAN);

  // Determine which windows we need and fetch missing ones.
  const gen = state.filterGen;
  for (let ws = windowStart(start); ws < end; ws += LIMIT) {
    if (!state.cache.has(ws)) fetchWindow(ws, gen);
  }

  // Recycle current row elements back into the pool.
  while (els.rows.firstChild) {
    const child = els.rows.firstChild;
    els.rows.removeChild(child);
    if (child.classList.contains('row')) state.rowPool.push(child);
  }

  const frag = document.createDocumentFragment();
  for (let i = start; i < end; i++) {
    const ws = windowStart(i);
    const win = state.cache.get(ws);
    if (!win) continue; // not loaded yet; will render when fetch completes
    const rowData = win[i - ws];
    if (!rowData) continue;
    const el = getRow(rowData);
    el.style.transform = `translateY(${i * ROW_H}px)`;
    el.style.position = 'absolute';
    el.style.left = '0';
    el.style.right = '0';
    frag.appendChild(el);
  }
  els.rows.appendChild(frag);

  els.status.textContent =
    `rows ${start}–${end} in DOM (${end - start}) · cached windows: ${state.cache.size}`;
}

// ---- Filters ----------------------------------------------------------------

function resetForFilterChange() {
  state.filterGen++;
  state.cache.clear();
  state.pending.clear();
  state.total = 0;
  els.viewport.scrollTop = 0;
  applyTotal();
  // Always fetch the first window so `total` gets established even when the
  // spacer height (and thus the visible window) is currently zero.
  fetchWindow(0, state.filterGen);
  render();
}

let debounceTimer = null;
function onSearchInput() {
  // Never block the input: schedule work on a debounce.
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    const v = els.search.value.trim();
    if (v === state.q) return;
    state.q = v;
    resetForFilterChange();
  }, DEBOUNCE_MS);
}

function onSeverityChange() {
  state.severity = els.severity.value;
  resetForFilterChange();
  renderBadges();
}

// ---- Stats badges -----------------------------------------------------------

const SEV_COLORS = { debug: 'var(--debug)', info: 'var(--info)', warn: 'var(--warn)', error: 'var(--error)' };

async function loadStats() {
  try {
    const resp = await fetch('/api/stats');
    const data = await resp.json();
    state.stats = data;
    renderBadges();
  } catch (_) { /* non-fatal */ }
}

function renderBadges() {
  if (!state.stats) return;
  els.badges.innerHTML = '';
  const all = document.createElement('span');
  all.className = 'badge' + (state.severity === '' ? ' active' : '');
  all.textContent = `all ${state.stats.total.toLocaleString()}`;
  all.onclick = () => { els.severity.value = ''; onSeverityChange(); };
  els.badges.appendChild(all);

  for (const sev of ['debug', 'info', 'warn', 'error']) {
    const b = document.createElement('span');
    b.className = 'badge' + (state.severity === sev ? ' active' : '');
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = SEV_COLORS[sev];
    b.appendChild(dot);
    b.appendChild(document.createTextNode(`${sev} ${(state.stats.bySeverity[sev] || 0).toLocaleString()}`));
    b.onclick = () => { els.severity.value = sev; onSeverityChange(); };
    els.badges.appendChild(b);
  }
}

// ---- Wire up ----------------------------------------------------------------

let rafPending = false;
els.viewport.addEventListener('scroll', () => {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    render();
  });
});

window.addEventListener('resize', () => render());
els.severity.addEventListener('change', onSeverityChange);
els.search.addEventListener('input', onSearchInput);

// Initial load.
(async function boot() {
  await loadStats();
  resetForFilterChange();
})();
