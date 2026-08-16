const API_BASE = '';

// --- State ---
let totalRows = 0;
let currentSeverity = '';
let currentQuery = '';
let fetchRequestId = 0; // Monotonically increasing to detect stale responses
let debounceTimer = null;
let rowCache = new Map(); // windowKey -> rows
let pendingFetches = new Map(); // windowKey -> AbortController
let stats = null;

// --- Virtual Scroll Config ---
const ROW_HEIGHT = 28;
const OVERSCAN = 10;
const WINDOW_SIZE = 100; // Fetch window size (must be <= 200, the server max)
const MAX_CACHE_WINDOWS = 20;

// --- DOM Elements ---
const scrollContainer = document.getElementById('scroll-container');
const scrollSpacer = document.getElementById('scroll-spacer');
const viewport = document.getElementById('viewport');
const severityFilter = document.getElementById('severity-filter');
const searchInput = document.getElementById('search-input');
const rowCountEl = document.getElementById('row-count');
const badgesEl = document.getElementById('severity-badges');

// --- API ---
async function fetchLogs(offset, limit, requestId, signal) {
  const params = new URLSearchParams({
    offset: String(offset),
    limit: String(limit)
  });
  if (currentSeverity) params.set('severity', currentSeverity);
  if (currentQuery) params.set('q', currentQuery);

  const response = await fetch(`${API_BASE}/api/logs?${params}`, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  
  const data = await response.json();
  return { data, requestId };
}

async function fetchStats() {
  const response = await fetch(`${API_BASE}/api/stats`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

// --- Row Rendering ---
function createRowElement(row) {
  const el = document.createElement('div');
  el.className = 'log-row';
  
  const tsCol = document.createElement('div');
  tsCol.className = 'col col-ts col-ts-val';
  tsCol.textContent = formatTimestamp(row.ts);
  
  const sevCol = document.createElement('div');
  sevCol.className = 'col col-severity';
  const sevBadge = document.createElement('span');
  sevBadge.className = `severity-badge severity-${row.severity}`;
  sevBadge.textContent = row.severity;
  sevCol.appendChild(sevBadge);
  
  const svcCol = document.createElement('div');
  svcCol.className = 'col col-service col-service-val';
  svcCol.textContent = row.service;
  
  const msgCol = document.createElement('div');
  msgCol.className = 'col col-message';
  msgCol.textContent = row.message;
  
  el.appendChild(tsCol);
  el.appendChild(sevCol);
  el.appendChild(svcCol);
  el.appendChild(msgCol);
  
  return el;
}

function formatTimestamp(ts) {
  const d = new Date(ts);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hours = String(d.getHours()).padStart(2, '0');
  const mins = String(d.getMinutes()).padStart(2, '0');
  const secs = String(d.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${mins}:${secs}`;
}

// --- Virtual Scroll ---
function getWindowKey(rowIndex) {
  return Math.floor(rowIndex / WINDOW_SIZE) * WINDOW_SIZE;
}

function updateScrollHeight() {
  scrollSpacer.style.height = `${totalRows * ROW_HEIGHT}px`;
}

function getVisibleRange() {
  const scrollTop = scrollContainer.scrollTop;
  const containerHeight = scrollContainer.clientHeight;
  
  const startRow = Math.floor(scrollTop / ROW_HEIGHT);
  const visibleCount = Math.ceil(containerHeight / ROW_HEIGHT);
  
  const firstRow = Math.max(0, startRow - OVERSCAN);
  const lastRow = Math.min(totalRows - 1, startRow + visibleCount + OVERSCAN);
  
  return { firstRow, lastRow, startRow, visibleCount };
}

async function loadWindowIfNeeded(windowStart) {
  const key = windowStart;
  if (rowCache.has(key) || pendingFetches.has(key)) return;
  
  const myRequestId = fetchRequestId;
  const abortController = new AbortController();
  pendingFetches.set(key, abortController);
  
  try {
    const limit = Math.min(WINDOW_SIZE, Math.max(0, totalRows - windowStart));
    if (limit <= 0) {
      pendingFetches.delete(key);
      return;
    }
    
    const { data, requestId } = await fetchLogs(windowStart, limit, myRequestId, abortController.signal);
    
    // Check if this request is still relevant
    if (requestId !== fetchRequestId) {
      pendingFetches.delete(key);
      return; // Stale response
    }
    
    // Update total if it changed
    if (data.total !== totalRows) {
      totalRows = data.total;
      updateScrollHeight();
      updateRowCount();
    }
    
    rowCache.set(key, data.rows);
    evictDistantCacheEntries();
    
    pendingFetches.delete(key);
    renderViewport();
  } catch (err) {
    pendingFetches.delete(key);
    if (err.name !== 'AbortError') {
      console.error('Failed to load window:', err);
    }
  }
}

function evictDistantCacheEntries() {
  if (rowCache.size <= MAX_CACHE_WINDOWS) return;
  
  const { firstRow, lastRow } = getVisibleRange();
  const currentCenter = (firstRow + lastRow) / 2;
  
  // Sort cache keys by distance from current view center
  const keys = Array.from(rowCache.keys());
  keys.sort((a, b) => {
    const distA = Math.abs(a + WINDOW_SIZE / 2 - currentCenter);
    const distB = Math.abs(b + WINDOW_SIZE / 2 - currentCenter);
    return distB - distA; // Furthest first
  });
  
  // Remove furthest entries
  while (rowCache.size > MAX_CACHE_WINDOWS) {
    rowCache.delete(keys.shift());
  }
}

function renderViewport() {
  if (totalRows === 0) {
    viewport.innerHTML = '<div style="padding: 40px; text-align: center; color: #8b949e;">No log entries found</div>';
    viewport.style.transform = 'translateY(0px)';
    return;
  }
  
  const { firstRow, lastRow } = getVisibleRange();
  
  // Determine which windows we need
  const neededWindows = new Set();
  for (let i = firstRow; i <= lastRow; i++) {
    neededWindows.add(getWindowKey(i));
  }
  
  // Build rows
  const fragment = document.createDocumentFragment();
  
  for (let i = firstRow; i <= lastRow; i++) {
    const windowStart = getWindowKey(i);
    const windowData = rowCache.get(windowStart);
    
    if (windowData) {
      const indexInWindow = i - windowStart;
      if (indexInWindow >= 0 && indexInWindow < windowData.length) {
        fragment.appendChild(createRowElement(windowData[indexInWindow]));
      }
    } else {
      // Placeholder row
      const placeholder = document.createElement('div');
      placeholder.className = 'log-row';
      placeholder.style.opacity = '0.3';
      placeholder.innerHTML = '<div class="col col-message" style="color: #484f58;">Loading...</div>';
      fragment.appendChild(placeholder);
      
      // Trigger fetch for this window
      loadWindowIfNeeded(windowStart);
    }
  }
  
  // Replace viewport content
  viewport.innerHTML = '';
  viewport.appendChild(fragment);
  viewport.style.transform = `translateY(${firstRow * ROW_HEIGHT}px)`;
}

// --- Scroll Handler ---
let scrollRAF = null;
function onScroll() {
  if (scrollRAF) return;
  scrollRAF = requestAnimationFrame(() => {
    scrollRAF = null;
    renderViewport();
  });
}

// --- Filter Handlers ---
async function applyFilters() {
  // Increment request ID to invalidate stale responses
  fetchRequestId++;
  const myRequestId = fetchRequestId;
  
  // Abort all pending fetches
  for (const [key, controller] of pendingFetches) {
    controller.abort();
  }
  pendingFetches.clear();
  
  // Clear cache
  rowCache.clear();
  
  try {
    // Fetch first window to get total
    const abortController = new AbortController();
    const { data, requestId } = await fetchLogs(0, WINDOW_SIZE, myRequestId, abortController.signal);
    
    if (requestId !== fetchRequestId) return; // Stale
    
    totalRows = data.total;
    rowCache.set(0, data.rows);
    
    updateScrollHeight();
    updateRowCount();
    scrollContainer.scrollTop = 0;
    renderViewport();
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error('Failed to apply filters:', err);
    }
  }
}

function onSeverityChange() {
  currentSeverity = severityFilter.value;
  applyFilters();
}

function onSearchInput() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    currentQuery = searchInput.value.trim();
    applyFilters();
  }, 250);
}

function updateRowCount() {
  const visibleCount = Math.min(
    Math.ceil(scrollContainer.clientHeight / ROW_HEIGHT),
    totalRows
  );
  rowCountEl.textContent = `${visibleCount} of ${totalRows.toLocaleString()} entries`;
}

function updateBadges() {
  if (!stats) return;
  badgesEl.innerHTML = '';
  for (const sev of ['debug', 'info', 'warn', 'error']) {
    const badge = document.createElement('span');
    badge.className = `badge badge-${sev}`;
    badge.textContent = `${sev}: ${stats[sev].toLocaleString()}`;
    badgesEl.appendChild(badge);
  }
}

// --- Init ---
async function init() {
  // Attach event listeners
  scrollContainer.addEventListener('scroll', onScroll, { passive: true });
  severityFilter.addEventListener('change', onSeverityChange);
  searchInput.addEventListener('input', onSearchInput);
  
  // Load stats
  try {
    stats = await fetchStats();
    updateBadges();
  } catch (err) {
    console.error('Failed to load stats:', err);
  }
  
  // Initial load
  await applyFilters();
  
  // Update row count on resize
  window.addEventListener('resize', () => {
    updateRowCount();
    renderViewport();
  });
}

init();
