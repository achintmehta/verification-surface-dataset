import { api } from './api.js';
import { createLineChart } from './chart.js';

const statusEl = document.getElementById('status');
const mainEl = document.getElementById('main');
const toggleBtn = document.getElementById('theme-toggle');

let chartInstance = null;
let currentTheme = 'light';

/* ---------- formatting helpers ---------- */
const nf = new Intl.NumberFormat('en-US');
const cf = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

function fmtNum(n) {
  return nf.format(Math.round(n));
}
function fmtMoney(n) {
  return cf.format(n);
}
function fmtDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
function fmtDateTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/* ---------- theme ---------- */
function applyTheme(theme) {
  currentTheme = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', currentTheme);
  const label = toggleBtn.querySelector('.theme-toggle__label');
  if (label) label.textContent = currentTheme === 'dark' ? 'Light' : 'Dark';
}

async function toggleTheme() {
  const next = currentTheme === 'dark' ? 'light' : 'dark';
  applyTheme(next); // optimistic; chart re-reads CSS vars via the SVG classes
  if (chartInstance) chartInstance.render();
  try {
    await api.putSettings(next);
  } catch (err) {
    // Revert on failure so UI reflects persisted truth.
    applyTheme(next === 'dark' ? 'light' : 'dark');
    if (chartInstance) chartInstance.render();
    // eslint-disable-next-line no-console
    console.error('Failed to persist theme:', err);
  }
}

toggleBtn.addEventListener('click', toggleTheme);

/* ---------- rendering ---------- */
function statCard(label, value, meta) {
  return `
    <section class="card">
      <p class="stat__label">${label}</p>
      <p class="stat__value">${value}</p>
      ${meta ? `<p class="stat__meta">${meta}</p>` : ''}
    </section>`;
}

function trendBadge(pct) {
  const up = pct >= 0;
  const cls = up ? 'trend--up' : 'trend--down';
  const arrow = up ? '▲' : '▼';
  return `<span class="trend ${cls}">${arrow} ${Math.abs(pct).toFixed(1)}%</span>`;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function renderDashboard(data) {
  const { summary, timeseries, categories, recent } = data;

  const bestDayLabel = summary.bestDay
    ? `Best day: ${fmtDate(summary.bestDay.day)} (${fmtNum(
        summary.bestDay.visitors
      )})`
    : '';

  const maxCat = categories.reduce((m, c) => Math.max(m, c.value), 0) || 1;

  const catRows = categories
    .map((c) => {
      const pct = Math.round((c.value / maxCat) * 100);
      return `
        <div class="cat-row">
          <span class="cat-name" title="${escapeHtml(c.name)}">${escapeHtml(
        c.name
      )}</span>
          <span class="cat-value">${fmtMoney(c.value)}</span>
          <div class="cat-bar-track">
            <div class="cat-bar-fill" style="width:${pct}%"></div>
          </div>
        </div>`;
    })
    .join('');

  const recentRows = recent
    .map(
      (r) => `
        <tr>
          <td class="recent-name">${escapeHtml(r.name)}</td>
          <td><span class="pill" title="${escapeHtml(
            r.category
          )}">${escapeHtml(r.category)}</span></td>
          <td class="num">${fmtMoney(r.value)}</td>
          <td>${fmtDateTime(r.createdAt)}</td>
        </tr>`
    )
    .join('');

  mainEl.innerHTML = `
    <div class="dashboard">
      <div class="stat-grid">
        ${statCard('Total Visitors', fmtNum(summary.totalVisitors), 'Last 30 days')}
        ${statCard('Total Revenue', fmtMoney(summary.totalRevenue), 'Last 30 days')}
        ${statCard(
          'Best Day',
          summary.bestDay ? fmtNum(summary.bestDay.visitors) : '—',
          summary.bestDay ? fmtDate(summary.bestDay.day) + ' visitors' : ''
        )}
        ${statCard(
          '7-Day Trend',
          trendBadge(summary.trendPct),
          'Revenue vs. prior 7 days'
        )}
      </div>

      <div class="body-grid">
        <section class="card chart-card">
          <h2 class="card__title">Visitors — last 30 days</h2>
          <div class="chart-wrap" id="chart"></div>
        </section>

        <section class="card">
          <h2 class="card__title">Revenue by category</h2>
          <div class="cat-list">${catRows}</div>
        </section>
      </div>

      <section class="card span-full">
        <h2 class="card__title">Recent items</h2>
        <div class="table-scroll">
          <table class="recent">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Category</th>
                <th scope="col" class="num">Value</th>
                <th scope="col">Created</th>
              </tr>
            </thead>
            <tbody>${recentRows}</tbody>
          </table>
        </div>
      </section>
    </div>`;

  // mark bestDayLabel use to satisfy lint-ish reading (kept for clarity)
  void bestDayLabel;

  const chartContainer = document.getElementById('chart');
  if (chartInstance) chartInstance.destroy();
  chartInstance = createLineChart(chartContainer, timeseries, {
    valueKey: 'visitors',
  });
}

function renderError(message) {
  if (chartInstance) {
    chartInstance.destroy();
    chartInstance = null;
  }
  mainEl.innerHTML = `
    <div class="error-box" role="alert">
      <h2>Unable to load dashboard</h2>
      <p>${escapeHtml(message)}</p>
      <button class="retry-btn" id="retry">Retry</button>
    </div>`;
  document.getElementById('retry').addEventListener('click', boot);
}

/* ---------- boot ---------- */
async function boot() {
  mainEl.innerHTML =
    '<div class="status" role="status" aria-live="polite">Loading dashboard…</div>';

  // 1) Apply persisted theme BEFORE rendering content.
  try {
    const settings = await api.getSettings();
    applyTheme(settings.theme);
  } catch {
    applyTheme('light');
  }

  // 2) Load all data; any failure shows an explicit error state.
  try {
    const [summary, timeseries, categories, recent] = await Promise.all([
      api.summary(),
      api.timeseries(),
      api.categories(),
      api.recent(),
    ]);
    renderDashboard({ summary, timeseries, categories, recent });
  } catch (err) {
    renderError(
      err && err.message
        ? err.message
        : 'The backend is unavailable. Start the server and retry.'
    );
  }
}

void statusEl;
boot();
