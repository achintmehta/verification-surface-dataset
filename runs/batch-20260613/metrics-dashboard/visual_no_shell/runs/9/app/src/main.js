const API = '';
const state = {
  summary: null,
  timeseries: [],
  categories: [],
  recent: [],
  theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
};

const fmtInt = new Intl.NumberFormat('en-US');
const fmtCurrency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const fmtShortCurrency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 });
const fmtDate = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });

function qs(id) { return document.getElementById(id); }

async function fetchJson(url, options) {
  const res = await fetch(API + url, { headers: { 'Content-Type': 'application/json' }, ...options });
  if (!res.ok) throw new Error(`${url} failed with ${res.status}`);
  return res.json();
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function applyTheme(theme) {
  state.theme = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = state.theme;
  const btn = qs('themeToggle');
  btn.setAttribute('aria-pressed', String(state.theme === 'dark'));
  btn.querySelector('.toggle-text').textContent = state.theme === 'dark' ? 'Dark' : 'Light';
  drawLineChart();
}

function renderSummary() {
  const s = state.summary;
  qs('totalVisitors').textContent = fmtInt.format(s.totalVisitors);
  qs('totalRevenue').textContent = fmtCurrency.format(s.totalRevenue);
  qs('bestDay').textContent = s.bestDay ? fmtDate.format(new Date(`${s.bestDay.date}T00:00:00Z`)) : '—';
  qs('bestDayMeta').textContent = s.bestDay ? `${fmtCurrency.format(s.bestDay.revenue)} revenue` : 'No data';
  const trend = s.sevenDayTrend;
  qs('sevenDayTrend').textContent = `${trend >= 0 ? '+' : ''}${trend.toFixed(1)}%`;
  const trendMeta = qs('trendMeta');
  trendMeta.textContent = trend >= 0 ? 'Improving vs prior week' : 'Down vs prior week';
  trendMeta.classList.toggle('negative', trend < 0);
  document.querySelectorAll('.skeleton').forEach(el => el.classList.remove('skeleton'));
}

function renderCategories() {
  const el = qs('categories');
  const max = Math.max(...state.categories.map(c => c.value), 1);
  el.innerHTML = '';
  state.categories.forEach(cat => {
    const row = document.createElement('div');
    row.className = 'bar-row';
    const label = document.createElement('div');
    label.className = 'bar-label';
    label.title = cat.label;
    label.textContent = cat.label;
    const track = document.createElement('div');
    track.className = 'bar-track';
    const fill = document.createElement('div');
    fill.className = 'bar-fill';
    fill.style.width = `${Math.max(5, (cat.value / max) * 100)}%`;
    track.appendChild(fill);
    const value = document.createElement('div');
    value.className = 'bar-value';
    value.textContent = fmtCurrency.format(cat.value);
    row.append(label, track, value);
    el.appendChild(row);
  });
}

function renderRecent() {
  const body = qs('recentBody');
  body.innerHTML = '';
  state.recent.forEach(item => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td data-label="Name"><span class="cell-primary" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span></td>
      <td data-label="Category"><span class="cell-muted" title="${escapeHtml(item.category)}">${escapeHtml(item.category)}</span></td>
      <td data-label="Value" class="numeric">${fmtCurrency.format(item.value)}</td>
      <td data-label="Date">${fmtDate.format(new Date(item.createdAt))}</td>
    `;
    body.appendChild(tr);
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch]));
}

function niceTicks(min, max, count = 5) {
  if (min === max) return [min];
  const span = max - min;
  const step0 = span / Math.max(1, count - 1);
  const pow = Math.pow(10, Math.floor(Math.log10(step0)));
  const err = step0 / pow;
  const step = (err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1) * pow;
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = start; v <= end + step * 0.5; v += step) ticks.push(Math.round(v));
  return ticks.slice(-7);
}

function drawLineChart() {
  const shell = qs('lineChart');
  if (!shell || !state.timeseries.length) return;
  const rect = shell.getBoundingClientRect();
  const width = Math.max(280, Math.floor(rect.width));
  const height = Math.max(260, Math.floor(rect.height || 300));
  const compact = width < 430;
  const margin = { top: 18, right: compact ? 12 : 18, bottom: compact ? 48 : 42, left: compact ? 46 : 58 };
  const plotW = Math.max(1, width - margin.left - margin.right);
  const plotH = Math.max(1, height - margin.top - margin.bottom);
  const values = state.timeseries.map(d => d.visitors);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const ticks = niceTicks(Math.max(0, min - 120), max + 120, 5);
  const yMin = ticks[0];
  const yMax = ticks[ticks.length - 1];
  const x = i => margin.left + (state.timeseries.length === 1 ? 0 : (i / (state.timeseries.length - 1)) * plotW);
  const y = v => margin.top + (1 - (v - yMin) / Math.max(1, yMax - yMin)) * plotH;
  const points = state.timeseries.map((d, i) => `${x(i).toFixed(1)},${y(d.visitors).toFixed(1)}`).join(' ');
  const grid = ticks.map(t => {
    const yy = y(t);
    return `<g><line class="gridline" x1="${margin.left}" x2="${width - margin.right}" y1="${yy}" y2="${yy}"/><text class="axis-label" x="${margin.left - 8}" y="${yy + 4}" text-anchor="end">${fmtInt.format(t)}</text></g>`;
  }).join('');
  const dateTicks = compact ? [0, 14, 29] : [0, 7, 14, 21, 29];
  const xAxis = dateTicks.map(i => {
    const xx = x(i);
    const label = fmtDate.format(new Date(`${state.timeseries[i].date}T00:00:00Z`));
    return `<g><line class="tick" x1="${xx}" x2="${xx}" y1="${margin.top + plotH}" y2="${margin.top + plotH + 5}"/><text class="axis-label" x="${xx}" y="${height - 16}" text-anchor="middle">${label}</text></g>`;
  }).join('');
  const area = `${margin.left},${margin.top + plotH} ${points} ${width - margin.right},${margin.top + plotH}`;
  shell.innerHTML = `
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
      <rect class="chart-bg" x="0" y="0" width="${width}" height="${height}" rx="14"/>
      ${grid}
      <line class="axis" x1="${margin.left}" x2="${width - margin.right}" y1="${margin.top + plotH}" y2="${margin.top + plotH}"/>
      <line class="axis" x1="${margin.left}" x2="${margin.left}" y1="${margin.top}" y2="${margin.top + plotH}"/>
      ${xAxis}
      <polygon class="series-area" points="${area}"/>
      <polyline class="series-line" points="${points}" fill="none"/>
      ${state.timeseries.map((d, i) => i % (compact ? 10 : 7) === 0 || i === state.timeseries.length - 1 ? `<circle class="series-dot" cx="${x(i)}" cy="${y(d.visitors)}" r="3"/>` : '').join('')}
    </svg>
  `;
}

let resizeTimer;
function setupResize() {
  if ('ResizeObserver' in window) {
    const ro = new ResizeObserver(() => drawLineChart());
    ro.observe(qs('lineChart'));
  } else {
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(drawLineChart, 80);
    });
  }
}

async function loadAll() {
  try {
    const [settings, summary, timeseries, categories, recent] = await Promise.all([
      fetchJson('/api/settings'),
      fetchJson('/api/summary'),
      fetchJson('/api/timeseries'),
      fetchJson('/api/categories'),
      fetchJson('/api/recent')
    ]);
    applyTheme(settings.theme);
    Object.assign(state, { summary, timeseries, categories, recent });
    renderSummary();
    renderCategories();
    renderRecent();
    drawLineChart();
  } catch (error) {
    console.error(error);
    qs('errorState').hidden = false;
    document.querySelector('main').classList.add('has-error');
  }
}

qs('themeToggle').addEventListener('click', async () => {
  const next = state.theme === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  try {
    await fetchJson('/api/settings', { method: 'PUT', body: JSON.stringify({ theme: next }) });
  } catch (error) {
    console.error(error);
    qs('errorState').hidden = false;
  }
});

setupResize();
loadAll();
