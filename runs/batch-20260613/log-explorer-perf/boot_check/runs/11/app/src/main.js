const ROW_H = 28; // must match --row-h in CSS
const PAGE = 200; // window size fetched per request (== server cap)
const OVERSCAN = 10; // extra rows above/below viewport

const viewport = document.getElementById('viewport');
const spacer = document.getElementById('spacer');
const rowsEl = document.getElementById('rows');
const severityEl = document.getElementById('severity');
const searchEl = document.getElementById('search');
const countEl = document.getElementById('count');
const badgesEl = document.getElementById('badges');

const state = {
  total: 0,
  severity: 'all',
  q: '',
  // Cache of fetched pages keyed by page index (offset / PAGE).
  cache: new Map(),
  // In-flight page fetches keyed by page index.
  inflight: new Map(),
  // Monotonic token: bumped whenever filters change so stale responses are dropped.
  filterToken: 0,
};

function fmtTs(ts) {
  const d = new Date(ts);
  return d.toISOString().replace('T', ' ').replace('.000Z', 'Z');
}

// ---- Networking -----------------------------------------------------------

async function fetchStats() {
  try {
    const res = await fetch('/api/stats');
    const data = await res.json();
    renderBadges(data.bySeverity, data.total);
  } catch (e) {
    // stats are non-critical
  }
}

function buildQuery(offset, limit) {
  const p = new URLSearchParams();
  p.set('offset', String(offset));
  p.set('limit', String(limit));
  if (state.severity && state.severity !== 'all') p.set('severity', state.severity);
  if (state.q) p.set('q', state.q);
  return `/api/logs?${p.toString()}`;
}

// Fetch total (and first page) for the current filter. Returns total.
async function fetchTotalAndFirst(token) {
  const res = await fetch(buildQuery(0, PAGE));
  if (!res.ok) throw new Error('bad response');
  const data = await res.json();
  if (token !== state.filterToken) return null; // stale
  state.total = data.total;
  state.cache.set(0, data.rows);
  return data.total;
}

// Ensure a page (by pageIndex) is loaded; kicks off fetch if needed.
function ensurePage(pageIndex, token) {
  if (state.cache.has(pageIndex)) return;
  if (state.inflight.has(pageIndex)) return;
  const offset = pageIndex * PAGE;
  if (offset >= state.total) return;

  const controller = new AbortController();
  const promise = fetch(buildQuery(offset, PAGE), { signal: controller.signal })
    .then((r) => {
      if (!r.ok) throw new Error('bad response');
      return r.json();
    })
    .then((data) => {
      state.inflight.delete(pageIndex);
      if (token !== state.filterToken) return; // stale, discard
      state.cache.set(pageIndex, data.rows);
      // Keep total fresh in case it changed.
      state.total = data.total;
      render();
    })
    .catch(() => {
      state.inflight.delete(pageIndex);
    });

  state.inflight.set(pageIndex, { controller, promise });
}

function cancelAllInflight() {
  for (const { controller } of state.inflight.values()) {
    controller.abort();
  }
  state.inflight.clear();
}

// ---- Rendering ------------------------------------------------------------

function renderBadges(bySeverity, total) {
  const order = ['debug', 'info', 'warn', 'error'];
  badgesEl.innerHTML = '';
  const totalBadge = document.createElement('span');
  totalBadge.className = 'badge';
  totalBadge.textContent = `total ${total.toLocaleString()}`;
  badgesEl.appendChild(totalBadge);
  for (const sev of order) {
    const c = bySeverity[sev] || 0;
    const b = document.createElement('span');
    b.className = `badge sev-${sev}`;
    b.textContent = `${sev} ${c.toLocaleString()}`;
    badgesEl.appendChild(b);
  }
}

function getRow(index) {
  const pageIndex = Math.floor(index / PAGE);
  const page = state.cache.get(pageIndex);
  if (!page) return undefined;
  return page[index - pageIndex * PAGE];
}

function render() {
  const total = state.total;
  // Size the scrollable area to reflect the full filtered corpus.
  spacer.style.height = `${total * ROW_H}px`;

  const scrollTop = viewport.scrollTop;
  const viewH = viewport.clientHeight;

  let first = Math.floor(scrollTop / ROW_H) - OVERSCAN;
  let last = Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN;
  first = Math.max(0, first);
  last = Math.min(total, last);

  // Determine which pages the visible window touches and ensure they're loaded.
  const token = state.filterToken;
  if (total > 0) {
    const firstPage = Math.floor(first / PAGE);
    const lastPage = Math.floor(Math.max(0, last - 1) / PAGE);
    for (let p = firstPage; p <= lastPage; p++) ensurePage(p, token);
  }

  // Offset the rows container to the first visible row.
  rowsEl.style.transform = `translateY(${first * ROW_H}px)`;

  const frag = document.createDocumentFragment();
  for (let i = first; i < last; i++) {
    const row = getRow(i);
    const el = document.createElement('div');
    el.className = 'log-row';
    if (!row) {
      el.classList.add('blank');
      const c = document.createElement('div');
      c.className = 'col col-msg';
      c.textContent = 'loading…';
      el.appendChild(c);
    } else {
      el.innerHTML =
        `<div class="col col-ts">${fmtTs(row.ts)}</div>` +
        `<div class="col col-sev sev-${row.severity}">${row.severity}</div>` +
        `<div class="col col-svc">${escapeHtml(row.service)}</div>` +
        `<div class="col col-msg">${escapeHtml(row.message)}</div>`;
    }
    frag.appendChild(el);
  }
  rowsEl.replaceChildren(frag);

  updateCount(first, last);
}

function updateCount(first, last) {
  if (state.total === 0) {
    countEl.textContent = `0 of 0`;
    return;
  }
  const visFrom = Math.min(first + 1, state.total);
  const visTo = Math.min(last, state.total);
  countEl.textContent = `${visFrom.toLocaleString()}–${visTo.toLocaleString()} of ${state.total.toLocaleString()}`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ---- Filter changes -------------------------------------------------------

async function applyFilters() {
  // Bump token so any in-flight page responses are ignored.
  state.filterToken++;
  const token = state.filterToken;
  cancelAllInflight();
  state.cache.clear();
  viewport.scrollTop = 0;

  try {
    const total = await fetchTotalAndFirst(token);
    if (total === null) return; // superseded
    render();
  } catch (e) {
    // On error, show empty.
    if (token === state.filterToken) {
      state.total = 0;
      render();
    }
  }
}

// ---- Events ---------------------------------------------------------------

let rafPending = false;
viewport.addEventListener('scroll', () => {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    render();
  });
});

severityEl.addEventListener('change', () => {
  state.severity = severityEl.value;
  applyFilters();
});

let debounceTimer = null;
searchEl.addEventListener('input', () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    state.q = searchEl.value.trim();
    applyFilters();
  }, 250);
});

window.addEventListener('resize', render);

// ---- Boot -----------------------------------------------------------------

async function boot() {
  await Promise.all([fetchStats(), applyFilters()]);
}

boot();
