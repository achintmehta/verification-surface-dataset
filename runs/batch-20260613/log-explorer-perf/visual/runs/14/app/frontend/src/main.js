import './style.css';

const API = import.meta.env.VITE_API_URL || 'http://localhost:3001';
const ROW_H = 30;
const LIMIT = 200;          // matches server cap; one fetch covers a big span
const OVERSCAN = 10;        // rows above/below viewport

// --- DOM refs ---
const viewport = document.getElementById('viewport');
const spacer = document.getElementById('spacer');
const rowsEl = document.getElementById('rows');
const severityEl = document.getElementById('severity');
const searchEl = document.getElementById('search');
const countEl = document.getElementById('count');
const badgesEl = document.getElementById('badges');

// --- state ---
let total = 0;
let filters = { severity: '', q: '' };

// windowed cache: pages keyed by page offset -> array of rows
const PAGE = LIMIT;
const cache = new Map();       // offset -> rows[]
const inflight = new Map();    // offset -> Promise
let requestSeq = 0;            // monotonically increasing token
let latestSeq = 0;             // seq of the newest committed filter state
let abortCtl = new AbortController(); // aborts in-flight fetches on filter change

// row element pool (recycled DOM nodes)
const pool = [];

function makeRow() {
  const el = document.createElement('div');
  el.className = 'log-row';
  el.innerHTML =
    '<div class="col col-ts"></div>' +
    '<div class="col col-sev"></div>' +
    '<div class="col col-svc"></div>' +
    '<div class="col col-msg"></div>';
  rowsEl.appendChild(el);
  return {
    el,
    ts: el.children[0],
    sev: el.children[1],
    svc: el.children[2],
    msg: el.children[3],
  };
}

function fmtTs(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear() +
    '-' + pad(d.getMonth() + 1) +
    '-' + pad(d.getDate()) +
    ' ' + pad(d.getHours()) +
    ':' + pad(d.getMinutes()) +
    ':' + pad(d.getSeconds())
  );
}

// --- data fetching ---
function pageOffsetFor(index) {
  return Math.floor(index / PAGE) * PAGE;
}

async function ensurePage(offset, seq) {
  if (cache.has(offset) || inflight.has(offset)) return;
  const params = new URLSearchParams({
    offset: String(offset),
    limit: String(LIMIT),
  });
  if (filters.severity) params.set('severity', filters.severity);
  if (filters.q) params.set('q', filters.q);

  const signal = abortCtl.signal;
  const promise = fetch(`${API}/api/logs?${params.toString()}`, { signal })
    .then((r) => r.json())
    .then((data) => {
      // Ignore results belonging to a stale filter generation.
      if (seq !== latestSeq) return;
      total = data.total;
      cache.set(offset, data.rows);
      updateCount();
      render();
    })
    .catch(() => {})
    .finally(() => {
      inflight.delete(offset);
    });
  inflight.set(offset, promise);
}

function getRow(index) {
  const off = pageOffsetFor(index);
  const page = cache.get(off);
  if (!page) return null;
  return page[index - off] || null;
}

// --- rendering (virtualization) ---
function render() {
  spacer.style.height = `${Math.max(total * ROW_H, viewport.clientHeight)}px`;
  const scrollTop = viewport.scrollTop;
  const height = viewport.clientHeight;

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const visibleCount = Math.ceil(height / ROW_H) + OVERSCAN * 2;
  const last = Math.min(total, first + visibleCount);

  // Ensure pages covering [first, last) are loaded.
  if (total > 0) {
    const seq = latestSeq;
    for (let off = pageOffsetFor(first); off < last; off += PAGE) {
      ensurePage(off, seq);
    }
  }

  const needed = Math.max(0, last - first);

  // grow pool
  while (pool.length < needed) pool.push(makeRow());
  // hide extras
  for (let i = needed; i < pool.length; i++) pool[i].el.style.display = 'none';

  for (let i = 0; i < needed; i++) {
    const index = first + i;
    const slot = pool[i];
    const row = getRow(index);
    slot.el.style.display = 'flex';
    slot.el.style.transform = `translateY(${index * ROW_H}px)`;
    if (row) {
      slot.ts.textContent = fmtTs(row.ts);
      slot.sev.innerHTML = `<span class="sev-pill sev-${row.severity}">${row.severity}</span>`;
      slot.svc.textContent = row.service;
      slot.msg.textContent = row.message;
      slot.el.dataset.loaded = '1';
    } else {
      // Placeholder while its page loads — never a permanently blank region
      // because ensurePage() will fetch and re-render.
      slot.ts.textContent = '';
      slot.sev.innerHTML = '';
      slot.svc.textContent = '';
      slot.msg.textContent = '…';
      slot.el.dataset.loaded = '0';
    }
  }
}

function updateCount() {
  countEl.textContent = `${total.toLocaleString()} of ${(window.__grandTotal ?? total).toLocaleString()}`;
}

// --- filter changes ---
function applyFilters() {
  requestSeq += 1;
  latestSeq = requestSeq;
  abortCtl.abort();               // cancel stale in-flight requests
  abortCtl = new AbortController();
  cache.clear();
  inflight.clear();
  total = 0;
  viewport.scrollTop = 0;
  spacer.style.height = '0px';
  render();
  // kick off the count + first page immediately
  ensurePage(0, latestSeq);
}

function onScroll() {
  render();
}

// --- debounce ---
function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// --- badges / stats ---
async function loadStats() {
  try {
    const r = await fetch(`${API}/api/stats`);
    const s = await r.json();
    window.__grandTotal = s.total;
    const order = ['debug', 'info', 'warn', 'error'];
    badgesEl.innerHTML = order
      .map(
        (sev) =>
          `<span class="badge sev-${sev}">${sev}: <b>${(s.bySeverity[sev] || 0).toLocaleString()}</b></span>`
      )
      .join('');
    updateCount();
  } catch (_) {}
}

// --- wiring ---
severityEl.addEventListener('change', () => {
  filters.severity = severityEl.value;
  applyFilters();
});

const debouncedSearch = debounce(() => {
  filters.q = searchEl.value.trim();
  applyFilters();
}, 220);
searchEl.addEventListener('input', debouncedSearch);

let scrollRaf = null;
viewport.addEventListener('scroll', () => {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = null;
    onScroll();
  });
});

window.addEventListener('resize', () => render());

// initial load
loadStats();
applyFilters();
