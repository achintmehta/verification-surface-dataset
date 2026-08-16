import { renderChart } from './chart.js';

const API = '/api';

const els = {
  status: document.getElementById('status'),
  content: document.getElementById('content'),
  toggle: document.getElementById('theme-toggle'),
  toggleLabel: document.querySelector('.theme-toggle__label'),
  chart: document.getElementById('chart'),
  chartContainer: document.getElementById('chart-container'),
  breakdown: document.getElementById('breakdown'),
  recentBody: document.getElementById('recent-body'),
};

let timeseriesData = [];

// ---------- Formatting helpers ----------
const numberFmt = new Intl.NumberFormat();
const currencyFmt = new Intl.NumberFormat(undefined, {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

function formatDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function formatDateTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ---------- API ----------
async function api(path, options) {
  const res = await fetch(API + path, options);
  if (!res.ok) throw new Error(`Request failed: ${path} (${res.status})`);
  return res.json();
}

// ---------- Theme ----------
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  if (els.toggleLabel) {
    els.toggleLabel.textContent = theme === 'dark' ? 'Dark' : 'Light';
  }
}

async function initTheme() {
  // Apply persisted theme before first paint of the content.
  try {
    const { theme } = await api('/settings');
    applyTheme(theme === 'dark' ? 'dark' : 'light');
  } catch {
    applyTheme('light');
  }
}

async function toggleTheme() {
  const current =
    document.documentElement.getAttribute('data-theme') === 'dark'
      ? 'dark'
      : 'light';
  const next = current === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  // Redraw chart so its internals pick up the new palette.
  renderChart(els.chart, timeseriesData);
  try {
    await api('/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: next }),
    });
  } catch (err) {
    console.error('Failed to persist theme', err);
  }
}

// ---------- Renderers ----------
function renderSummary(s) {
  setStat('visitors', numberFmt.format(s.totalVisitors), 'across 30 days');
  setStat('revenue', currencyFmt.format(s.totalRevenue), 'across 30 days');
  setStat(
    'best',
    s.bestDay ? numberFmt.format(s.bestDay.visitors) : '—',
    s.bestDay ? `visitors on ${formatDate(s.bestDay.date)}` : ''
  );

  const trendCard = document.querySelector('[data-stat="trend"]');
  const valEl = trendCard.querySelector('.stat-card__value');
  const subEl = trendCard.querySelector('.stat-card__sub');
  const up = s.trendPct >= 0;
  const sign = up ? '▲' : '▼';
  valEl.textContent = `${sign} ${Math.abs(s.trendPct).toFixed(1)}%`;
  valEl.classList.remove('trend--up', 'trend--down');
  valEl.classList.add(up ? 'trend--up' : 'trend--down');
  subEl.textContent = 'vs previous 7 days';
}

function setStat(key, value, sub) {
  const card = document.querySelector(`[data-stat="${key}"]`);
  card.querySelector('.stat-card__value').textContent = value;
  card.querySelector('.stat-card__sub').textContent = sub;
}

function renderBreakdown(categories) {
  els.breakdown.innerHTML = '';
  const max = Math.max(...categories.map((c) => c.value), 1);
  for (const c of categories) {
    const row = document.createElement('div');
    row.className = 'bar-row';

    const head = document.createElement('div');
    head.className = 'bar-row__head';

    const name = document.createElement('span');
    name.className = 'bar-row__name';
    name.textContent = c.name;
    name.title = c.name;

    const value = document.createElement('span');
    value.className = 'bar-row__value';
    value.textContent = numberFmt.format(c.value);

    head.appendChild(name);
    head.appendChild(value);

    const track = document.createElement('div');
    track.className = 'bar-row__track';
    const fill = document.createElement('div');
    fill.className = 'bar-row__fill';
    fill.style.width = `${(c.value / max) * 100}%`;
    track.appendChild(fill);

    row.appendChild(head);
    row.appendChild(track);
    els.breakdown.appendChild(row);
  }
}

function renderRecent(items) {
  els.recentBody.innerHTML = '';
  for (const item of items) {
    const tr = document.createElement('tr');

    const name = document.createElement('td');
    name.textContent = item.name;

    const cat = document.createElement('td');
    cat.textContent = item.category;

    const val = document.createElement('td');
    val.className = 'num';
    val.textContent = currencyFmt.format(item.value);

    const created = document.createElement('td');
    created.textContent = formatDateTime(item.created_at);

    tr.append(name, cat, val, created);
    els.recentBody.appendChild(tr);
  }
}

function showError(message) {
  els.status.hidden = false;
  els.status.classList.add('status--error');
  els.status.textContent =
    message || 'Unable to load dashboard data. Is the backend running?';
  els.content.hidden = true;
}

// ---------- Boot ----------
async function load() {
  try {
    const [summary, timeseries, categories, recent] = await Promise.all([
      api('/summary'),
      api('/timeseries'),
      api('/categories'),
      api('/recent'),
    ]);

    timeseriesData = timeseries;

    renderSummary(summary);
    renderBreakdown(categories);
    renderRecent(recent);

    els.status.hidden = true;
    els.content.hidden = false;

    // Render chart after content is visible so the container has a size.
    renderChart(els.chart, timeseriesData);
  } catch (err) {
    console.error(err);
    showError();
  }
}

// Redraw the chart on resize so it always fits its container.
let resizeRAF = null;
window.addEventListener('resize', () => {
  if (resizeRAF) cancelAnimationFrame(resizeRAF);
  resizeRAF = requestAnimationFrame(() => {
    if (!els.content.hidden) renderChart(els.chart, timeseriesData);
  });
});

// Also observe the chart container directly (catches layout changes that the
// window resize event misses, e.g. flex/grid reflow).
if (window.ResizeObserver) {
  const ro = new ResizeObserver(() => {
    if (!els.content.hidden) renderChart(els.chart, timeseriesData);
  });
  ro.observe(els.chartContainer);
}

els.toggle.addEventListener('click', toggleTheme);

(async function start() {
  await initTheme();
  await load();
})();
