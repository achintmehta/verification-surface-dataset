import { drawTimeSeries, initChartResize } from './chart.js';

const API = '/api';

// ─── Theme ────────────────────────────────────────────────────────────────────

let currentTheme = 'light';

async function loadTheme() {
  try {
    const res = await fetch(`${API}/settings`);
    if (!res.ok) throw new Error('settings fetch failed');
    const { theme } = await res.json();
    applyTheme(theme, false);
  } catch {
    // Fall back to sessionStorage or default
    const stored = sessionStorage.getItem('__theme');
    applyTheme(stored || 'light', false);
  }
}

function applyTheme(theme, persist = true) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  sessionStorage.setItem('__theme', theme);
  if (persist) {
    fetch(`${API}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme }),
    }).catch(() => {});
  }
  // Redraw chart with new theme colors
  if (window.__timeseriesData) {
    drawTimeSeries(window.__timeseriesData, currentTheme);
  }
}

document.getElementById('theme-toggle').addEventListener('click', () => {
  applyTheme(currentTheme === 'light' ? 'dark' : 'light', true);
});

// ─── Formatters ───────────────────────────────────────────────────────────────

function fmtNumber(n) {
  return new Intl.NumberFormat('en-US').format(Math.round(n));
}

function fmtCurrency(n) {
  if (n >= 1_000_000) {
    return '$' + (n / 1_000_000).toFixed(2) + 'M';
  }
  if (n >= 1_000) {
    return '$' + (n / 1_000).toFixed(1) + 'K';
  }
  return '$' + n.toFixed(2);
}

function fmtDate(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function fmtShortDate(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

// ─── Error State ──────────────────────────────────────────────────────────────

function showError() {
  document.getElementById('error-banner').classList.remove('hidden');
  // Clear skeleton states
  ['val-visitors', 'val-revenue', 'val-best', 'val-trend'].forEach(id => {
    document.getElementById(id).textContent = '—';
  });
  document.getElementById('recent-tbody').innerHTML =
    '<tr><td colspan="4" class="loading-cell">No data available — backend offline.</td></tr>';
  document.getElementById('categories-chart').innerHTML =
    '<p style="color:var(--text-muted);font-size:0.85rem;padding:1rem 0">No data available.</p>';
}

// ─── Stat Cards ───────────────────────────────────────────────────────────────

function renderSummary(data) {
  // Remove skeleton class
  ['card-visitors', 'card-revenue', 'card-best', 'card-trend'].forEach(id => {
    document.getElementById(id).classList.remove('skeleton');
  });

  document.getElementById('val-visitors').textContent = fmtNumber(data.total_visitors);
  document.getElementById('sub-visitors').textContent = 'all time';

  document.getElementById('val-revenue').textContent = fmtCurrency(data.total_revenue);
  document.getElementById('sub-revenue').textContent = 'all time';

  document.getElementById('val-best').textContent = fmtNumber(data.best_day_visitors);
  const bestSub = document.getElementById('sub-best');
  bestSub.textContent = data.best_day_date ? fmtDate(data.best_day_date) : '';

  const trendEl = document.getElementById('val-trend');
  const trendSub = document.getElementById('sub-trend');
  const pct = data.trend_pct;
  const sign = pct >= 0 ? '+' : '';
  trendEl.textContent = `${sign}${pct}%`;
  trendEl.style.color = pct >= 0 ? 'var(--text-positive)' : 'var(--text-negative)';
  trendSub.textContent = 'vs prior 7 days';
  trendSub.className = 'stat-sub ' + (pct >= 0 ? 'positive' : 'negative');
}

// ─── Category Bars ────────────────────────────────────────────────────────────

function renderCategories(data) {
  const container = document.getElementById('categories-chart');
  if (!data.length) {
    container.innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem">No data.</p>';
    return;
  }

  const max = data[0].value; // already sorted desc
  container.innerHTML = '';

  data.forEach(({ name, value }) => {
    const pct = max > 0 ? (value / max) * 100 : 0;

    const row = document.createElement('div');
    row.className = 'bar-row';

    const labelRow = document.createElement('div');
    labelRow.className = 'bar-label-row';

    const nameEl = document.createElement('span');
    nameEl.className = 'bar-name';
    nameEl.textContent = name;
    nameEl.title = name; // tooltip for truncated names

    const valEl = document.createElement('span');
    valEl.className = 'bar-value';
    valEl.textContent = fmtNumber(value);

    labelRow.appendChild(nameEl);
    labelRow.appendChild(valEl);

    const track = document.createElement('div');
    track.className = 'bar-track';

    const fill = document.createElement('div');
    fill.className = 'bar-fill';
    fill.style.width = '0%';
    track.appendChild(fill);

    row.appendChild(labelRow);
    row.appendChild(track);
    container.appendChild(row);

    // Animate bar after paint
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        fill.style.width = `${pct}%`;
      });
    });
  });
}

// ─── Recent Items Table ───────────────────────────────────────────────────────

function renderRecent(data) {
  const tbody = document.getElementById('recent-tbody');
  if (!data.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="loading-cell">No recent items.</td></tr>';
    return;
  }

  tbody.innerHTML = data.map(item => `
    <tr>
      <td class="td-name" title="${escHtml(item.name)}">${escHtml(item.name)}</td>
      <td class="td-category" title="${escHtml(item.category)}">${escHtml(item.category)}</td>
      <td class="td-value num-col">$${fmtNumber(item.value)}</td>
      <td class="td-date num-col">${fmtShortDate(item.created_at)}</td>
    </tr>
  `).join('');
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

async function loadDashboard() {
  try {
    const [summary, timeseries, categories, recent] = await Promise.all([
      fetch(`${API}/summary`).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); }),
      fetch(`${API}/timeseries`).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); }),
      fetch(`${API}/categories`).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); }),
      fetch(`${API}/recent`).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); }),
    ]);

    renderSummary(summary);
    renderCategories(categories);
    renderRecent(recent);

    // Store for theme-change redraws
    window.__timeseriesData = timeseries;
    drawTimeSeries(timeseries, currentTheme);
    initChartResize();

  } catch (err) {
    console.error('Dashboard load failed:', err);
    showError();
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────

(async () => {
  await loadTheme();
  await loadDashboard();
})();
