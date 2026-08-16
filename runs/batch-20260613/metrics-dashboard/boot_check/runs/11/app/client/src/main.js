import { LineChart } from './chart.js';

const API = '/api';

const fmtInt = new Intl.NumberFormat('en-US');
const fmtMoney = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

async function fetchJSON(path, opts) {
  const res = await fetch(API + path, opts);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

// ---- Theme ------------------------------------------------------------

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme === 'dark' ? 'dark' : 'light');
  const label = document.querySelector('.theme-toggle__label');
  if (label) label.textContent = theme === 'dark' ? 'Dark' : 'Light';
}

let currentTheme = 'light';

async function loadTheme() {
  try {
    const { theme } = await fetchJSON('/settings');
    currentTheme = theme === 'dark' ? 'dark' : 'light';
  } catch {
    currentTheme = 'light';
  }
  applyTheme(currentTheme);
}

async function toggleTheme() {
  const next = currentTheme === 'dark' ? 'light' : 'dark';
  currentTheme = next;
  applyTheme(next); // optimistic, and redraw chart for new palette
  if (chart) chart.draw();
  try {
    await fetchJSON('/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: next }),
    });
  } catch {
    /* keep optimistic UI even if persistence fails; banner shown by data load */
  }
}

// ---- Renderers --------------------------------------------------------

function statCard(label, value, sub) {
  const card = document.createElement('div');
  card.className = 'stat-card';
  const l = document.createElement('div');
  l.className = 'stat-card__label';
  l.textContent = label;
  const v = document.createElement('div');
  v.className = 'stat-card__value';
  v.textContent = value;
  card.append(l, v);
  if (sub) {
    const s = document.createElement('div');
    s.className = 'stat-card__sub';
    s.innerHTML = sub;
    card.append(s);
  }
  return card;
}

function renderSummary(s) {
  const grid = document.getElementById('stat-grid');
  grid.innerHTML = '';

  const trendCls = s.trendPct >= 0 ? 'trend--pos' : 'trend--neg';
  const arrow = s.trendPct >= 0 ? '▲' : '▼';
  const trendHtml = `<span class="trend ${trendCls}">${arrow} ${Math.abs(s.trendPct).toFixed(1)}%</span> vs prior 7d`;

  grid.append(
    statCard('Total Visitors', fmtInt.format(s.totalVisitors), 'last 30 days'),
    statCard('Total Revenue', fmtMoney.format(s.totalRevenue), 'last 30 days'),
    statCard('Best Day', fmtMoney.format(s.bestDay.revenue), s.bestDay.day),
    statCard('7-Day Trend', `${s.trendPct >= 0 ? '+' : ''}${s.trendPct.toFixed(1)}%`, trendHtml)
  );
}

function renderCategories(cats) {
  const root = document.getElementById('breakdown');
  root.innerHTML = '';
  const max = Math.max(...cats.map((c) => c.value), 1);
  for (const c of cats) {
    const row = document.createElement('div');
    row.className = 'bar-row';

    const head = document.createElement('div');
    head.className = 'bar-row__head';

    const name = document.createElement('span');
    name.className = 'bar-row__name';
    name.textContent = c.name;
    name.title = c.name;

    const val = document.createElement('span');
    val.className = 'bar-row__value';
    val.textContent = fmtInt.format(c.value);

    head.append(name, val);

    const track = document.createElement('div');
    track.className = 'bar-row__track';
    const fill = document.createElement('div');
    fill.className = 'bar-row__fill';
    fill.style.width = `${Math.max(2, (c.value / max) * 100)}%`;
    track.append(fill);

    row.append(head, track);
    root.append(row);
  }
}

function renderRecent(items) {
  const body = document.getElementById('recent-body');
  body.innerHTML = '';
  for (const it of items) {
    const tr = document.createElement('tr');

    const name = document.createElement('td');
    name.className = 'name';
    name.textContent = it.name;
    name.title = it.name;

    const cat = document.createElement('td');
    cat.textContent = it.category;

    const val = document.createElement('td');
    val.className = 'num';
    val.textContent = fmtMoney.format(it.value);

    const created = document.createElement('td');
    created.textContent = it.created_at;

    tr.append(name, cat, val, created);
    body.append(tr);
  }
}

// ---- Data load --------------------------------------------------------

let chart;

function showError(detail) {
  const banner = document.getElementById('error-banner');
  if (detail) document.getElementById('error-detail').textContent = detail;
  banner.hidden = false;
}

function hideError() {
  document.getElementById('error-banner').hidden = true;
}

async function loadData() {
  try {
    const [summary, timeseries, categories, recent] = await Promise.all([
      fetchJSON('/summary'),
      fetchJSON('/timeseries'),
      fetchJSON('/categories'),
      fetchJSON('/recent'),
    ]);
    hideError();
    renderSummary(summary);
    renderCategories(categories);
    renderRecent(recent);
    chart.setData(timeseries);
  } catch (e) {
    // Clear any partial / stale content and show explicit error state.
    document.getElementById('stat-grid').innerHTML = '';
    document.getElementById('breakdown').innerHTML = '';
    document.getElementById('recent-body').innerHTML = '';
    if (chart) chart.setData([]);
    showError('The backend is unreachable. Start the server and reload.');
  }
}

// ---- Boot -------------------------------------------------------------

function init() {
  const svg = document.getElementById('chart');
  const container = document.getElementById('chart-container');
  chart = new LineChart(svg, container);

  document.getElementById('theme-toggle').addEventListener('click', toggleTheme);
  document.getElementById('retry').addEventListener('click', loadData);

  // Apply theme before first data paint, then load data.
  loadTheme().finally(loadData);
}

init();
