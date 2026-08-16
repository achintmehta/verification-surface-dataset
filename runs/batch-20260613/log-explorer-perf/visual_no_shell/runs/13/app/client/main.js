const ROW_H = 28;         // must match --row-h in CSS
const PAGE = 200;         // window size fetched per request (== server max)
const OVERSCAN = 10;      // extra rows above/below viewport

const viewport = document.getElementById('viewport');
const spacer = document.getElementById('spacer');
const rowsEl = document.getElementById('rows');
const severityEl = document.getElementById('severity');
const searchEl = document.getElementById('search');
const countEl = document.getElementById('count');
const badgesEl = document.getElementById('badges');

const state = {
  total: 0,
  severity: '',
  q: '',
  // cache of windows keyed by window start offset -> array of rows
  cache: new Map(),
  // set of window starts currently being fetched
  inflight: new Set(),
  // monotonically increasing token; only the newest filter change wins
  filterToken: 0,
  // grand total (unfiltered), from /api/stats
  grandTotal: 0,
};

const fmtTs = (iso) => {
  const d = new Date(iso);
  return d.toISOString().replace('T', ' ').replace('.000Z', '').replace('Z', '');
};

const esc = (s) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function buildQuery(offset, limit) {
  const params = new URLSearchParams();
  params.set('offset', offset);
  params.set('limit', limit);
  if (state.severity) params.set('severity', state.severity);
  if (state.q) params.set('q', state.q);
  return `/api/logs?${params.toString()}`;
}

// Fetch the window that starts at `winStart`. Guarded by filter token so
// out-of-order / stale responses from a previous filter never apply.
async function fetchWindow(winStart, token) {
  const key = winStart;
  if (state.cache.has(key) || state.inflight.has(key)) return;
  state.inflight.add(key);
  try {
    const limit = Math.min(PAGE, Math.max(1, state.total - winStart));
    if (limit <= 0) return;
    const resp = await fetch(buildQuery(winStart, limit));
    if (token !== state.filterToken) return; // stale — discard
    const data = await resp.json();
    if (token !== state.filterToken) return; // stale — discard
    state.cache.set(key, data.rows);
    // If total drifted (shouldn't for a static corpus) keep newest.
    render();
  } catch (_e) {
    // network error — allow retry later
  } finally {
    state.inflight.delete(key);
  }
}

function windowStartFor(offset) {
  return Math.floor(offset / PAGE) * PAGE;
}

function getRow(offset) {
  const ws = windowStartFor(offset);
  const win = state.cache.get(ws);
  if (!win) return undefined;
  return win[offset - ws];
}

function render() {
  const scrollTop = viewport.scrollTop;
  const viewH = viewport.clientHeight || 1;

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const visibleCount = Math.ceil(viewH / ROW_H) + OVERSCAN * 2;
  const last = Math.min(state.total, first + visibleCount);

  // Ensure the windows covering [first,last) are loaded.
  const token = state.filterToken;
  const neededWindows = new Set();
  for (let o = first; o < last; o += PAGE) neededWindows.add(windowStartFor(o));
  neededWindows.add(windowStartFor(last > 0 ? last - 1 : 0));
  for (const ws of neededWindows) fetchWindow(ws, token);

  // Build the visible rows.
  const frag = document.createDocumentFragment();
  for (let i = first; i < last; i++) {
    const row = getRow(i);
    const el = document.createElement('div');
    el.className = 'row';
    el.style.transform = '';
    if (row) {
      el.innerHTML =
        `<div class="col col-ts">${fmtTs(row.ts)}</div>` +
        `<div class="col col-sev"><span class="sev-tag ${row.severity}">${row.severity}</span></div>` +
        `<div class="col col-svc">${esc(row.service)}</div>` +
        `<div class="col col-msg">${esc(row.message)}</div>`;
    } else {
      el.innerHTML = `<div class="col col-msg" style="color:var(--muted)">…</div>`;
    }
    frag.appendChild(el);
  }

  rowsEl.replaceChildren(frag);
  rowsEl.style.transform = `translateY(${first * ROW_H}px)`;

  const grand = state.grandTotal || state.total;
  countEl.textContent = `${state.total.toLocaleString()} of ${grand.toLocaleString()}`;
  if (state.total === 0) {
    rowsEl.innerHTML = '<div class="empty">No matching log entries.</div>';
    rowsEl.style.transform = 'translateY(0)';
  }
}

function resetView() {
  state.cache.clear();
  state.inflight.clear();
  viewport.scrollTop = 0;
  spacer.style.height = `${state.total * ROW_H}px`;
}

async function applyFilters() {
  const token = ++state.filterToken;
  // Fetch first window (also gives us the exact total for this filter).
  try {
    const resp = await fetch(buildQuery(0, PAGE));
    if (token !== state.filterToken) return;
    const data = await resp.json();
    if (token !== state.filterToken) return;
    state.total = data.total;
    resetView();
    state.cache.set(0, data.rows);
    render();
  } catch (_e) {
    /* ignore */
  }
}

async function loadStats() {
  try {
    const resp = await fetch('/api/stats');
    const data = await resp.json();
    state.grandTotal = data.total;
    const order = ['debug', 'info', 'warn', 'error'];
    badgesEl.replaceChildren(
      ...(() => {
        const els = [];
        const totalBadge = document.createElement('span');
        totalBadge.className = 'badge';
        totalBadge.innerHTML = `total <b>${data.total.toLocaleString()}</b>`;
        els.push(totalBadge);
        for (const s of order) {
          const b = document.createElement('span');
          b.className = `badge sev-${s}`;
          b.innerHTML = `${s} <b>${(data.bySeverity[s] || 0).toLocaleString()}</b>`;
          els.push(b);
        }
        return els;
      })()
    );
  } catch (_e) {
    /* ignore */
  }
}

// --- events ---
let scrollRaf = null;
viewport.addEventListener('scroll', () => {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = null;
    render();
  });
});

window.addEventListener('resize', () => render());

severityEl.addEventListener('change', () => {
  state.severity = severityEl.value;
  applyFilters();
});

let debounceTimer = null;
searchEl.addEventListener('input', () => {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    state.q = searchEl.value.trim();
    applyFilters();
  }, 200);
});

// --- boot ---
loadStats();
applyFilters();
