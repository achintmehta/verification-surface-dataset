import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3000';
const ROW_HEIGHT = 34;
const OVERSCAN = 12;
const API_LIMIT = 200;
const FETCH_DEBOUNCE_MS = 180;

const scroller = document.getElementById('scroller');
const spacer = document.getElementById('spacer');
const rowsEl = document.getElementById('rows');
const severityFilter = document.getElementById('severityFilter');
const searchBox = document.getElementById('searchBox');
const visibleCount = document.getElementById('visibleCount');
const badges = document.getElementById('badges');

let total = 0;
let filters = { severity: '', q: '' };
let cache = new Map();
let inFlight = null;
let requestSeq = 0;
let fetchTimer = 0;
let lastRenderKey = '';
let isInitial = true;

function fmtDate(ts) {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString();
}

function debounce(fn, delay) {
  let t = 0;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), delay);
  };
}

async function loadStats() {
  try {
    const res = await fetch(`${API_BASE}/api/stats`);
    if (!res.ok) throw new Error(`stats ${res.status}`);
    const data = await res.json();
    badges.innerHTML = `
      <span class="badge all">total ${data.total.toLocaleString()}</span>
      ${Object.entries(data.severities).map(([sev, count]) => `<span class="badge ${sev}">${sev} ${Number(count).toLocaleString()}</span>`).join('')}
    `;
  } catch (err) {
    badges.textContent = 'stats unavailable';
    console.error(err);
  }
}

function queryParams(offset, limit) {
  const params = new URLSearchParams({ offset: String(offset), limit: String(limit) });
  if (filters.severity) params.set('severity', filters.severity);
  if (filters.q) params.set('q', filters.q);
  return params;
}

function neededWindow() {
  const startIndex = Math.max(0, Math.floor(scroller.scrollTop / ROW_HEIGHT) - OVERSCAN);
  const visible = Math.ceil(scroller.clientHeight / ROW_HEIGHT) + OVERSCAN * 2;
  const limit = Math.min(API_LIMIT, Math.max(1, visible));
  const maxStart = Math.max(0, total - limit);
  return { offset: Math.min(startIndex, maxStart), limit };
}

function findCached(offset, limit) {
  for (const entry of cache.values()) {
    if (offset >= entry.offset && offset + limit <= entry.offset + entry.rows.length) {
      return entry.rows.slice(offset - entry.offset, offset - entry.offset + limit);
    }
  }
  return null;
}

async function fetchWindow(offset, limit) {
  const seq = ++requestSeq;
  if (inFlight) inFlight.abort();
  inFlight = new AbortController();
  const key = `${offset}:${limit}:${filters.severity}:${filters.q}`;
  try {
    const res = await fetch(`${API_BASE}/api/logs?${queryParams(offset, limit)}`, { signal: inFlight.signal });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    if (seq !== requestSeq) return;
    total = data.total;
    spacer.style.height = `${total * ROW_HEIGHT}px`;
    cache.set(key, { offset, rows: data.rows });
    // Keep memory bounded; the DOM stays bounded independently.
    if (cache.size > 8) cache.delete(cache.keys().next().value);
    render();
  } catch (err) {
    if (err.name !== 'AbortError') console.error('fetchWindow failed', err);
  }
}

function scheduleFetch(offset, limit, delay = 0) {
  clearTimeout(fetchTimer);
  fetchTimer = setTimeout(() => fetchWindow(offset, Math.min(limit, API_LIMIT)), delay);
}

function render() {
  const { offset, limit } = neededWindow();
  const rows = findCached(offset, limit);
  const key = `${offset}:${limit}:${total}:${filters.severity}:${filters.q}:${rows ? rows.map(r => r.id).join(',') : 'miss'}`;
  if (key === lastRenderKey) return;
  lastRenderKey = key;

  rowsEl.style.transform = `translateY(${offset * ROW_HEIGHT}px)`;
  rowsEl.innerHTML = '';

  if (rows) {
    const frag = document.createDocumentFragment();
    rows.forEach((row, i) => {
      const div = document.createElement('div');
      div.className = `logRow ${row.severity}`;
      div.dataset.offset = String(offset + i);
      div.innerHTML = `
        <div class="ts">${fmtDate(row.ts)}</div>
        <div><span class="pill ${row.severity}">${row.severity}</span></div>
        <div class="service">${row.service}</div>
        <div class="message"></div>
      `;
      div.querySelector('.message').textContent = row.message;
      frag.appendChild(div);
    });
    rowsEl.appendChild(frag);
    const first = total === 0 ? 0 : offset + 1;
    const last = Math.min(total, offset + rows.length);
    visibleCount.textContent = `${first.toLocaleString()}-${last.toLocaleString()} of ${total.toLocaleString()}`;
  } else {
    // Temporary skeleton only for the current visible window, never all rows.
    const frag = document.createDocumentFragment();
    const skeletonCount = Math.min(limit, Math.ceil(scroller.clientHeight / ROW_HEIGHT) + OVERSCAN);
    for (let i = 0; i < skeletonCount; i++) {
      const div = document.createElement('div');
      div.className = 'logRow loading';
      div.innerHTML = '<div></div><div></div><div></div><div>Loading…</div>';
      frag.appendChild(div);
    }
    rowsEl.appendChild(frag);
    visibleCount.textContent = `loading of ${total.toLocaleString()}`;
    scheduleFetch(offset, Math.max(limit, 80), 0);
  }
}

async function resetAndLoad() {
  filters = { severity: severityFilter.value, q: searchBox.value.trim() };
  cache.clear();
  lastRenderKey = '';
  if (inFlight) inFlight.abort();
  requestSeq++;
  scroller.scrollTop = 0;
  total = isInitial ? total : 0;
  spacer.style.height = `${total * ROW_HEIGHT}px`;
  rowsEl.innerHTML = '';
  isInitial = false;
  await fetchWindow(0, Math.min(API_LIMIT, Math.ceil(scroller.clientHeight / ROW_HEIGHT) + OVERSCAN * 2 || 80));
}

const debouncedFilter = debounce(resetAndLoad, 250);
severityFilter.addEventListener('change', resetAndLoad);
searchBox.addEventListener('input', debouncedFilter);

let raf = 0;
scroller.addEventListener('scroll', () => {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    render();
  });
}, { passive: true });

window.addEventListener('resize', () => render());

loadStats();
resetAndLoad();
