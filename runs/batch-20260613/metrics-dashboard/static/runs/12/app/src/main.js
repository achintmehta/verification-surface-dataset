import { createChart } from './chart.js';

// --- Formatting helpers ------------------------------------------------------

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
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

// --- API ---------------------------------------------------------------------

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error(`Request to ${path} failed: ${res.status}`);
  return res.json();
}

// --- State / elements --------------------------------------------------------

const els = {
  statGrid: document.getElementById('stat-grid'),
  chart: document.getElementById('chart'),
  breakdown: document.getElementById('breakdown'),
  tableWrap: document.getElementById('table-wrap'),
  error: document.getElementById('error-banner'),
  toggle: document.getElementById('theme-toggle'),
  toggleIcon: document.querySelector('.theme-toggle__icon'),
  toggleLabel: document.querySelector('.theme-toggle__label'),
};

const chart = createChart(els.chart);

function showError(msg) {
  els.error.hidden = false;
  els.error.textContent = msg;
}
function clearError() {
  els.error.hidden = true;
  els.error.textContent = '';
}

// --- Theme -------------------------------------------------------------------

function applyTheme(theme) {
  const t = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', t);
  // Toggle button shows what it will switch TO.
  if (t === 'dark') {
    els.toggleIcon.textContent = '☀️';
    els.toggleLabel.textContent = 'Light';
  } else {
    els.toggleIcon.textContent = '🌙';
    els.toggleLabel.textContent = 'Dark';
  }
  // Chart internals must restyle on theme change.
  chart.render();
}

async function loadTheme() {
  try {
    const { theme } = await api('/api/settings');
    applyTheme(theme);
  } catch {
    // If settings can't load, fall back to light but surface the error later.
    applyTheme('light');
    throw new Error('settings');
  }
}

async function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  applyTheme(next); // optimistic
  try {
    await api('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: next }),
    });
  } catch {
    showError('Could not save theme preference. The backend may be unavailable.');
  }
}

els.toggle.addEventListener('click', toggleTheme);

// --- Renderers ---------------------------------------------------------------

function renderStats(summary) {
  const trendUp = summary.trendPct >= 0;
  const trendClass = trendUp ? 'trend--up' : 'trend--down';
  const trendSign = trendUp ? '▲' : '▼';
  const bestDayLabel = summary.bestDay
    ? `${fmtDate(summary.bestDay.day)} · ${fmtNum(summary.bestDay.visitors)} visitors`
    : '—';

  const cards = [
    {
      label: 'Total Visitors',
      value: fmtNum(summary.totalVisitors),
      sub: 'Last 30 days',
    },
    {
      label: 'Total Revenue',
      value: fmtMoney(summary.totalRevenue),
      sub: 'Last 30 days',
    },
    {
      label: 'Best Day',
      value: summary.bestDay ? fmtNum(summary.bestDay.visitors) : '—',
      sub: bestDayLabel,
    },
    {
      label: '7-Day Trend',
      valueHtml: `<span class="trend ${trendClass}">${trendSign} ${Math.abs(summary.trendPct)}%</span>`,
      sub: 'vs prior 7 days',
    },
  ];

  els.statGrid.replaceChildren(
    ...cards.map((c) => {
      const card = document.createElement('article');
      card.className = 'stat-card';
      const label = document.createElement('p');
      label.className = 'stat-card__label';
      label.textContent = c.label;
      const value = document.createElement('p');
      value.className = 'stat-card__value';
      if (c.valueHtml) value.innerHTML = c.valueHtml;
      else value.textContent = c.value;
      const sub = document.createElement('p');
      sub.className = 'stat-card__sub';
      sub.textContent = c.sub;
      card.append(label, value, sub);
      return card;
    })
  );
}

function renderBreakdown(categories) {
  const max = Math.max(...categories.map((c) => c.value), 1);
  els.breakdown.replaceChildren(
    ...categories.map((c) => {
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
      value.textContent = fmtNum(c.value);
      head.append(name, value);

      const track = document.createElement('div');
      track.className = 'bar-row__track';
      const fill = document.createElement('div');
      fill.className = 'bar-row__fill';
      fill.style.width = `${(c.value / max) * 100}%`;
      track.append(fill);

      row.append(head, track);
      return row;
    })
  );
}

function renderTable(items) {
  const table = document.createElement('table');
  table.className = 'recent-table';
  table.innerHTML = `
    <thead>
      <tr>
        <th scope="col">Name</th>
        <th scope="col">Category</th>
        <th scope="col" style="text-align:right">Value</th>
        <th scope="col">When</th>
      </tr>
    </thead>
  `;
  const tbody = document.createElement('tbody');
  for (const it of items) {
    const tr = document.createElement('tr');
    const tdName = document.createElement('td');
    tdName.textContent = it.name;
    const tdCat = document.createElement('td');
    tdCat.textContent = it.category;
    const tdVal = document.createElement('td');
    tdVal.className = 'num';
    tdVal.textContent = fmtMoney(it.value);
    const tdWhen = document.createElement('td');
    tdWhen.textContent = fmtDateTime(it.createdAt);
    tr.append(tdName, tdCat, tdVal, tdWhen);
    tbody.append(tr);
  }
  table.append(tbody);
  els.tableWrap.replaceChildren(table);
}

// --- Load all ----------------------------------------------------------------

function setLoading() {
  els.statGrid.innerHTML = '<p class="loading">Loading…</p>';
  els.breakdown.innerHTML = '<p class="loading">Loading…</p>';
  els.tableWrap.innerHTML = '<p class="loading">Loading…</p>';
}

async function loadDashboard() {
  setLoading();
  try {
    const [summary, timeseries, categories, recent] = await Promise.all([
      api('/api/summary'),
      api('/api/timeseries'),
      api('/api/categories'),
      api('/api/recent'),
    ]);
    clearError();
    renderStats(summary);
    chart.setData(timeseries.map((d) => ({ day: d.day, visitors: d.visitors })));
    renderBreakdown(categories);
    renderTable(recent);
  } catch (err) {
    // Explicit error state — no stale hardcoded content.
    showError(
      'Unable to load dashboard data. The backend may be stopped — start the server and reload.'
    );
    els.statGrid.innerHTML = '';
    els.breakdown.innerHTML = '';
    els.tableWrap.innerHTML = '';
    els.chart.replaceChildren();
  }
}

// --- Resize handling: chart redraws to fit container -------------------------

let resizeTimer = null;
function onResize() {
  if (resizeTimer) cancelAnimationFrame(resizeTimer);
  resizeTimer = requestAnimationFrame(() => chart.render());
}
window.addEventListener('resize', onResize);
if (typeof ResizeObserver !== 'undefined') {
  const ro = new ResizeObserver(() => chart.render());
  ro.observe(els.chart);
}

// --- Boot --------------------------------------------------------------------

(async function init() {
  // Apply persisted theme before first data paint.
  try {
    await loadTheme();
  } catch {
    // theme load failure handled by dashboard error state below
  }
  await loadDashboard();
})();
