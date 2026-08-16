import './styles.css';
import { drawChart } from './chart.js';

const API = '/api';

const state = {
  summary: null,
  timeseries: null,
  categories: null,
  recent: null,
  theme: 'light',
};

const els = {
  main: document.getElementById('main'),
  status: document.getElementById('status'),
  statCards: document.getElementById('stat-cards'),
  bars: document.getElementById('bars'),
  tableScroll: document.getElementById('table-scroll'),
  chartCanvas: document.getElementById('chart-canvas'),
  chartWrap: document.getElementById('chart-wrap'),
  themeToggle: document.getElementById('theme-toggle'),
  themeToggleState: document.getElementById('theme-toggle-state'),
};

/* ---------- formatting helpers ---------- */
const nf = new Intl.NumberFormat('en-US');
const cf = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

function fmtNum(n) {
  return nf.format(n);
}
function fmtCur(n) {
  return cf.format(n);
}
function fmtDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
function fmtDateTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/* ---------- data ---------- */
async function fetchJson(path) {
  const res = await fetch(API + path);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

async function loadAll() {
  const [summary, timeseries, categories, recent] = await Promise.all([
    fetchJson('/summary'),
    fetchJson('/timeseries'),
    fetchJson('/categories'),
    fetchJson('/recent'),
  ]);
  state.summary = summary;
  state.timeseries = timeseries;
  state.categories = categories;
  state.recent = recent;
}

/* ---------- theme ---------- */
function applyTheme(theme) {
  state.theme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  els.themeToggleState.textContent = theme === 'dark' ? 'Dark' : 'Light';
  try {
    localStorage.setItem('theme-hint', theme);
  } catch (e) {}
}

async function loadTheme() {
  try {
    const s = await fetchJson('/settings');
    applyTheme(s.theme === 'dark' ? 'dark' : 'light');
  } catch (e) {
    // fall back to current attribute if settings unreachable
    applyTheme(document.documentElement.getAttribute('data-theme') || 'light');
  }
}

async function toggleTheme() {
  const next = state.theme === 'dark' ? 'light' : 'dark';
  applyTheme(next); // optimistic
  renderChart(); // chart internals depend on theme colors
  try {
    await fetch(API + '/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: next }),
    });
  } catch (e) {
    // keep optimistic value; will reconcile on next reload
  }
}

/* ---------- render ---------- */
function showStatus(title, message, isError) {
  els.status.hidden = false;
  els.status.classList.toggle('error', !!isError);
  els.status.innerHTML = `<strong></strong><span></span>`;
  els.status.querySelector('strong').textContent = title;
  els.status.querySelector('span').textContent = message;
}

function hideStatus() {
  els.status.hidden = true;
}

function renderStatCards() {
  const s = state.summary;
  const best = s.bestDay;
  const trend = s.trendPct;
  const trendClass = trend >= 0 ? 'pos' : 'neg';
  const trendArrow = trend >= 0 ? '▲' : '▼';

  const cards = [
    {
      label: 'Total Visitors',
      value: fmtNum(s.totalVisitors),
      sub: 'Last 30 days',
    },
    {
      label: 'Total Revenue',
      value: fmtCur(s.totalRevenue),
      sub: 'Last 30 days',
    },
    {
      label: 'Best Day',
      value: best ? fmtNum(best.visitors) : '—',
      sub: best ? `visitors on ${fmtDate(best.day)}` : 'no data',
    },
    {
      label: '7-Day Trend',
      valueHtml: `<span class="trend ${trendClass}">${trendArrow} ${Math.abs(
        trend
      ).toFixed(1)}%</span>`,
      sub: 'vs previous 7 days',
    },
  ];

  els.statCards.innerHTML = cards
    .map(
      (c) => `
      <div class="stat-card">
        <p class="stat-label">${c.label}</p>
        <p class="stat-value">${c.valueHtml || c.value}</p>
        <p class="stat-sub">${c.sub}</p>
      </div>`
    )
    .join('');
}

function renderBars() {
  const cats = state.categories;
  const max = Math.max(...cats.map((c) => c.value), 1);
  els.bars.innerHTML = cats
    .map((c) => {
      const pct = (c.value / max) * 100;
      return `
        <div class="bar-row">
          <span class="bar-name" title="${escapeHtml(c.name)}">${escapeHtml(
        c.name
      )}</span>
          <span class="bar-value">${fmtNum(c.value)}</span>
          <div class="bar-track">
            <div class="bar-fill" style="width:${pct}%"></div>
          </div>
        </div>`;
    })
    .join('');
}

function renderTable() {
  const rows = state.recent;
  const body = rows
    .map(
      (r) => `
      <tr>
        <td>${escapeHtml(r.name)}</td>
        <td><span class="cat-chip" title="${escapeHtml(
          r.category
        )}">${escapeHtml(r.category)}</span></td>
        <td class="num">${fmtCur(r.value)}</td>
        <td>${fmtDateTime(r.createdAt)}</td>
      </tr>`
    )
    .join('');
  els.tableScroll.innerHTML = `
    <table class="recent">
      <thead>
        <tr>
          <th>Name</th>
          <th>Category</th>
          <th>Value</th>
          <th>Created</th>
        </tr>
      </thead>
      <tbody>${body}</tbody>
    </table>`;
}

function renderChart() {
  if (!state.timeseries) return;
  drawChart(els.chartCanvas, els.chartWrap, state.timeseries);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => {
    return {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[ch];
  });
}

function renderAll() {
  renderStatCards();
  renderBars();
  renderTable();
  renderChart();
}

/* ---------- resize handling ---------- */
let resizeRaf = null;
function onResize() {
  if (resizeRaf) cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(() => renderChart());
}

/* ---------- boot ---------- */
async function init() {
  els.themeToggle.addEventListener('click', toggleTheme);
  window.addEventListener('resize', onResize);

  // Use ResizeObserver on the chart wrapper for container-driven redraws.
  if ('ResizeObserver' in window) {
    const ro = new ResizeObserver(() => onResize());
    ro.observe(els.chartWrap);
  }

  await loadTheme();

  try {
    await loadAll();
    hideStatus();
    els.main.setAttribute('aria-busy', 'false');
    renderAll();
  } catch (err) {
    console.error(err);
    els.main.setAttribute('aria-busy', 'false');
    // Clear any partial content and show explicit error state.
    els.statCards.innerHTML = '';
    els.bars.innerHTML = '';
    els.tableScroll.innerHTML = '';
    const ctx = els.chartCanvas.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, els.chartCanvas.width, els.chartCanvas.height);
    showStatus(
      'Unable to load dashboard data',
      'The metrics API is unreachable. Start the backend server and reload the page.',
      true
    );
  }
}

init();
