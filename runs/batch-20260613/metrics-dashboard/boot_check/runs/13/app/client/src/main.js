import './styles.css';
import { TimeSeriesChart } from './chart.js';

const API = '/api';

const els = {
  html: document.documentElement,
  banner: document.getElementById('status-banner'),
  statGrid: document.getElementById('stat-grid'),
  breakdown: document.getElementById('breakdown'),
  recentBody: document.getElementById('recent-body'),
  toggle: document.getElementById('theme-toggle'),
  toggleLabel: document.querySelector('.theme-toggle__label'),
  chartCanvas: document.getElementById('timeseries-canvas'),
};

let chart;
let currentTheme = 'light';

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------
function fmtNumber(n) {
  return new Intl.NumberFormat('en-US').format(Math.round(n));
}

function fmtCurrency(n) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(n);
}

function fmtDateLabel(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

function fmtDateTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

async function fetchJson(path, opts) {
  const res = await fetch(API + path, opts);
  if (!res.ok) throw new Error(`Request failed: ${path} (${res.status})`);
  return res.json();
}

function showError(message) {
  els.banner.hidden = false;
  els.banner.innerHTML = '';
  const title = document.createElement('div');
  title.className = 'status-banner__title';
  title.textContent = 'Unable to load dashboard data';
  const body = document.createElement('div');
  body.textContent =
    message ||
    'The API could not be reached. Make sure the backend server is running, then reload.';
  els.banner.append(title, body);
}

function clearError() {
  els.banner.hidden = true;
  els.banner.innerHTML = '';
}

// --------------------------------------------------------------------------
// Theme
// --------------------------------------------------------------------------
function applyTheme(theme) {
  currentTheme = theme === 'dark' ? 'dark' : 'light';
  els.html.setAttribute('data-theme', currentTheme);
  if (els.toggleLabel) {
    els.toggleLabel.textContent = currentTheme === 'dark' ? 'Dark' : 'Light';
  }
  // Repaint chart internals to match the new palette.
  if (chart) chart.draw();
}

async function toggleTheme() {
  const next = currentTheme === 'dark' ? 'light' : 'dark';
  applyTheme(next); // optimistic
  try {
    const saved = await fetchJson('/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: next }),
    });
    applyTheme(saved.theme);
  } catch (err) {
    // Revert on failure.
    applyTheme(next === 'dark' ? 'light' : 'dark');
  }
}

// --------------------------------------------------------------------------
// Renderers
// --------------------------------------------------------------------------
function renderStats(summary) {
  const trend = summary.trendPct || 0;
  const up = trend >= 0;
  const cards = [
    {
      label: 'Total Visitors',
      value: fmtNumber(summary.totalVisitors),
      sub: 'Last 30 days',
    },
    {
      label: 'Total Revenue',
      value: fmtCurrency(summary.totalRevenue),
      sub: 'Last 30 days',
    },
    {
      label: 'Best Day',
      value: summary.bestDay ? fmtNumber(summary.bestDay.visitors) : '—',
      sub: summary.bestDay
        ? `${fmtDateLabel(summary.bestDay.date)} visitors`
        : 'No data',
    },
    {
      label: '7-Day Trend',
      value: `${up ? '+' : ''}${trend}%`,
      trend: up ? 'up' : 'down',
      sub: 'vs prior 7 days',
    },
  ];

  els.statGrid.innerHTML = '';
  for (const c of cards) {
    const card = document.createElement('div');
    card.className = 'stat-card';

    const label = document.createElement('div');
    label.className = 'stat-card__label';
    label.textContent = c.label;

    const value = document.createElement('div');
    value.className = 'stat-card__value';
    if (c.trend) {
      value.classList.add('trend', c.trend === 'up' ? 'trend--up' : 'trend--down');
      value.textContent = `${c.trend === 'up' ? '▲' : '▼'} ${c.value}`;
    } else {
      value.textContent = c.value;
    }

    const sub = document.createElement('div');
    sub.className = 'stat-card__sub';
    sub.textContent = c.sub;

    card.append(label, value, sub);
    els.statGrid.appendChild(card);
  }
}

function renderBreakdown(categories) {
  els.breakdown.innerHTML = '';
  const max = categories.reduce((m, c) => Math.max(m, c.value), 0) || 1;

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
    value.textContent = fmtNumber(c.value);

    head.append(name, value);

    const track = document.createElement('div');
    track.className = 'bar-row__track';
    const fill = document.createElement('div');
    fill.className = 'bar-row__fill';
    fill.style.width = `${Math.max(2, (c.value / max) * 100)}%`;
    track.appendChild(fill);

    row.append(head, track);
    els.breakdown.appendChild(row);
  }
}

function renderRecent(items) {
  els.recentBody.innerHTML = '';
  for (const it of items) {
    const tr = document.createElement('tr');

    const nameTd = document.createElement('td');
    nameTd.className = 'cell-name';
    nameTd.textContent = it.name;
    nameTd.title = it.name;

    const catTd = document.createElement('td');
    const pill = document.createElement('span');
    pill.className = 'cat-pill';
    pill.textContent = it.category;
    pill.title = it.category;
    catTd.appendChild(pill);

    const valTd = document.createElement('td');
    valTd.className = 'num';
    valTd.textContent = fmtCurrency(it.value);

    const dateTd = document.createElement('td');
    dateTd.textContent = fmtDateTime(it.createdAt);

    tr.append(nameTd, catTd, valTd, dateTd);
    els.recentBody.appendChild(tr);
  }
}

// --------------------------------------------------------------------------
// Boot
// --------------------------------------------------------------------------
async function loadDashboard() {
  // Theme must be applied before first meaningful paint of data.
  try {
    const settings = await fetchJson('/settings');
    applyTheme(settings.theme);
  } catch (err) {
    // If settings fail, the whole API is likely down — surface error below.
  }

  try {
    const [summary, timeseries, categories, recent] = await Promise.all([
      fetchJson('/summary'),
      fetchJson('/timeseries'),
      fetchJson('/categories'),
      fetchJson('/recent'),
    ]);

    clearError();
    renderStats(summary);
    renderBreakdown(categories);
    renderRecent(recent);
    chart.setData(timeseries.map((d) => ({ date: d.date, visitors: d.visitors })));
  } catch (err) {
    showError(err && err.message);
    // Clear any partial content so nothing stale remains.
    els.statGrid.innerHTML = '';
    els.breakdown.innerHTML = '';
    els.recentBody.innerHTML = '';
    if (chart) chart.setData([]);
  }
}

function init() {
  chart = new TimeSeriesChart(els.chartCanvas);
  els.toggle.addEventListener('click', toggleTheme);
  loadDashboard();
}

init();
