const API = '/api';

const els = {
  errorBanner: document.getElementById('error-banner'),
  statGrid: document.getElementById('stat-grid'),
  breakdown: document.getElementById('breakdown'),
  recentBody: document.getElementById('recent-body'),
  chart: document.getElementById('chart'),
  chartContainer: document.getElementById('chart-container'),
  themeToggle: document.getElementById('theme-toggle'),
  themeLabel: document.querySelector('.theme-toggle__label')
};

let state = {
  timeseries: null
};

// ---------- Formatting helpers ----------
const fmtInt = new Intl.NumberFormat('en-US');
function money(n) {
  return '$' + fmtInt.format(Math.round(n));
}
function compact(n) {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}
function fmtDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
function fmtDateTime(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
    ' ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

// ---------- API ----------
async function getJSON(path) {
  const res = await fetch(API + path);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

function showError(msg) {
  els.errorBanner.hidden = false;
  els.errorBanner.textContent = msg;
}
function clearError() {
  els.errorBanner.hidden = true;
  els.errorBanner.textContent = '';
}

// ---------- Theme ----------
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  try {
    localStorage.setItem('theme', theme);
  } catch (e) {}
  if (els.themeLabel) {
    els.themeLabel.textContent = theme === 'dark' ? 'Light' : 'Dark';
  }
  // Chart colors come from CSS vars resolved at draw time, so redraw.
  if (state.timeseries) drawChart(state.timeseries);
}

async function loadTheme() {
  try {
    const { theme } = await getJSON('/settings');
    applyTheme(theme === 'dark' ? 'dark' : 'light');
  } catch (e) {
    // Keep whatever the pre-paint script applied.
  }
}

els.themeToggle.addEventListener('click', async () => {
  const current = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  const next = current === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  try {
    await fetch(API + '/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: next })
    });
  } catch (e) {
    showError('Could not save theme preference (server unreachable).');
  }
});

// ---------- Stat cards ----------
function renderSummary(s) {
  const trendUp = s.trendPct >= 0;
  const arrow = trendUp ? '▲' : '▼';
  const trendClass = trendUp ? 'trend--up' : 'trend--down';
  const bestDay = s.bestDay
    ? `${fmtDate(s.bestDay.day)} · ${money(s.bestDay.revenue)}`
    : '—';

  const cards = [
    {
      label: 'Total Visitors',
      value: fmtInt.format(s.totalVisitors),
      sub: 'across last 30 days'
    },
    {
      label: 'Total Revenue',
      value: money(s.totalRevenue),
      sub: 'across last 30 days'
    },
    {
      label: 'Best Day',
      value: bestDay,
      sub: 'highest revenue'
    },
    {
      label: '7-Day Trend',
      value: `<span class="trend ${trendClass}">${arrow} ${Math.abs(s.trendPct).toFixed(1)}%</span>`,
      sub: 'vs previous 7 days'
    }
  ];

  els.statGrid.innerHTML = cards
    .map(
      (c) => `
      <div class="stat-card">
        <p class="stat-card__label">${c.label}</p>
        <p class="stat-card__value">${c.value}</p>
        <p class="stat-card__sub">${c.sub}</p>
      </div>`
    )
    .join('');
}

// ---------- Categories ----------
function renderCategories(cats) {
  const max = Math.max(...cats.map((c) => c.value), 1);
  els.breakdown.innerHTML = cats
    .map((c) => {
      const pct = (c.value / max) * 100;
      return `
        <div class="bar-row">
          <span class="bar-name" title="${escapeAttr(c.name)}">${escapeHtml(c.name)}</span>
          <span class="bar-value">${money(c.value)}</span>
          <div class="bar-track"><div class="bar-fill" style="width:${pct.toFixed(1)}%"></div></div>
        </div>`;
    })
    .join('');
}

// ---------- Recent table ----------
function renderRecent(items) {
  els.recentBody.innerHTML = items
    .map(
      (it) => `
      <tr>
        <td class="name">${escapeHtml(it.name)}</td>
        <td><span class="cat-pill" title="${escapeAttr(it.category)}">${escapeHtml(it.category)}</span></td>
        <td class="num">${money(it.value)}</td>
        <td>${fmtDateTime(it.createdAt)}</td>
      </tr>`
    )
    .join('');
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

// ---------- Chart (hand-drawn SVG) ----------
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function drawChart(data) {
  const svg = els.chart;
  const rect = els.chartContainer.getBoundingClientRect();
  const width = Math.max(240, Math.round(rect.width));
  const height = Math.max(180, Math.round(rect.height));

  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('preserveAspectRatio', 'none');

  const SVGNS = 'http://www.w3.org/2000/svg';
  while (svg.firstChild) svg.removeChild(svg.firstChild);

  if (!data || data.length === 0) {
    const t = document.createElementNS(SVGNS, 'text');
    t.setAttribute('x', width / 2);
    t.setAttribute('y', height / 2);
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('class', 'chart-axis-label');
    t.textContent = 'No data';
    svg.appendChild(t);
    return;
  }

  // Margins: room for y labels on the left, x labels at the bottom.
  const m = { top: 12, right: 14, bottom: 26, left: 52 };
  const plotW = width - m.left - m.right;
  const plotH = height - m.top - m.bottom;

  const values = data.map((d) => d.revenue);
  let minV = Math.min(...values);
  let maxV = Math.max(...values);
  if (minV === maxV) {
    maxV = maxV + 1;
    minV = minV - 1;
  }
  // Pad the domain a touch and start near zero-ish for nicer ticks.
  const niceMin = Math.max(0, Math.floor(minV * 0.95));
  const niceMax = Math.ceil(maxV * 1.05);

  const x = (i) => m.left + (data.length === 1 ? plotW / 2 : (i / (data.length - 1)) * plotW);
  const y = (v) => m.top + plotH - ((v - niceMin) / (niceMax - niceMin)) * plotH;

  const gridColor = cssVar('--chart-grid');
  const axisColor = cssVar('--chart-axis');
  const labelColor = cssVar('--text-muted');
  const lineColor = cssVar('--chart-line');
  const fillColor = cssVar('--chart-fill');

  function line(x1, y1, x2, y2, color) {
    const el = document.createElementNS(SVGNS, 'line');
    el.setAttribute('x1', x1);
    el.setAttribute('y1', y1);
    el.setAttribute('x2', x2);
    el.setAttribute('y2', y2);
    el.setAttribute('stroke', color);
    el.setAttribute('stroke-width', '1');
    svg.appendChild(el);
  }
  function text(tx, ty, str, anchor) {
    const el = document.createElementNS(SVGNS, 'text');
    el.setAttribute('x', tx);
    el.setAttribute('y', ty);
    el.setAttribute('fill', labelColor);
    el.setAttribute('font-size', '11');
    el.setAttribute('text-anchor', anchor || 'start');
    el.textContent = str;
    svg.appendChild(el);
  }

  // Horizontal gridlines + y labels (5 ticks)
  const yTicks = 4;
  for (let i = 0; i <= yTicks; i++) {
    const v = niceMin + ((niceMax - niceMin) * i) / yTicks;
    const yy = y(v);
    line(m.left, yy, m.left + plotW, yy, gridColor);
    text(m.left - 8, yy + 4, compact(v), 'end');
  }

  // X axis baseline
  line(m.left, m.top + plotH, m.left + plotW, m.top + plotH, axisColor);

  // X labels: first, middle, last day to avoid crowding on narrow widths
  const idxs = [0, Math.floor((data.length - 1) / 2), data.length - 1];
  idxs.forEach((i, k) => {
    const anchor = k === 0 ? 'start' : k === idxs.length - 1 ? 'end' : 'middle';
    text(x(i), m.top + plotH + 18, fmtDate(data[i].day), anchor);
  });

  // Area fill
  let areaD = `M ${x(0)} ${y(values[0])}`;
  for (let i = 1; i < data.length; i++) areaD += ` L ${x(i)} ${y(values[i])}`;
  areaD += ` L ${x(data.length - 1)} ${m.top + plotH} L ${x(0)} ${m.top + plotH} Z`;
  const area = document.createElementNS(SVGNS, 'path');
  area.setAttribute('d', areaD);
  area.setAttribute('fill', fillColor);
  svg.appendChild(area);

  // Series line
  let lineD = `M ${x(0)} ${y(values[0])}`;
  for (let i = 1; i < data.length; i++) lineD += ` L ${x(i)} ${y(values[i])}`;
  const path = document.createElementNS(SVGNS, 'path');
  path.setAttribute('d', lineD);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', lineColor);
  path.setAttribute('stroke-width', '2');
  path.setAttribute('stroke-linejoin', 'round');
  path.setAttribute('stroke-linecap', 'round');
  svg.appendChild(path);
}

// Redraw chart on resize (debounced via rAF).
let resizeScheduled = false;
function onResize() {
  if (resizeScheduled) return;
  resizeScheduled = true;
  requestAnimationFrame(() => {
    resizeScheduled = false;
    if (state.timeseries) drawChart(state.timeseries);
  });
}
window.addEventListener('resize', onResize);
if (window.ResizeObserver) {
  const ro = new ResizeObserver(onResize);
  ro.observe(els.chartContainer);
}

// ---------- Boot ----------
async function init() {
  await loadTheme();
  try {
    const [summary, timeseries, categories, recent] = await Promise.all([
      getJSON('/summary'),
      getJSON('/timeseries'),
      getJSON('/categories'),
      getJSON('/recent')
    ]);
    clearError();
    state.timeseries = timeseries;
    renderSummary(summary);
    renderCategories(categories);
    renderRecent(recent);
    drawChart(timeseries);
  } catch (e) {
    showError('Unable to load dashboard data. Is the API server running?');
    els.statGrid.innerHTML = '';
    els.breakdown.innerHTML = '<p class="skeleton">No data available.</p>';
    els.recentBody.innerHTML = '';
    state.timeseries = [];
    drawChart([]);
  }
}

init();
