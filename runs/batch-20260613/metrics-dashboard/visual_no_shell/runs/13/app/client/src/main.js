import './styles.css';
import { renderChart } from './chart.js';

const main = document.getElementById('main');
const toggleBtn = document.getElementById('theme-toggle');
const toggleLabel = toggleBtn.querySelector('.theme-toggle__label');

let chartCleanup = null;

async function api(path, opts) {
  const res = await fetch('/api' + path, opts);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

/* ---------- Formatting helpers ---------- */
const nf = new Intl.NumberFormat('en-US');
const cf = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0
});

function fmtNum(n) {
  return nf.format(Math.round(n));
}
function fmtCurrency(n) {
  return cf.format(n);
}
function fmtDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
function fmtDateTime(iso) {
  const d = new Date(iso);
  return (
    d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
    ' ' +
    d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
  );
}

/* ---------- Theme ---------- */
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme === 'dark' ? 'dark' : 'light');
  toggleLabel.textContent = theme === 'dark' ? 'Dark' : 'Light';
  toggleBtn.dataset.theme = theme;
}

async function loadTheme() {
  const forced = new URLSearchParams(location.search).get('theme');
  if (forced === 'dark' || forced === 'light') {
    applyTheme(forced);
    return forced;
  }
  try {
    const { theme } = await api('/settings');
    applyTheme(theme);
    return theme;
  } catch {
    applyTheme('light');
    return 'light';
  }
}

async function setTheme(theme) {
  applyTheme(theme);
  try {
    await api('/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme })
    });
  } catch {
    /* keep applied theme even if persist fails */
  }
}

toggleBtn.addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme');
  setTheme(current === 'dark' ? 'light' : 'dark');
});

/* ---------- Renderers ---------- */
function statCard(label, value, metaHtml) {
  return `
    <section class="card stat-card">
      <div class="stat">
        <span class="stat__label">${label}</span>
        <span class="stat__value">${value}</span>
        ${metaHtml ? `<span class="stat__meta">${metaHtml}</span>` : ''}
      </div>
    </section>`;
}

function renderSummary(s) {
  const up = s.trendPct >= 0;
  const trend = `<span class="trend ${up ? 'trend--up' : 'trend--down'}">${
    up ? '\u25B2' : '\u25BC'
  } ${Math.abs(s.trendPct).toFixed(1)}%</span>`;

  const best = s.bestDay
    ? `${fmtNum(s.bestDay.visitors)} on ${fmtDate(s.bestDay.day)}`
    : '—';

  return (
    statCard('Total Visitors', fmtNum(s.totalVisitors), '30-day total') +
    statCard('Total Revenue', fmtCurrency(s.totalRevenue), '30-day total') +
    statCard('Best Day', best ? best.split(' on ')[0] : '—', s.bestDay ? `on ${fmtDate(s.bestDay.day)}` : '') +
    statCard('7-Day Trend', trend, 'vs previous 7 days')
  );
}

function renderCategories(cats) {
  const max = Math.max(...cats.map((c) => c.value), 1);
  const rows = cats
    .map((c) => {
      const pct = (c.value / max) * 100;
      return `
        <div class="cat-row">
          <span class="cat-name" title="${escapeHtml(c.name)}">${escapeHtml(c.name)}</span>
          <span class="cat-value">${fmtNum(c.value)}</span>
          <div class="cat-track"><div class="cat-bar" style="width:${pct}%"></div></div>
        </div>`;
    })
    .join('');
  return `
    <section class="card cat-card">
      <h2 class="card__title">Category Breakdown</h2>
      <div class="cat-list">${rows}</div>
    </section>`;
}

function renderRecent(items) {
  const rows = items
    .map(
      (it) => `
      <tr>
        <td class="name" title="${escapeHtml(it.name)}">${escapeHtml(it.name)}</td>
        <td>${escapeHtml(it.category)}</td>
        <td class="num">${fmtCurrency(it.value)}</td>
        <td>${fmtDateTime(it.created_at)}</td>
      </tr>`
    )
    .join('');
  return `
    <section class="card table-card">
      <h2 class="card__title">Recent Items</h2>
      <div class="table-scroll">
        <table class="recent">
          <thead>
            <tr>
              <th>Name</th><th>Category</th><th class="num">Value</th><th>Created</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </section>`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showError(message) {
  main.innerHTML = `
    <div class="state state--error">
      <div class="state__title">Unable to load dashboard</div>
      <div>${escapeHtml(message)}</div>
      <div style="margin-top:8px">The backend may be stopped. Start it and reload.</div>
    </div>`;
}

/* ---------- Boot ---------- */
async function load() {
  if (chartCleanup) {
    chartCleanup();
    chartCleanup = null;
  }
  main.innerHTML = `<div class="state">Loading…</div>`;

  try {
    const [summary, timeseries, categories, recent] = await Promise.all([
      api('/summary'),
      api('/timeseries'),
      api('/categories'),
      api('/recent')
    ]);

    main.innerHTML =
      renderSummary(summary) +
      `<section class="card chart-card">
         <h2 class="card__title">Visitors — Last 30 Days</h2>
         <div class="chart-host"></div>
       </section>` +
      renderCategories(categories) +
      renderRecent(recent);

    const host = main.querySelector('.chart-host');
    chartCleanup = renderChart(host, timeseries);
  } catch (err) {
    showError(err && err.message ? err.message : String(err));
  }
}

(async function init() {
  await loadTheme(); // apply persisted theme before first content paint
  await load();
})();

// Expose for quick manual testing/inspection.
window.__setTheme = setTheme;
