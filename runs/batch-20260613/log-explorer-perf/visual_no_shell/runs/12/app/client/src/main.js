// Virtualized log explorer client.
//
// Core ideas:
//  - The scroll container has a spacer sized to `total * ROW_H`, so the native
//    scrollbar reflects the entire filtered corpus without any rows existing.
//  - Only the rows intersecting the viewport (+ overscan) are fetched and
//    rendered into a pool of DOM nodes, absolutely positioned by offset.
//  - Windows are fetched from the API in fixed-size pages and cached; scrolling
//    reuses cached pages so we don't refetch on every pixel.
//  - Filter changes reset scroll & cache; stale responses are dropped via a
//    monotonically increasing query token.

const ROW_H = 34; // must match --row-h in CSS
const OVERSCAN = 12; // extra rows above/below the viewport
const PAGE = 200; // API window size (== server cap)
const MAX_POOL = 100; // safety cap on live DOM rows

const viewport = document.getElementById('viewport');
const spacer = document.getElementById('spacer');
const rowsEl = document.getElementById('rows');
const severitySel = document.getElementById('severity');
const searchInput = document.getElementById('search');
const countsEl = document.getElementById('counts');
const badgesEl = document.getElementById('badges');

const SEV_ORDER = ['debug', 'info', 'warn', 'error'];

// --- application state ---
const state = {
  filter: { severity: '', q: '' },
  total: 0,
  queryToken: 0, // incremented whenever filters change
};

// page cache: Map<pageIndex, { status: 'loading'|'ready', rows, token }>
let pageCache = new Map();
let inflight = new Map(); // pageIndex -> AbortController

// --- utilities ---
function fmtTs(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear() +
    '-' +
    pad(d.getMonth() + 1) +
    '-' +
    pad(d.getDate()) +
    ' ' +
    pad(d.getHours()) +
    ':' +
    pad(d.getMinutes()) +
    ':' +
    pad(d.getSeconds())
  );
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildQueryUrl(offset, limit) {
  const params = new URLSearchParams();
  params.set('offset', String(offset));
  params.set('limit', String(limit));
  if (state.filter.severity) params.set('severity', state.filter.severity);
  if (state.filter.q) params.set('q', state.filter.q);
  return '/api/logs?' + params.toString();
}

// --- data fetching ---
async function fetchStats() {
  try {
    const res = await fetch('/api/stats');
    const data = await res.json();
    renderBadges(data);
  } catch (e) {
    console.warn('stats failed', e);
  }
}

function renderBadges(stats) {
  const total = stats.total;
  const parts = [];
  parts.push(
    `<div class="badge${state.filter.severity === '' ? ' active' : ''}" data-sev="">All <span class="count">${total.toLocaleString()}</span></div>`
  );
  for (const sev of SEV_ORDER) {
    const c = stats.bySeverity[sev] || 0;
    parts.push(
      `<div class="badge${state.filter.severity === sev ? ' active' : ''}" data-sev="${sev}">` +
        `<span class="dot" style="background:var(--sev-${sev})"></span>${sev} ` +
        `<span class="count">${c.toLocaleString()}</span></div>`
    );
  }
  badgesEl.innerHTML = parts.join('');
  badgesEl.querySelectorAll('.badge').forEach((el) => {
    el.addEventListener('click', () => {
      const sev = el.getAttribute('data-sev');
      severitySel.value = sev;
      applyFilter({ severity: sev });
    });
  });
}

// Fetch a page (window) of rows. Returns immediately from cache when present.
function requestPage(pageIndex, token) {
  const cached = pageCache.get(pageIndex);
  if (cached && cached.token === token) return; // ready or already loading

  // Abort any stale loader for this page under an older token.
  if (inflight.has(pageIndex)) {
    inflight.get(pageIndex).abort();
    inflight.delete(pageIndex);
  }

  const controller = new AbortController();
  inflight.set(pageIndex, controller);
  pageCache.set(pageIndex, { status: 'loading', rows: null, token });

  const offset = pageIndex * PAGE;
  fetch(buildQueryUrl(offset, PAGE), { signal: controller.signal })
    .then((r) => r.json())
    .then((data) => {
      // Drop the result if filters changed since this request started.
      if (token !== state.queryToken) return;
      pageCache.set(pageIndex, { status: 'ready', rows: data.rows, token });
      // Keep total authoritative from the latest response.
      if (typeof data.total === 'number') {
        if (data.total !== state.total) {
          state.total = data.total;
          updateSpacer();
          updateCounts();
        }
      }
      inflight.delete(pageIndex);
      render();
    })
    .catch((err) => {
      if (err.name === 'AbortError') return;
      console.warn('page fetch failed', err);
      pageCache.delete(pageIndex);
      inflight.delete(pageIndex);
    });
}

// --- rendering (virtualization) ---
function updateSpacer() {
  spacer.style.height = Math.max(state.total * ROW_H, 0) + 'px';
}

function updateCounts() {
  const filterActive = state.filter.severity || state.filter.q;
  countsEl.innerHTML = filterActive
    ? `<strong>${state.total.toLocaleString()}</strong> matching rows`
    : `<strong>${state.total.toLocaleString()}</strong> rows`;
}

let pool = []; // reusable DOM nodes

function getRowNode(i) {
  if (pool[i]) return pool[i];
  const el = document.createElement('div');
  el.className = 'log-row';
  el.innerHTML =
    '<div class="col col-ts"></div>' +
    '<div class="col col-sev"></div>' +
    '<div class="col col-svc"></div>' +
    '<div class="col col-msg"></div>';
  pool[i] = el;
  return el;
}

function render() {
  const token = state.queryToken;
  const scrollTop = viewport.scrollTop;
  const viewH = viewport.clientHeight;

  if (state.total === 0) {
    rowsEl.innerHTML = '';
    if (!document.getElementById('empty-state')) {
      const es = document.createElement('div');
      es.id = 'empty-state';
      es.className = 'empty-state';
      es.textContent = 'No log entries match the current filters.';
      spacer.appendChild(es);
    }
    return;
  } else {
    const es = document.getElementById('empty-state');
    if (es) es.remove();
  }

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const visibleCount = Math.ceil(viewH / ROW_H) + OVERSCAN * 2;
  const last = Math.min(state.total - 1, first + visibleCount - 1);

  // Determine which pages we need and kick off fetches.
  const firstPage = Math.floor(first / PAGE);
  const lastPage = Math.floor(last / PAGE);
  for (let pg = firstPage; pg <= lastPage; pg++) {
    requestPage(pg, token);
  }

  // Build the fragment of visible rows.
  const frag = document.createDocumentFragment();
  let poolIdx = 0;
  for (let i = first; i <= last; i++) {
    const pg = Math.floor(i / PAGE);
    const within = i % PAGE;
    const entry = pageCache.get(pg);
    const el = getRowNode(poolIdx++);

    el.style.transform = `translateY(${i * ROW_H}px)`;
    el.style.position = 'absolute';
    el.style.left = '0';
    el.style.right = '0';

    const tsCol = el.children[0];
    const sevCol = el.children[1];
    const svcCol = el.children[2];
    const msgCol = el.children[3];

    if (entry && entry.status === 'ready' && entry.rows[within]) {
      const row = entry.rows[within];
      tsCol.textContent = fmtTs(row.ts);
      sevCol.innerHTML = `<span class="sev-tag sev-${row.severity}">${row.severity}</span>`;
      svcCol.textContent = row.service;
      msgCol.innerHTML = escapeHtml(row.message);
      el.dataset.loading = 'false';
    } else {
      tsCol.textContent = '';
      sevCol.innerHTML = '';
      svcCol.textContent = '';
      msgCol.innerHTML = '<span style="color:var(--text-dim)">…</span>';
      el.dataset.loading = 'true';
    }

    frag.appendChild(el);
  }

  // Replace the rendered set in one shot (recycled nodes, bounded pool).
  rowsEl.replaceChildren(frag);

  // Trim pool if it grew (shouldn't exceed MAX_POOL under normal viewports).
  if (pool.length > MAX_POOL * 2) {
    pool = pool.slice(0, MAX_POOL);
  }
}

// --- filter handling ---
function resetForNewFilter() {
  state.queryToken++;
  pageCache = new Map();
  // Abort all inflight requests.
  for (const c of inflight.values()) c.abort();
  inflight = new Map();
  viewport.scrollTop = 0;
}

async function applyFilter(patch) {
  Object.assign(state.filter, patch);
  resetForNewFilter();

  // Fetch the fresh total + first window immediately so counts update fast.
  const token = state.queryToken;
  try {
    const res = await fetch(buildQueryUrl(0, PAGE));
    const data = await res.json();
    if (token !== state.queryToken) return; // stale
    state.total = data.total;
    pageCache.set(0, { status: 'ready', rows: data.rows, token });
    updateSpacer();
    updateCounts();
    render();
  } catch (e) {
    console.warn('filter fetch failed', e);
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

severitySel.addEventListener('change', () => {
  applyFilter({ severity: severitySel.value });
});

// Debounced search. Input is never blocked; each keystroke schedules a query,
// stale responses are ignored via the query token.
let searchTimer = null;
searchInput.addEventListener('input', () => {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    applyFilter({ q: searchInput.value.trim() });
  }, 220);
});

// --- boot ---
async function boot() {
  await fetchStats();
  await applyFilter({}); // loads total + first window
  render();
}

boot();
