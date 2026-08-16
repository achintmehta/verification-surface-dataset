import './styles.css';
import {
  getSummary,
  getTimeseries,
  getCategories,
  getRecent,
  getSettings,
  putSettings,
} from './api.js';
import { createTimeseriesChart } from './chart.js';
import {
  formatNumber,
  formatCurrencyCompact,
  formatCurrency,
  formatDateShort,
  formatDateTime,
} from './format.js';

const appEl = document.getElementById('app');
let chart = null;
let currentTheme = 'light';

function setThemeHintCookie(theme) {
  // Non-authoritative hint so the inline head script can avoid a flash on reload.
  document.cookie = `theme-hint=${theme}; path=/; max-age=31536000; SameSite=Lax`;
}

function applyTheme(theme) {
  currentTheme = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', currentTheme);
  setThemeHintCookie(currentTheme);
  const btn = document.getElementById('theme-toggle');
  if (btn) {
    btn.querySelector('.icon').textContent = currentTheme === 'dark' ? '\u2600\uFE0F' : '\u{1F319}';
    btn.querySelector('.label').textContent = currentTheme === 'dark' ? 'Light' : 'Dark';
  }
  // Chart colors come from CSS vars, but axis/series are stroked via CSS classes,
  // so a re-render picks up the new palette cleanly.
  if (chart) chart.redraw();
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderShell() {
  appEl.innerHTML = `
    <div class="shell">
      <header class="header">
        <div>
          <h1>Metrics Dashboard</h1>
          <p class="subtitle">Last 30 days &middot; seeded analytics</p>
        </div>
        <button id="theme-toggle" class="theme-toggle" type="button" aria-label="Toggle theme">
          <span class="icon">\u{1F319}</span>
          <span class="label">Dark</span>
        </button>
      </header>
      <div id="content"></div>
    </div>
  `;
  document.getElementById('theme-toggle').addEventListener('click', onToggleTheme);
}

async function onToggleTheme() {
  const next = currentTheme === 'dark' ? 'light' : 'dark';
  applyTheme(next); // optimistic
  try {
    const saved = await putSettings(next);
    applyTheme(saved.theme);
  } catch (err) {
    // Revert if persistence failed.
    applyTheme(next === 'dark' ? 'light' : 'dark');
    // eslint-disable-next-line no-console
    console.error('Failed to persist theme', err);
  }
}

function renderError(message) {
  const content = document.getElementById('content');
  content.innerHTML = `
    <div class="banner error" role="alert">
      <strong>Couldn't load the dashboard.</strong>
      <div class="muted" style="color:inherit">${escapeHtml(message)}</div>
      <button class="retry" id="retry-btn" type="button">Retry</button>
    </div>
  `;
  document.getElementById('retry-btn').addEventListener('click', loadDashboard);
}

function statCard(label, value, sub) {
  return `
    <div class="card">
      <p class="stat-label">${escapeHtml(label)}</p>
      <p class="stat-value" title="${escapeHtml(value)}">${escapeHtml(value)}</p>
      <p class="stat-sub">${sub}</p>
    </div>
  `;
}

function renderDashboard({ summary, timeseries, categories, recent }) {
  const content = document.getElementById('content');

  const trendClass = summary.trendPct >= 0 ? 'pos' : 'neg';
  const trendArrow = summary.trendPct >= 0 ? '\u25B2' : '\u25BC';
  const trendSub = `<span class="trend ${trendClass}">${trendArrow} ${Math.abs(
    summary.trendPct
  ).toFixed(1)}%</span> vs prior 7 days`;

  const bestSub = summary.bestDay
    ? `${formatNumber(summary.bestDay.visitors)} on ${formatDateShort(summary.bestDay.day)}`
    : '\u2014';

  const stats = `
    <section class="stats" aria-label="Summary">
      ${statCard('Total Visitors', formatNumber(summary.totalVisitors), '30-day total')}
      ${statCard('Total Revenue', formatCurrencyCompact(summary.totalRevenue), formatCurrency(summary.totalRevenue))}
      ${statCard('Best Day', summary.bestDay ? formatNumber(summary.bestDay.visitors) : '\u2014', bestSub)}
      ${statCard('7-Day Trend', `${summary.trendPct >= 0 ? '+' : ''}${summary.trendPct.toFixed(1)}%`, trendSub)}
    </section>
  `;

  const maxCat = Math.max(1, ...categories.map((c) => c.value));
  const bars = categories
    .map((c) => {
      const pct = Math.max(2, (c.value / maxCat) * 100);
      return `
        <div class="bar-row">
          <span class="bar-name" title="${escapeHtml(c.name)}">${escapeHtml(c.name)}</span>
          <span class="bar-value">${formatNumber(c.value)}</span>
          <div class="bar-track"><div class="bar-fill" style="width:${pct.toFixed(1)}%"></div></div>
        </div>
      `;
    })
    .join('');

  const rows = recent
    .map(
      (r) => `
        <tr>
          <td>${escapeHtml(r.name)}</td>
          <td class="cat" title="${escapeHtml(r.category)}">${escapeHtml(r.category)}</td>
          <td class="num">${formatCurrency(r.value)}</td>
          <td>${escapeHtml(formatDateTime(r.createdAt))}</td>
        </tr>`
    )
    .join('');

  content.innerHTML = `
    ${stats}
    <div class="body-grid" style="margin-top:16px">
      <section class="card card-chart">
        <h2 class="card-title">Visitors &mdash; last 30 days</h2>
        <div class="chart-wrap" id="chart"></div>
      </section>
      <section class="card card-bars">
        <h2 class="card-title">Category breakdown</h2>
        <div class="bars">${bars}</div>
      </section>
      <section class="card card-table">
        <h2 class="card-title">Recent items</h2>
        <div class="table-scroll">
          <table class="recent">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Category</th>
                <th scope="col">Value</th>
                <th scope="col">Created</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </section>
    </div>
  `;

  if (chart) chart.destroy();
  chart = createTimeseriesChart(document.getElementById('chart'), timeseries);
}

async function loadDashboard() {
  const content = document.getElementById('content');
  content.innerHTML = `<div class="banner"><span class="skeleton">Loading dashboard\u2026</span></div>`;
  try {
    const [summary, timeseries, categories, recent] = await Promise.all([
      getSummary(),
      getTimeseries(),
      getCategories(),
      getRecent(),
    ]);
    renderDashboard({ summary, timeseries, categories, recent });
  } catch (err) {
    if (chart) {
      chart.destroy();
      chart = null;
    }
    renderError(err.message || 'Unknown error');
  }
}

async function init() {
  renderShell();
  // Apply persisted theme before first data paint.
  try {
    const settings = await getSettings();
    applyTheme(settings.theme);
  } catch (err) {
    // If settings fail, fall back to current (hint/default) theme but continue.
    // eslint-disable-next-line no-console
    console.error('Failed to load settings', err);
  }
  await loadDashboard();
}

init();
