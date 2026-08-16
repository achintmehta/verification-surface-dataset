const ROW_H = 28;
const LIMIT = 200; // server cap; we fetch windows up to this size
const OVERSCAN = 12; // extra rows above/below viewport

const viewport = document.getElementById('viewport');
const spacer = document.getElementById('spacer');
const rowsEl = document.getElementById('rows');
const severitySel = document.getElementById('severity');
const qInput = document.getElementById('q');
const countsEl = document.getElementById('counts');

// --- Application state ---
const state = {
  severity: '',
  q: '',
  total: 0,
  // cache of fetched rows keyed by offset -> array
  cache: new Map(),
  // to guard against out-of-order responses
  requestSeq: 0,
  // pending fetches keyed by window start
  inflight: new Set(),
};

function fmtTs(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return (
    d.getUTCFullYear() +
    '-' + pad(d.getUTCMonth() + 1) +
    '-' + pad(d.getUTCDate()) +
    ' ' + pad(d.getUTCHours()) +
    ':' + pad(d.getUTCMinutes()) +
    ':' + pad(d.getUTCSeconds())
  );
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// --- Windowed data access with caching ---
// We fetch in aligned windows of size WINDOW so a scroll only triggers a few
// distinct fetches. Each window is cached by its start index.
const WINDOW = 200;

function windowStartFor(index) {
  return Math.floor(index / WINDOW) * WINDOW;
}

function getRow(index) {
  const start = windowStartFor(index);
  const win = state.cache.get(start);
  if (!win) return undefined;
  return win[index - start];
}

async function ensureWindow(start, mySeq) {
  if (state.cache.has(start) || state.inflight.has(start)) return;
  state.inflight.add(start);

  const params = new URLSearchParams();
  params.set('offset', String(start));
  params.set('limit', String(WINDOW));
  if (state.severity) params.set('severity', state.severity);
  if (state.q) params.set('q', state.q);

  try {
    const resp = await fetch('/api/logs?' + params.toString());
    if (!resp.ok) throw new Error('bad response ' + resp.status);
    const data = await resp.json();

    // Discard if a newer filter change happened while in flight.
    if (mySeq !== state.requestSeq) return;

    state.total = data.total;
    state.cache.set(start, data.rows);
    updateSpacerAndCounts();
    render();
  } catch (e) {
    // allow retry on next scroll
    console.warn('window fetch failed', start, e);
  } finally {
    state.inflight.delete(start);
  }
}

function updateSpacerAndCounts() {
  spacer.style.height = Math.max(state.total * ROW_H, 0) + 'px';
  countsEl.textContent = `${state.total.toLocaleString()} of ${globalTotal.toLocaleString()}`;
}

// --- Rendering the visible window ---
function render() {
  const scrollTop = viewport.scrollTop;
  const viewportH = viewport.clientHeight;

  let firstVisible = Math.floor(scrollTop / ROW_H) - OVERSCAN;
  if (firstVisible < 0) firstVisible = 0;
  let visibleCount = Math.ceil(viewportH / ROW_H) + OVERSCAN * 2;
  let lastVisible = Math.min(firstVisible + visibleCount, state.total);

  // Ensure the windows covering the visible range are fetched.
  if (state.total > 0) {
    const startWin = windowStartFor(firstVisible);
    const endWin = windowStartFor(Math.max(lastVisible - 1, 0));
    for (let w = startWin; w <= endWin; w += WINDOW) {
      ensureWindow(w, state.requestSeq);
    }
  }

  // Position the rows container.
  rowsEl.style.transform = `translateY(${firstVisible * ROW_H}px)`;

  const frag = document.createDocumentFragment();
  for (let i = firstVisible; i < lastVisible; i++) {
    const row = getRow(i);
    const div = document.createElement('div');
    div.className = 'log-row';
    if (!row) {
      div.classList.add('empty');
      div.innerHTML = `<div class="col-ts">…</div><div></div><div></div><div>loading…</div>`;
    } else {
      div.innerHTML =
        `<div class="col-ts">${fmtTs(row.ts)}</div>` +
        `<div class="col-sev"><span class="sev sev-${row.severity}">${row.severity}</span></div>` +
        `<div class="col-svc">${escapeHtml(row.service)}</div>` +
        `<div class="col-msg">${escapeHtml(row.message)}</div>`;
    }
    frag.appendChild(div);
  }
  rowsEl.replaceChildren(frag);
}

// --- Filter changes reset scroll & cache ---
let globalTotal = 0;

function resetForFilterChange() {
  state.requestSeq++;
  state.cache.clear();
  state.inflight.clear();
  state.total = 0;
  viewport.scrollTop = 0;
  // Kick off the first window immediately.
  updateSpacerAndCounts();
  render();
}

// --- Debounced search ---
let debounceTimer = null;
function onSearchInput() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    const val = qInput.value.trim();
    if (val === state.q) return;
    state.q = val;
    resetForFilterChange();
  }, 200);
}

severitySel.addEventListener('change', () => {
  state.severity = severitySel.value;
  resetForFilterChange();
});

qInput.addEventListener('input', onSearchInput);

// Throttle scroll rendering with rAF.
let rafPending = false;
viewport.addEventListener('scroll', () => {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    render();
  });
});

window.addEventListener('resize', () => render());

// --- Startup: load stats, then first window ---
async function boot() {
  try {
    const resp = await fetch('/api/stats');
    const stats = await resp.json();
    globalTotal = stats.total;
    // decorate severity options with counts
    for (const opt of severitySel.options) {
      if (opt.value && stats.bySeverity[opt.value] != null) {
        opt.textContent = `${opt.value} (${stats.bySeverity[opt.value].toLocaleString()})`;
      }
    }
  } catch (e) {
    console.warn('stats failed', e);
  }
  resetForFilterChange();
}

boot();
