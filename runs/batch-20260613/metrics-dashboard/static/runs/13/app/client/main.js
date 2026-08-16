import { createChart } from './chart.js';

const API = '/api';

// ---- Formatting helpers -----------------------------------------------------
const nf = new Intl.NumberFormat('en-US');
const cf = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

function fmtNum(n) {
  return nf.format(n);
}
function fmtMoney(n) {
  return cf.format(n);
}
function fmtDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
function fmtDateTime(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

async function getJSON(path, opts) {
  const res = await fetch(API + path, opts);
  if (!res.ok) throw new Error(`${path} responded ${res.status}`);
  return res.json();
}

// ---- DOM refs ---------------------------------------------------------------
const statGrid = document.getElementById('stat-grid');
const breakdownHost = document.getElementById('breakdown');
const recentHost = document.getElementById('recent-host');
const chartHost = document.getElementById('chart-host');
const errorBanner = document.getElementById('error-banner');
const themeToggle = document.getElementById('theme-toggle');

const chart = createChart(chartHost);

// ---- Theme ------------------------------------------------------------------
function applyTheme(theme) {
  const t = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', t);
  themeToggle.querySelector('.theme-toggle__label').textContent =
    t === 'dark' ? 'Dark' : 'Light';
  // Chart internals read CSS variables; redraw so any computed values refresh.
  chart.redraw();
}

let currentTheme = 'light';

async function loadTheme() {
  try {
    const { theme } = await getJSON('/settings');
    currentTheme = theme;
    applyTheme(theme);
  } catch (err) {
    // If settings can't load, default to light but keep the app usable.
    applyTheme('light');
    throw err;
  }
}

themeToggle.addEventListener('click', async () => {
  const next = currentTheme === 'dark' ? 'light' : 'dark';
  currentTheme = next;
  applyTheme(next); // optimistic — instant feedback
  try {
    await getJSON('/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: next }),
    });
  } catch (err) {
    showError('Could not save theme preference (is the server running?).');
  }
});

// ---- Error / empty state ----------------------------------------------------
function showError(message) {
  errorBanner.textContent = message;
  errorBanner.hidden = false;
}
function clearError() {
  errorBanner.hidden = true;
  errorBanner.textContent = '';
}

function renderLoading() {
  statGrid.innerHTML = '<div class="loading">Loading…</div>';
  breakdownHost.innerHTML = '<div class="loading">Loading…</div>';
  recentHost.innerHTML = '<div class="loading">Loading…</div>';
}

// ---- Stat cards -------------------------------------------------------------
function renderSummary(s) {
  const trendPos = s.trendPct >= 0;
  const cards = [
    {
      label: 'Total visitors',
      value: fmtNum(s.totalVisitors),
      sub: 'Last 30 days',
    },
    {
      label: 'Total revenue',
      value: fmtMoney(s.totalRevenue),
      sub: 'Last 30 days',
    },
    {
      label: 'Best day',
      value: s.bestDay ? fmtNum(s.bestDay.visitors) : '—',
      sub: s.bestDay ? `visitors on ${fmtDate(s.bestDay.day)}` : 'No data',
    },
    {
      label: '7-day trend',
      value: `${trendPos ? '+' : ''}${s.trendPct}%`,
      sub: 'vs prior 7 days',
      trend: trendPos ? 'pos' : 'neg',
    },
  ];

  statGrid.innerHTML = '';
  for (const c of cards) {
    const node = document.createElement('article');
    node.className = 'stat';
    const valueClass =
      c.trend === 'pos'
        ? 'stat__value trend trend--pos'
        : c.trend === 'neg'
        ? 'stat__value trend trend--neg'
        : 'stat__value';
    const arrow = c.trend === 'pos' ? '▲ ' : c.trend === 'neg' ? '▼ ' : '';
    node.innerHTML = `
      <span class="stat__label"></span>
      <span class="${valueClass}"></span>
      <span class="stat__sub"></span>
    `;
    node.querySelector('.stat__label').textContent = c.label;
    node.querySelector('.stat__value').textContent = arrow + c.value;
    node.querySelector('.stat__sub').textContent = c.sub;
    statGrid.appendChild(node);
  }
}

// ---- Category breakdown -----------------------------------------------------
function renderCategories(cats) {
  breakdownHost.innerHTML = '';
  if (!cats || cats.length === 0) {
    breakdownHost.innerHTML = '<div class="empty">No categories.</div>';
    return;
  }
  const max = Math.max(...cats.map((c) => c.value));
  for (const c of cats) {
    const pct = max > 0 ? (c.value / max) * 100 : 0;
    const row = document.createElement('div');
    row.className = 'bar-row';
    row.innerHTML = `
      <div class="bar-head">
        <span class="bar-name"></span>
        <span class="bar-value"></span>
      </div>
      <div class="bar-track"><div class="bar-fill"></div></div>
    `;
    const nameEl = row.querySelector('.bar-name');
    nameEl.textContent = c.name;
    nameEl.title = c.name; // tooltip for truncated long names
    row.querySelector('.bar-value').textContent = fmtNum(c.value);
    row.querySelector('.bar-fill').style.width = pct.toFixed(1) + '%';
    breakdownHost.appendChild(row);
  }
}

// ---- Recent items table -----------------------------------------------------
function renderRecent(items) {
  recentHost.innerHTML = '';
  if (!items || items.length === 0) {
    recentHost.innerHTML = '<div class="empty">No recent items.</div>';
    return;
  }
  const table = document.createElement('table');
  table.className = 'recent';
  table.innerHTML = `
    <thead>
      <tr>
        <th>Name</th>
        <th>Category</th>
        <th>When</th>
        <th style="text-align:right">Value</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;
  const tbody = table.querySelector('tbody');
  for (const it of items) {
    const tr = document.createElement('tr');
    const tdName = document.createElement('td');
    tdName.className = 'name';
    tdName.textContent = it.name;
    tdName.title = it.name;

    const tdCat = document.createElement('td');
    const pill = document.createElement('span');
    pill.className = 'pill';
    pill.textContent = it.category;
    pill.title = it.category;
    tdCat.appendChild(pill);

    const tdWhen = document.createElement('td');
    tdWhen.textContent = fmtDateTime(it.createdAt);

    const tdVal = document.createElement('td');
    tdVal.className = 'value';
    tdVal.textContent = fmtNum(it.value);

    tr.append(tdName, tdCat, tdWhen, tdVal);
    tbody.appendChild(tr);
  }
  recentHost.appendChild(table);
}

// ---- Boot -------------------------------------------------------------------
async function load() {
  clearError();
  renderLoading();
  try {
    // Theme first so we apply it before painting the data.
    await loadTheme();
  } catch (_) {
    // Theme failure handled below by the data fetch error path.
  }

  try {
    const [summary, timeseries, categories, recent] = await Promise.all([
      getJSON('/summary'),
      getJSON('/timeseries'),
      getJSON('/categories'),
      getJSON('/recent'),
    ]);
    clearError();
    renderSummary(summary);
    chart.setData(timeseries);
    renderCategories(categories);
    renderRecent(recent);
  } catch (err) {
    // Explicit error state — no stale hardcoded content is shown.
    statGrid.innerHTML = '';
    breakdownHost.innerHTML = '';
    recentHost.innerHTML = '';
    chart.setData([]);
    showError(
      'Unable to load dashboard data. The backend may be offline — start the server and reload.'
    );
  }
}

load();
