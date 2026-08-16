// ─── Constants ──────────────────────────────────────────────────────────────
const ROW_HEIGHT = 36;          // Must match CSS --row-height
const OVERSCAN = 10;            // Extra rows above/below viewport
const FETCH_PAGE_SIZE = 100;    // Rows per API request
const DEBOUNCE_MS = 250;        // Search debounce
const API_BASE = "/api";

// ─── DOM references ─────────────────────────────────────────────────────────
const container = document.getElementById("virtual-container");
const spacer = document.getElementById("virtual-spacer");
const content = document.getElementById("virtual-content");
const severitySelect = document.getElementById("severity-select");
const searchInput = document.getElementById("search-input");
const rowCountEl = document.getElementById("row-count");
const severityBadgesEl = document.getElementById("severity-badges");

// ─── State ──────────────────────────────────────────────────────────────────
let totalRows = 0;
let currentSeverity = "";
let currentQuery = "";
let requestGeneration = 0;      // Monotonic counter to discard stale responses
let cache = new Map();           // pageStart -> { rows, generation }
let pendingFetches = new Map();  // pageStart -> { promise, generation }
let rowPool = [];                // Recycled DOM row elements
let activeRows = new Map();      // rowIndex -> DOM element (currently in DOM)
let lastRangeStart = -1;
let lastRangeEnd = -1;
let filterAbortController = null; // For cancelling stale filter fetches

// ─── API layer ──────────────────────────────────────────────────────────────

async function fetchLogs(offset, limit, signal) {
  const params = new URLSearchParams({ offset: String(offset), limit: String(limit) });
  if (currentSeverity) params.set("severity", currentSeverity);
  if (currentQuery) params.set("q", currentQuery);

  const res = await fetch(`${API_BASE}/logs?${params}`, { signal });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

async function fetchStats() {
  const res = await fetch(`${API_BASE}/stats`);
  if (!res.ok) throw new Error(`Stats API error: ${res.status}`);
  return res.json();
}

// ─── Cache & Fetch management ───────────────────────────────────────────────

function invalidateCache() {
  cache.clear();
  pendingFetches.clear();
}

/**
 * Ensure rows for [offset, offset+count) are in the cache.
 * Fetches any missing pages.
 */
async function ensureRows(offset, count, generation) {
  // Align to page boundaries for efficient caching
  const pageStart = Math.floor(offset / FETCH_PAGE_SIZE) * FETCH_PAGE_SIZE;
  const pagesNeeded = Math.ceil((offset + count) / FETCH_PAGE_SIZE) * FETCH_PAGE_SIZE;

  const fetches = [];

  for (let p = pageStart; p < pagesNeeded; p += FETCH_PAGE_SIZE) {
    // Already cached for this generation
    if (cache.has(p) && cache.get(p).generation === generation) continue;

    // Already being fetched for this generation
    if (pendingFetches.has(p) && pendingFetches.get(p).generation === generation) {
      fetches.push(pendingFetches.get(p).promise);
      continue;
    }

    const limit = Math.min(FETCH_PAGE_SIZE, totalRows - p);
    if (limit <= 0) continue;

    const promise = fetchLogs(p, limit)
      .then((data) => {
        if (generation === requestGeneration) {
          cache.set(p, { rows: data.rows, generation });
        }
        pendingFetches.delete(p);
        return data;
      })
      .catch((err) => {
        pendingFetches.delete(p);
        // Don't rethrow - just means rows won't be available yet
        if (err.name !== "AbortError") {
          console.warn("Fetch error for page", p, err);
        }
      });

    pendingFetches.set(p, { promise, generation });
    fetches.push(promise);
  }

  if (fetches.length > 0) {
    await Promise.all(fetches);
  }
}

function getCachedRow(index) {
  const pageStart = Math.floor(index / FETCH_PAGE_SIZE) * FETCH_PAGE_SIZE;
  const entry = cache.get(pageStart);
  if (!entry) return null;
  const localIndex = index - pageStart;
  return localIndex < entry.rows.length ? entry.rows[localIndex] : null;
}

// ─── Row DOM pool ───────────────────────────────────────────────────────────

function createRowElement() {
  const row = document.createElement("div");
  row.className = "log-row";

  const tsDiv = document.createElement("div");
  tsDiv.className = "col-ts";

  const sevDiv = document.createElement("div");
  sevDiv.className = "col-severity";
  const pill = document.createElement("span");
  pill.className = "severity-pill";
  sevDiv.appendChild(pill);

  const svcDiv = document.createElement("div");
  svcDiv.className = "col-service";

  const msgDiv = document.createElement("div");
  msgDiv.className = "col-message";

  row.appendChild(tsDiv);
  row.appendChild(sevDiv);
  row.appendChild(svcDiv);
  row.appendChild(msgDiv);

  return row;
}

function acquireRow() {
  return rowPool.length > 0 ? rowPool.pop() : createRowElement();
}

function releaseRow(el) {
  rowPool.push(el);
}

function formatTimestamp(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function bindRow(el, data, index) {
  el.children[0].textContent = formatTimestamp(data.ts);

  const pill = el.children[1].firstElementChild;
  pill.textContent = data.severity;
  pill.className = `severity-pill sev-${data.severity}`;

  el.children[2].textContent = data.service;
  el.children[3].textContent = data.message;

  el.style.position = "absolute";
  el.style.left = "0";
  el.style.right = "0";
  el.style.height = `${ROW_HEIGHT}px`;
  el.style.transform = `translateY(${index * ROW_HEIGHT}px)`;
  el.dataset.index = index;
}

// ─── Rendering ──────────────────────────────────────────────────────────────

function getVisibleRange() {
  const scrollTop = container.scrollTop;
  const viewportHeight = container.clientHeight;
  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(totalRows, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN);
  return { start, end };
}

async function renderVisibleRows() {
  if (totalRows === 0) {
    // Clear everything
    for (const [, el] of activeRows) {
      content.removeChild(el);
      releaseRow(el);
    }
    activeRows.clear();
    lastRangeStart = -1;
    lastRangeEnd = -1;
    return;
  }

  const { start, end } = getVisibleRange();

  // Short-circuit if range hasn't changed
  if (start === lastRangeStart && end === lastRangeEnd) return;

  const gen = requestGeneration;

  // Ensure data is available for this range
  await ensureRows(start, end - start, gen);

  // If a newer filter/request has happened during the fetch, bail out
  if (gen !== requestGeneration) return;

  // Remove rows that are no longer visible
  const toRemove = [];
  for (const [idx, el] of activeRows) {
    if (idx < start || idx >= end) {
      toRemove.push(idx);
    }
  }
  for (const idx of toRemove) {
    const el = activeRows.get(idx);
    content.removeChild(el);
    releaseRow(el);
    activeRows.delete(idx);
  }

  // Add/update rows that are now visible
  for (let i = start; i < end; i++) {
    const data = getCachedRow(i);
    if (!data) continue;

    let el = activeRows.get(i);
    if (!el) {
      el = acquireRow();
      activeRows.set(i, el);
      content.appendChild(el);
    }
    bindRow(el, data, i);
  }

  lastRangeStart = start;
  lastRangeEnd = end;
}

// ─── Scroll handler ─────────────────────────────────────────────────────────

let scrollRafId = null;

function onScroll() {
  if (scrollRafId !== null) return;
  scrollRafId = requestAnimationFrame(() => {
    scrollRafId = null;
    renderVisibleRows();
    updateRowCount();
  });
}

container.addEventListener("scroll", onScroll, { passive: true });

// ─── Filter management ─────────────────────────────────────────────────────

async function applyFilters() {
  // Cancel any in-flight filter request
  if (filterAbortController) {
    filterAbortController.abort();
  }
  filterAbortController = new AbortController();
  const signal = filterAbortController.signal;

  const gen = ++requestGeneration;

  // Invalidate cache
  invalidateCache();

  // Clear displayed rows
  for (const [, el] of activeRows) {
    content.removeChild(el);
    releaseRow(el);
  }
  activeRows.clear();
  lastRangeStart = -1;
  lastRangeEnd = -1;

  // Fetch first page to get total count
  try {
    const data = await fetchLogs(0, FETCH_PAGE_SIZE, signal);

    // Discard if stale
    if (gen !== requestGeneration) return;

    totalRows = data.total;
    cache.set(0, { rows: data.rows, generation: gen });

    // Update spacer height
    spacer.style.height = `${totalRows * ROW_HEIGHT}px`;

    // Reset scroll
    container.scrollTop = 0;

    // Update counter
    updateRowCount();

    // Render visible rows
    await renderVisibleRows();
  } catch (err) {
    if (err.name === "AbortError") return; // Expected when superseded
    console.error("Filter apply error:", err);
  }
}

function updateRowCount() {
  const filterDesc = [];
  if (currentSeverity) filterDesc.push(currentSeverity);
  if (currentQuery) filterDesc.push(`"${currentQuery}"`);
  const filterText = filterDesc.length > 0 ? ` (filtered: ${filterDesc.join(", ")})` : "";

  const { start, end } = getVisibleRange();
  const visibleCount = Math.max(0, end - start);
  rowCountEl.textContent = `${visibleCount} of ${totalRows.toLocaleString()} rows${filterText}`;
}

// Severity select
severitySelect.addEventListener("change", () => {
  currentSeverity = severitySelect.value;
  applyFilters();
});

// Debounced search – typing never blocks the input
let searchTimeout = null;
searchInput.addEventListener("input", () => {
  if (searchTimeout !== null) clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    searchTimeout = null;
    currentQuery = searchInput.value.trim();
    applyFilters();
  }, DEBOUNCE_MS);
});

// ─── Stats / badges ────────────────────────────────────────────────────────

async function loadStats() {
  try {
    const stats = await fetchStats();
    severityBadgesEl.innerHTML = [
      `<span class="badge badge-debug">DBG ${stats.debug.toLocaleString()}</span>`,
      `<span class="badge badge-info">INF ${stats.info.toLocaleString()}</span>`,
      `<span class="badge badge-warn">WRN ${stats.warn.toLocaleString()}</span>`,
      `<span class="badge badge-error">ERR ${stats.error.toLocaleString()}</span>`,
    ].join("");
  } catch (err) {
    console.error("Stats error:", err);
  }
}

// ─── Boot ───────────────────────────────────────────────────────────────────

async function boot() {
  await Promise.all([applyFilters(), loadStats()]);
}

boot();
