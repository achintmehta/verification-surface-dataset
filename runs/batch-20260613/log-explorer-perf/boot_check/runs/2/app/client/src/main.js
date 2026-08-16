import { VirtualScroller } from './virtualScroller.js';
import { fetchStats } from './api.js';

// ── DOM refs ──────────────────────────────────────────────────────────────────
const scrollerEl   = document.getElementById('virtual-scroller');
const spacerEl     = document.getElementById('scroll-spacer');
const containerEl  = document.getElementById('rows-container');
const severitySelect = document.getElementById('severity-select');
const searchInput  = document.getElementById('search-input');
const rowCountEl   = document.getElementById('row-count');
const statusTextEl = document.getElementById('status-text');
const badgesEl     = document.getElementById('severity-badges');

// ── Constants ─────────────────────────────────────────────────────────────────
const DEBOUNCE_MS = 250;

// ── State ─────────────────────────────────────────────────────────────────────
let debounceTimer = null;

// ── Virtual Scroller ──────────────────────────────────────────────────────────
const scroller = new VirtualScroller({
  scrollerEl,
  spacerEl,
  containerEl,

  onStatusChange(status) {
    if (status === 'loading') {
      statusTextEl.innerHTML = '<span class="loading-indicator"></span>Fetching rows\u2026';
    } else if (status === 'ready') {
      statusTextEl.textContent = 'Ready';
    } else if (status === 'error') {
      statusTextEl.textContent = 'Error fetching rows — check server connection';
    }
  },

  onCountChange(total, filters) {
    const hasFilter = filters.severity || filters.q;
    if (hasFilter) {
      rowCountEl.textContent = `${total.toLocaleString()} of 100,000 rows`;
    } else {
      rowCountEl.textContent = `${total.toLocaleString()} rows`;
    }
  },
});

// ── Severity badges ───────────────────────────────────────────────────────────
async function loadStats() {
  try {
    const stats = await fetchStats();
    const severities = ['error', 'warn', 'info', 'debug'];

    badgesEl.innerHTML = severities
      .map(
        (sev) =>
          `<span class="badge ${sev}" data-sev="${sev}" title="Click to filter by ${sev}">` +
          `${sev.toUpperCase()} <strong>${(stats.bySeverity[sev] ?? 0).toLocaleString()}</strong>` +
          `</span>`
      )
      .join('');

    // Badge click → toggle severity filter
    badgesEl.querySelectorAll('.badge').forEach((badge) => {
      badge.addEventListener('click', () => {
        const sev = badge.dataset.sev;
        severitySelect.value = severitySelect.value === sev ? '' : sev;
        applyFilters();
      });
    });
  } catch (err) {
    console.warn('[stats] Failed to load stats:', err);
  }
}

// ── Filter application ────────────────────────────────────────────────────────
function applyFilters() {
  const severity = severitySelect.value;
  const q = searchInput.value; // don't trim here — trim in API layer
  scroller.setFilters({ severity, q });
}

// ── Event listeners ───────────────────────────────────────────────────────────
severitySelect.addEventListener('change', () => {
  clearTimeout(debounceTimer);
  applyFilters();
});

// Debounce search input so the input field is never blocked
searchInput.addEventListener('input', () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(applyFilters, DEBOUNCE_MS);
});

// Prevent accidental form submission
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') e.preventDefault();
});

// ── Boot ──────────────────────────────────────────────────────────────────────
async function boot() {
  statusTextEl.innerHTML = '<span class="loading-indicator"></span>Connecting to server\u2026';
  rowCountEl.textContent = 'Loading\u2026';

  // Load stats (badges) and initial rows in parallel
  await Promise.all([
    loadStats(),
    scroller.setFilters({ severity: '', q: '' }),
  ]);
}

boot().catch((err) => {
  console.error('[boot] Error:', err);
  statusTextEl.textContent = 'Failed to connect to server. Is the backend running?';
  rowCountEl.textContent = 'Error';
});
