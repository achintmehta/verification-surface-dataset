import { fetchLogs, fetchStats } from './api.js';
import { VirtualScroller } from './virtualScroller.js';

// ===== DOM References =====
const severitySelect  = document.getElementById('severity-select');
const searchInput     = document.getElementById('search-input');
const rowCountEl      = document.getElementById('row-count');
const statsBadgesEl   = document.getElementById('stats-badges');
const scrollContainer = document.getElementById('scroll-container');
const spacer          = document.getElementById('scroll-spacer');

// ===== State =====
let currentSeverity = '';
let currentQ        = '';
let currentTotal    = 0;
let searchDebounceTimer = null;
let requestSeq = 0; // monotonically increasing — stale-response guard

// ===== Helpers =====
function formatTs(isoStr) {
  return isoStr.replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ===== Row renderer =====
function renderRow(el, rowData) {
  if (!rowData) { el.innerHTML = ''; return; }
  const sev = rowData.severity || 'debug';
  el.innerHTML =
    `<div class="col-ts">${formatTs(rowData.ts)}</div>` +
    `<div class="col-severity"><span class="severity-pill ${sev}">${sev}</span></div>` +
    `<div class="col-service" title="${escHtml(rowData.service)}">${escHtml(rowData.service)}</div>` +
    `<div class="col-message" title="${escHtml(rowData.message)}">${escHtml(rowData.message)}</div>`;
}

// ===== Virtual Scroller =====
const scroller = new VirtualScroller({
  scrollContainer,
  spacer,
  rowsContainer: scrollContainer,
  fetchWindow: async (offset, limit, signal) => {
    const seq = ++requestSeq;
    // Use bootstrap data for the very first fetch (offset 0, no filters)
    if (offset === 0 && !currentSeverity && !currentQ && window.__BOOTSTRAP__) {
      const b = window.__BOOTSTRAP__;
      window.__BOOTSTRAP__ = null; // consume once
      return { total: b.total, rows: b.rows.slice(0, limit) };
    }
    const result = await fetchLogs(
      { offset, limit, severity: currentSeverity, q: currentQ },
      signal
    );
    if (seq < requestSeq) throw new DOMException('Stale', 'AbortError');
    return result;
  },
  renderRow,
  onTotalChange: (total) => {
    currentTotal = total;
    updateRowCount();
  },
});

// ===== Row count =====
function updateRowCount() {
  const active = currentSeverity || currentQ;
  rowCountEl.textContent = active
    ? `${currentTotal.toLocaleString()} matching rows`
    : `${currentTotal.toLocaleString()} rows`;
}

// ===== Stats badges =====
function renderBadges(bySeverity) {
  statsBadgesEl.innerHTML = '';
  for (const sev of ['error', 'warn', 'info', 'debug']) {
    const count = bySeverity[sev] ?? 0;
    const btn = document.createElement('button');
    btn.className = `badge ${sev}`;
    btn.dataset.severity = sev;
    btn.title = `Filter by ${sev}`;
    btn.innerHTML = `${sev} <span>${count.toLocaleString()}</span>`;
    btn.addEventListener('click', () => {
      severitySelect.value = severitySelect.value === sev ? '' : sev;
      severitySelect.dispatchEvent(new Event('change'));
    });
    statsBadgesEl.appendChild(btn);
  }
  updateBadgeActive();
}

function updateBadgeActive() {
  for (const b of statsBadgesEl.querySelectorAll('.badge')) {
    b.classList.toggle('active', b.dataset.severity === currentSeverity);
  }
}

async function refreshStats() {
  try {
    const stats = await fetchStats();
    renderBadges(stats.bySeverity);
  } catch (err) {
    console.warn('[stats]', err);
  }
}

// ===== Filter handlers =====
severitySelect.addEventListener('change', () => {
  currentSeverity = severitySelect.value;
  updateBadgeActive();
  scroller.reset();
});

searchInput.addEventListener('input', () => {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    currentQ = searchInput.value.trim();
    scroller.reset();
  }, 300);
});

// ===== Boot — synchronous first render using bootstrap data =====
const bootstrap = window.__BOOTSTRAP__;
if (bootstrap) {
  // Render badges immediately from bootstrap data
  renderBadges(bootstrap.bySeverity);
  // Start the scroller — it will use bootstrap data for offset 0
  scroller.reset();
  // Refresh stats in background (not blocking)
  refreshStats();
} else {
  // No bootstrap data (e.g. dev mode) — fetch everything async
  refreshStats();
  scroller.reset();
}
