// ── Constants ────────────────────────────────────────────────────────────────
const ROW_HEIGHT = 28;
const OVERSCAN = 10;           // extra rows above and below viewport
const FETCH_PAGE_SIZE = 100;   // rows per API request
const DEBOUNCE_MS = 250;       // search debounce delay
const API_BASE = "/api";

// ── State ────────────────────────────────────────────────────────────────────
let totalRows = 0;
let currentSeverity = "";
let currentQuery = "";
let fetchVersion = 0;     // monotonic counter to discard stale responses
const MAX_CACHED_PAGES = 50; // evict oldest pages beyond this
let cache = new Map();    // offset -> rows[]  (keyed by page-aligned offset)
let pendingFetches = new Map(); // offset -> Promise
let lastRenderedStart = -1;
let lastRenderedEnd = -1;

// ── DOM refs ─────────────────────────────────────────────────────────────────
const scroller = document.getElementById("virtual-scroller");
const spacer = document.getElementById("scroll-spacer");
const container = document.getElementById("row-container");
const severityFilter = document.getElementById("severity-filter");
const searchInput = document.getElementById("search-input");
const rowCountEl = document.getElementById("row-count");
const badgesEl = document.getElementById("severity-badges");

// ── API helpers ──────────────────────────────────────────────────────────────

async function fetchLogs(offset, limit, version) {
  const params = new URLSearchParams();
  params.set("offset", offset);
  params.set("limit", limit);
  if (currentSeverity) params.set("severity", currentSeverity);
  if (currentQuery) params.set("q", currentQuery);

  const res = await fetch(`${API_BASE}/logs?${params}`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  const data = await res.json();

  // Discard if stale
  if (version !== fetchVersion) return null;

  return data;
}

async function fetchStats() {
  const res = await fetch(`${API_BASE}/stats`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

// ── Cache management ─────────────────────────────────────────────────────────

function clearCache() {
  cache.clear();
  pendingFetches.clear();
}

function pageAlignedOffset(offset) {
  return Math.floor(offset / FETCH_PAGE_SIZE) * FETCH_PAGE_SIZE;
}

async function ensurePage(pageOffset, version) {
  if (cache.has(pageOffset)) return cache.get(pageOffset);

  // Avoid duplicate fetches for the same page
  if (pendingFetches.has(pageOffset)) {
    return pendingFetches.get(pageOffset);
  }

  const promise = fetchLogs(pageOffset, FETCH_PAGE_SIZE, version).then((data) => {
    pendingFetches.delete(pageOffset);
    if (data === null) return null; // stale
    // Update total from every fresh response
    totalRows = data.total;
    updateSpacerHeight();
    updateRowCount();
    cache.set(pageOffset, data.rows);
    // Simple LRU eviction: if too many pages, delete the oldest
    if (cache.size > MAX_CACHED_PAGES) {
      const firstKey = cache.keys().next().value;
      cache.delete(firstKey);
    }
    return data.rows;
  }).catch((err) => {
    pendingFetches.delete(pageOffset);
    console.error("Fetch error:", err);
    return null;
  });

  pendingFetches.set(pageOffset, promise);
  return promise;
}

// ── Rendering ────────────────────────────────────────────────────────────────

function formatTimestamp(ts) {
  const d = new Date(ts);
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function createRowEl(row, index) {
  const el = document.createElement("div");
  el.className = "log-row";
  el.style.transform = `translateY(${index * ROW_HEIGHT}px)`;
  el.style.position = "absolute";
  el.style.left = "0";
  el.style.right = "0";

  el.innerHTML = `
    <div class="col col-ts">${formatTimestamp(row.ts)}</div>
    <div class="col col-severity severity-${row.severity}">${row.severity.toUpperCase()}</div>
    <div class="col col-service">${escapeHtml(row.service)}</div>
    <div class="col col-message">${escapeHtml(row.message)}</div>
  `;
  return el;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function renderVisibleRows() {
  const scrollTop = scroller.scrollTop;
  const viewportHeight = scroller.clientHeight;

  // Calculate visible row range
  const firstVisible = Math.floor(scrollTop / ROW_HEIGHT);
  const lastVisible = Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) - 1;

  // Add overscan
  const renderStart = Math.max(0, firstVisible - OVERSCAN);
  const renderEnd = Math.min(totalRows - 1, lastVisible + OVERSCAN);

  if (renderStart === lastRenderedStart && renderEnd === lastRenderedEnd) {
    return; // Nothing changed
  }

  lastRenderedStart = renderStart;
  lastRenderedEnd = renderEnd;

  const version = fetchVersion;

  // Determine which pages we need
  const neededPages = new Set();
  for (let i = renderStart; i <= renderEnd; i += FETCH_PAGE_SIZE) {
    neededPages.add(pageAlignedOffset(i));
  }
  // Also add the page for the last row
  neededPages.add(pageAlignedOffset(renderEnd));

  // Fetch all needed pages concurrently
  const pagePromises = [];
  for (const po of neededPages) {
    pagePromises.push(ensurePage(po, version));
  }
  await Promise.all(pagePromises);

  // If stale, abort
  if (version !== fetchVersion) return;

  // Build DOM fragment
  const fragment = document.createDocumentFragment();
  let rowCount = 0;

  for (let i = renderStart; i <= renderEnd; i++) {
    const po = pageAlignedOffset(i);
    const pageRows = cache.get(po);
    if (!pageRows) continue;

    const rowInPage = i - po;
    if (rowInPage >= pageRows.length) continue;

    const row = pageRows[rowInPage];
    fragment.appendChild(createRowEl(row, i));
    rowCount++;
  }

  // Replace entire container content
  container.innerHTML = "";
  container.appendChild(fragment);
}

// ── Spacer & Count ───────────────────────────────────────────────────────────

function updateSpacerHeight() {
  spacer.style.height = `${totalRows * ROW_HEIGHT}px`;
}

function updateRowCount() {
  const visibleInDOM = container.childElementCount;
  rowCountEl.textContent = `${visibleInDOM} of ${totalRows.toLocaleString()} rows`;
}

// ── Stats / Badges ───────────────────────────────────────────────────────────

async function loadStats() {
  try {
    const stats = await fetchStats();
    badgesEl.innerHTML = `
      <span class="badge badge-debug">D: ${stats.debug.toLocaleString()}</span>
      <span class="badge badge-info">I: ${stats.info.toLocaleString()}</span>
      <span class="badge badge-warn">W: ${stats.warn.toLocaleString()}</span>
      <span class="badge badge-error">E: ${stats.error.toLocaleString()}</span>
    `;
  } catch (e) {
    console.error("Failed to load stats:", e);
  }
}

// ── Filter changes ──────────────────────────────────────────────────────────

function onFilterChange() {
  fetchVersion++;
  clearCache();
  lastRenderedStart = -1;
  lastRenderedEnd = -1;
  container.innerHTML = "";
  scroller.scrollTop = 0;

  // We need to do an initial fetch to get the total
  const version = fetchVersion;
  fetchLogs(0, FETCH_PAGE_SIZE, version).then((data) => {
    if (data === null) return; // stale
    totalRows = data.total;
    cache.set(0, data.rows);
    updateSpacerHeight();
    renderVisibleRows().then(updateRowCount);
  });
}

// Severity change
severityFilter.addEventListener("change", () => {
  currentSeverity = severityFilter.value;
  onFilterChange();
});

// Search with debounce
let searchTimeout = null;
searchInput.addEventListener("input", () => {
  if (searchTimeout) clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    currentQuery = searchInput.value.trim();
    onFilterChange();
  }, DEBOUNCE_MS);
});

// ── Scroll handling ─────────────────────────────────────────────────────────

let scrollRAF = null;

scroller.addEventListener("scroll", () => {
  if (scrollRAF) return;
  scrollRAF = requestAnimationFrame(() => {
    scrollRAF = null;
    renderVisibleRows().then(updateRowCount);
  });
}, { passive: true });

// ── Initial load ────────────────────────────────────────────────────────────

async function init() {
  rowCountEl.textContent = "Loading...";

  // Load stats for badges
  loadStats();

  // Initial data fetch
  const version = fetchVersion;
  const data = await fetchLogs(0, FETCH_PAGE_SIZE, version);
  if (data === null) return;

  totalRows = data.total;
  cache.set(0, data.rows);
  updateSpacerHeight();
  await renderVisibleRows();
  updateRowCount();
}

init();
