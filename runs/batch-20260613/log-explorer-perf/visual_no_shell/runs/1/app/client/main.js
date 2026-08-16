/**
 * Log Explorer — Virtualized Frontend
 *
 * Key design decisions:
 *
 * 1. Virtual scrolling: the DOM holds only the rows intersecting the viewport
 *    plus OVERSCAN rows above/below. Total scroll height is set via a spacer
 *    element so the native scrollbar reflects the full corpus size.
 *
 * 2. Window fetching: rows are fetched in FETCH_LIMIT-sized windows aligned to
 *    FETCH_LIMIT boundaries. A small LRU cache avoids re-fetching recently
 *    visited windows. On scroll, if the visible range falls outside the loaded
 *    window, a new fetch is triggered.
 *
 * 3. Stale-response guard: every fetch carries a monotonically increasing
 *    sequence number. Responses whose sequence number doesn't match the latest
 *    are silently discarded.
 *
 * 4. Debounced search: the search input fires after DEBOUNCE_MS ms. Each filter
 *    change creates a new AbortController, cancelling any in-flight request.
 *
 * 5. No blank regions: while a fetch is in flight, the previously rendered rows
 *    remain visible. A loading indicator appears in the corner.
 */

const API_BASE = 'http://localhost:3001';

// ── Tuning constants ──────────────────────────────────────────────────────────
const ROW_HEIGHT   = 36;   // px — must match CSS var(--row-height)
const OVERSCAN     = 15;   // rows above/below viewport to pre-render
const FETCH_LIMIT  = 150;  // rows per API request (≤ 200 server cap)
const DEBOUNCE_MS  = 250;  // search debounce delay
const CACHE_SLOTS  = 12;   // number of fetched windows to keep in memory

// ─── Utilities ────────────────────────────────────────────────────────────────

function debounce(fn, ms) {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function formatTs(iso) {
  const d = new Date(iso);
  const z2 = n => String(n).padStart(2, '0');
  const z3 = n => String(n).padStart(3, '0');
  return `${d.getFullYear()}-${z2(d.getMonth()+1)}-${z2(d.getDate())} ` +
         `${z2(d.getHours())}:${z2(d.getMinutes())}:${z2(d.getSeconds())}.${z3(d.getMilliseconds())}`;
}

function esc(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function highlight(text, q) {
  if (!q) return esc(text);
  const safe = esc(text);
  const safeQ = esc(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return safe.replace(new RegExp(safeQ, 'gi'), m => `<span class="highlight">${m}</span>`);
}

function fmt(n) { return n.toLocaleString(); }

// ─── API ──────────────────────────────────────────────────────────────────────

async function apiLogs({ offset, limit, severity, q }, signal) {
  const p = new URLSearchParams({ offset, limit });
  if (severity) p.set('severity', severity);
  if (q)        p.set('q', q);
  const r = await fetch(`${API_BASE}/api/logs?${p}`, { signal });
  if (!r.ok) {
    const b = await r.json().catch(() => ({ error: r.statusText }));
    throw new Error(b.error || r.statusText);
  }
  return r.json();
}

async function apiStats() {
  const r = await fetch(`${API_BASE}/api/stats`);
  if (!r.ok) throw new Error('stats fetch failed');
  return r.json();
}

// ─── LRU Window Cache ─────────────────────────────────────────────────────────

class WinCache {
  constructor(max) { this._max = max; this._m = new Map(); }
  _k(off, sev, q) { return `${off}|${sev}|${q}`; }
  get(off, sev, q) { return this._m.get(this._k(off, sev, q)); }
  set(off, sev, q, rows) {
    const k = this._k(off, sev, q);
    this._m.delete(k);
    if (this._m.size >= this._max) this._m.delete(this._m.keys().next().value);
    this._m.set(k, rows);
  }
  clear() { this._m.clear(); }
}

// ─── Virtual Scroller ─────────────────────────────────────────────────────────

class VirtualScroller {
  constructor(els) {
    Object.assign(this, els);   // container, viewport, spacer, loadingEl

    this.severity = '';
    this.query    = '';
    this.total    = 0;
    this.cache    = new WinCache(CACHE_SLOTS);

    // Currently loaded window
    this.winOff  = 0;
    this.winRows = [];

    // Fetch sequencing
    this.seq      = 0;
    this.fetching = false;
    this._abort   = null;   // AbortController for current filter session

    // rAF handle for scroll throttling
    this._raf = null;

    this.container.addEventListener('scroll', () => {
      if (this._raf) return;
      this._raf = requestAnimationFrame(() => { this._raf = null; this._onScroll(); });
    }, { passive: true });
  }

  // ── Public ──────────────────────────────────────────────────────────────────

  async reset(severity, query) {
    this.severity = severity;
    this.query    = query;
    this.total    = 0;
    this.winOff   = 0;
    this.winRows  = [];
    this.cache.clear();

    // Cancel in-flight requests for the old filter
    if (this._abort) this._abort.abort();
    this._abort = new AbortController();

    this.container.scrollTop = 0;
    this._spacer(0);
    this.viewport.innerHTML = '';

    await this._fetch(0);
  }

  // ── Scroll handler ───────────────────────────────────────────────────────────

  _onScroll() {
    const { start } = this._range();
    const winEnd = this.winOff + this.winRows.length - 1;

    // Need a new window if visible range is outside loaded window
    const outside = start < this.winOff || start > winEnd - OVERSCAN * 2;

    if (outside && !this.fetching) {
      this._fetch(Math.max(0, start - OVERSCAN));
    } else {
      this._render();
    }
  }

  // ── Fetch ────────────────────────────────────────────────────────────────────

  async _fetch(targetRow) {
    // Align to FETCH_LIMIT boundary for cache reuse
    const aligned = Math.floor(targetRow / FETCH_LIMIT) * FETCH_LIMIT;
    const { severity, query } = this;

    // Cache hit
    const cached = this.cache.get(aligned, severity, query);
    if (cached) {
      this.winOff  = aligned;
      this.winRows = cached;
      this._render();
      return;
    }

    const seq = ++this.seq;
    this.fetching = true;
    this._loading(true);

    try {
      const data = await apiLogs(
        { offset: aligned, limit: FETCH_LIMIT, severity, q: query },
        this._abort.signal
      );

      if (seq !== this.seq) return;   // stale — discard

      this.total   = data.total;
      this.winOff  = aligned;
      this.winRows = data.rows;

      this.cache.set(aligned, severity, query, data.rows);
      this._spacer(this.total * ROW_HEIGHT);
      this._render();
      this._updateUI();
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.error('fetch error:', err);
      this._status(`Error: ${err.message}`);
    } finally {
      if (seq === this.seq) { this.fetching = false; this._loading(false); }
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  _range() {
    const scrollTop = this.container.scrollTop;
    const clientH   = this.container.clientHeight;
    const first = Math.floor(scrollTop / ROW_HEIGHT);
    const last  = Math.ceil((scrollTop + clientH) / ROW_HEIGHT);
    return {
      start: Math.max(0, first - OVERSCAN),
      end:   Math.min(Math.max(0, this.total - 1), last + OVERSCAN),
    };
  }

  _render() {
    if (this.total === 0) {
      this.viewport.style.top = '0px';
      this.viewport.innerHTML =
        `<div class="empty-state">` +
        `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">` +
        `<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>` +
        `</svg><p>No log entries match your filters.</p></div>`;
      return;
    }

    const { start, end } = this._range();
    const winEnd = this.winOff + this.winRows.length - 1;

    // Clamp render range to what we have loaded
    const rStart = Math.max(start, this.winOff);
    const rEnd   = Math.min(end, winEnd);

    if (rStart > rEnd) return;  // nothing to render from current window

    this.viewport.style.top = `${rStart * ROW_HEIGHT}px`;

    let html = '';
    for (let i = rStart; i <= rEnd; i++) {
      const row = this.winRows[i - this.winOff];
      if (row) html += this._rowHtml(row);
    }
    this.viewport.innerHTML = html;
  }

  _rowHtml(row) {
    const sev = row.severity;
    return `<div class="log-row ${sev}">` +
      `<div class="col-ts">${formatTs(row.ts)}</div>` +
      `<div class="col-sev"><span class="sev-badge ${sev}">${sev}</span></div>` +
      `<div class="col-svc">${esc(row.service)}</div>` +
      `<div class="col-msg">${highlight(row.message, this.query)}</div>` +
      `</div>`;
  }

  // ── DOM helpers ──────────────────────────────────────────────────────────────

  _spacer(px)      { this.spacer.style.height = `${px}px`; }
  _loading(on)     { this.loadingEl.classList.toggle('visible', on); }
  _status(msg)     { const el = document.getElementById('status-text'); if (el) el.textContent = msg; }
  _updateUI() {
    const el = document.getElementById('row-count');
    if (el) el.textContent = fmt(this.total);
    this._status(`Showing ${fmt(this.total)} rows`);
  }
}

// ─── Stats bar ────────────────────────────────────────────────────────────────

async function loadStats() {
  try {
    const s = await apiStats();
    document.getElementById('count-all').textContent   = fmt(s.total);
    document.getElementById('count-debug').textContent = fmt(s.bySeverity.debug  || 0);
    document.getElementById('count-info').textContent  = fmt(s.bySeverity.info   || 0);
    document.getElementById('count-warn').textContent  = fmt(s.bySeverity.warn   || 0);
    document.getElementById('count-error').textContent = fmt(s.bySeverity.error  || 0);
  } catch (e) {
    console.error('stats error:', e);
  }
}

// ─── App bootstrap ────────────────────────────────────────────────────────────

async function init() {
  const container = document.getElementById('scroll-container');
  const viewport  = document.getElementById('rows-viewport');
  const spacer    = document.getElementById('scroll-spacer');

  // Loading overlay (injected into scroll container so it scrolls with it)
  const loadingEl = document.createElement('div');
  loadingEl.className = 'loading-overlay';
  loadingEl.innerHTML = '<span class="spinner"></span>Loading…';
  container.appendChild(loadingEl);

  const scroller = new VirtualScroller({ container, viewport, spacer, loadingEl });

  let curSev = '';
  let curQ   = '';

  function applyFilters() {
    const s = document.getElementById('status-text');
    if (s) s.textContent = 'Loading…';
    scroller.reset(curSev, curQ);
  }

  // ── Severity bar ─────────────────────────────────────────────────────────────
  const sevBtns = document.querySelectorAll('.sev-btn');

  function setSev(sev) {
    if (sev === curSev) return;
    curSev = sev;
    sevBtns.forEach(b => b.classList.toggle('active', b.dataset.severity === sev));
    const sel = document.getElementById('severity-filter');
    if (sel) sel.value = sev;
    applyFilters();
  }

  sevBtns.forEach(b => b.addEventListener('click', () => setSev(b.dataset.severity)));

  document.getElementById('severity-filter').addEventListener('change', e => setSev(e.target.value));

  // ── Search ───────────────────────────────────────────────────────────────────
  const searchInput = document.getElementById('search-input');
  const searchClear = document.getElementById('search-clear');

  const debouncedSearch = debounce(v => {
    if (v === curQ) return;
    curQ = v;
    applyFilters();
  }, DEBOUNCE_MS);

  searchInput.addEventListener('input', e => {
    const v = e.target.value;
    searchClear.style.display = v ? 'block' : 'none';
    debouncedSearch(v);
  });

  searchClear.addEventListener('click', () => {
    searchInput.value = '';
    searchClear.style.display = 'none';
    if (curQ !== '') { curQ = ''; applyFilters(); }
  });

  // ── Initial load ──────────────────────────────────────────────────────────────
  const statusEl = document.getElementById('status-text');
  if (statusEl) statusEl.textContent = 'Loading…';

  await loadStats();
  await scroller.reset('', '');
}

init().catch(err => {
  console.error('init error:', err);
  const s = document.getElementById('status-text');
  if (s) s.textContent = `Failed to initialize: ${err.message}`;
});
