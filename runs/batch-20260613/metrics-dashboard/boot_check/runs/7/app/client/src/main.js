const els = {
  status: document.getElementById('status'),
  toggle: document.getElementById('themeToggle'),
  themeText: document.getElementById('themeText'),
  totalVisitors: document.getElementById('totalVisitors'),
  totalRevenue: document.getElementById('totalRevenue'),
  bestDay: document.getElementById('bestDay'),
  bestDayNote: document.getElementById('bestDayNote'),
  trend: document.getElementById('trend'),
  trendNote: document.getElementById('trendNote'),
  chartWrap: document.getElementById('chartWrap'),
  categoryBars: document.getElementById('categoryBars'),
  recentBody: document.getElementById('recentBody')
};

const state = {
  timeseries: [],
  theme: document.documentElement.dataset.theme || 'light',
  resizeObserver: null
};

const numberFmt = new Intl.NumberFormat('en-US');
const compactFmt = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const moneyFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const shortMoneyFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 });
const dateFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });

function api(path, options) {
  return fetch(path, { cache: 'no-store', headers: { 'Content-Type': 'application/json' }, ...options }).then(async (res) => {
    if (!res.ok) throw new Error(`${path} returned ${res.status}`);
    return res.json();
  });
}

function setStatus(message, type = '') {
  els.status.hidden = !message;
  els.status.textContent = message || '';
  els.status.className = `status ${type}`.trim();
}

function applyTheme(theme) {
  state.theme = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = state.theme;
  els.toggle.setAttribute('aria-pressed', String(state.theme === 'dark'));
  els.themeText.textContent = state.theme === 'dark' ? 'Dark' : 'Light';
  drawChart();
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function renderSummary(summary) {
  els.totalVisitors.textContent = numberFmt.format(summary.totalVisitors);
  els.totalRevenue.textContent = moneyFmt.format(summary.totalRevenue);
  const bestDate = new Date(`${summary.bestDay.date}T00:00:00Z`);
  els.bestDay.textContent = dateFmt.format(bestDate);
  els.bestDayNote.textContent = `${shortMoneyFmt.format(summary.bestDay.revenue)} / ${numberFmt.format(summary.bestDay.visitors)} visitors`;
  const trend = Number(summary.sevenDayTrend);
  els.trend.textContent = `${trend >= 0 ? '+' : ''}${trend.toFixed(1)}%`;
  els.trend.classList.toggle('positive', trend >= 0);
  els.trend.classList.toggle('negative', trend < 0);
  els.trendNote.textContent = trend >= 0 ? 'Up vs previous 7 days' : 'Down vs previous 7 days';
}

function renderCategories(categories) {
  els.categoryBars.textContent = '';
  const max = Math.max(...categories.map(c => c.value), 1);
  for (const category of categories) {
    const row = document.createElement('div');
    row.className = 'category-row';

    const label = document.createElement('div');
    label.className = 'category-label';
    label.title = category.label;
    label.textContent = category.label;

    const value = document.createElement('div');
    value.className = 'category-value';
    value.textContent = numberFmt.format(category.value);

    const track = document.createElement('div');
    track.className = 'bar-track';
    const fill = document.createElement('div');
    fill.className = 'bar-fill';
    fill.style.width = `${Math.max(2, (category.value / max) * 100)}%`;
    track.appendChild(fill);

    row.append(label, value, track);
    els.categoryBars.appendChild(row);
  }
}

function renderRecent(items) {
  els.recentBody.textContent = '';
  for (const item of items) {
    const tr = document.createElement('tr');
    const date = new Date(item.createdAt);
    tr.innerHTML = `
      <td data-label="Name" class="name-cell" title="${escapeAttr(item.name)}">${escapeHtml(item.name)}</td>
      <td data-label="Category" class="category-cell" title="${escapeAttr(item.category)}">${escapeHtml(item.category)}</td>
      <td data-label="Value" class="value-cell">${moneyFmt.format(item.value)}</td>
      <td data-label="Date" class="date-cell">${dateFmt.format(date)}</td>
    `;
    els.recentBody.appendChild(tr);
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
}
function escapeAttr(value) { return escapeHtml(value).replace(/'/g, '&#39;'); }

function drawChart() {
  if (!els.chartWrap || !state.timeseries.length) return;
  const rect = els.chartWrap.getBoundingClientRect();
  const width = Math.max(280, Math.floor(rect.width));
  const height = Math.max(230, Math.floor(rect.height));
  const compact = width < 430;
  const margin = {
    top: 18,
    right: compact ? 12 : 20,
    bottom: compact ? 46 : 42,
    left: compact ? 46 : 58
  };
  const innerW = Math.max(120, width - margin.left - margin.right);
  const innerH = Math.max(120, height - margin.top - margin.bottom);

  const values = state.timeseries.map(d => d.visitors);
  const minRaw = Math.min(...values);
  const maxRaw = Math.max(...values);
  const pad = Math.max(50, (maxRaw - minRaw) * 0.12);
  const min = Math.max(0, Math.floor((minRaw - pad) / 100) * 100);
  const max = Math.ceil((maxRaw + pad) / 100) * 100;
  const x = (i) => margin.left + (state.timeseries.length === 1 ? 0 : (i / (state.timeseries.length - 1)) * innerW);
  const y = (v) => margin.top + (1 - ((v - min) / (max - min || 1))) * innerH;

  const points = state.timeseries.map((d, i) => [x(i), y(d.visitors)]);
  const line = points.map((p, i) => `${i ? 'L' : 'M'} ${p[0].toFixed(2)} ${p[1].toFixed(2)}`).join(' ');
  const area = `${line} L ${points.at(-1)[0].toFixed(2)} ${(margin.top + innerH).toFixed(2)} L ${points[0][0].toFixed(2)} ${(margin.top + innerH).toFixed(2)} Z`;
  const yTicks = Array.from({ length: 5 }, (_, i) => min + ((max - min) / 4) * i);
  const xTickIndexes = compact ? [0, 14, 29] : [0, 7, 14, 21, 29];

  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', '30 day visitors line chart');

  const gridGroup = document.createElementNS(svgNS, 'g');
  for (const tick of yTicks) {
    const yy = y(tick);
    gridGroup.appendChild(lineEl(margin.left, yy, margin.left + innerW, yy, 'grid-line'));
    const text = textEl(margin.left - 8, yy + 4, compactFmt.format(tick), 'axis-label');
    text.setAttribute('text-anchor', 'end');
    text.setAttribute('fill', cssVar('--axis'));
    text.setAttribute('font-size', '11');
    gridGroup.appendChild(text);
  }
  svg.appendChild(gridGroup);

  const axis = document.createElementNS(svgNS, 'g');
  axis.setAttribute('class', 'axis');
  axis.appendChild(lineEl(margin.left, margin.top, margin.left, margin.top + innerH, ''));
  axis.appendChild(lineEl(margin.left, margin.top + innerH, margin.left + innerW, margin.top + innerH, ''));
  for (const i of xTickIndexes) {
    const xx = x(i);
    axis.appendChild(lineEl(xx, margin.top + innerH, xx, margin.top + innerH + 5, ''));
    const d = new Date(`${state.timeseries[i].date}T00:00:00Z`);
    const label = textEl(xx, margin.top + innerH + 22, dateFmt.format(d), '');
    label.setAttribute('text-anchor', i === 0 ? 'start' : i === 29 ? 'end' : 'middle');
    axis.appendChild(label);
  }
  svg.appendChild(axis);

  const areaPath = document.createElementNS(svgNS, 'path');
  areaPath.setAttribute('d', area);
  areaPath.setAttribute('class', 'series-area');
  svg.appendChild(areaPath);

  const linePath = document.createElementNS(svgNS, 'path');
  linePath.setAttribute('d', line);
  linePath.setAttribute('class', 'series-line');
  svg.appendChild(linePath);

  points.forEach((p, i) => {
    if (i % (compact ? 7 : 5) === 0 || i === points.length - 1) {
      const c = document.createElementNS(svgNS, 'circle');
      c.setAttribute('cx', p[0]);
      c.setAttribute('cy', p[1]);
      c.setAttribute('r', compact ? 3 : 3.5);
      c.setAttribute('class', 'point');
      svg.appendChild(c);
    }
  });

  els.chartWrap.replaceChildren(svg);
}

function lineEl(x1, y1, x2, y2, className) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  el.setAttribute('x1', x1); el.setAttribute('y1', y1); el.setAttribute('x2', x2); el.setAttribute('y2', y2);
  if (className) el.setAttribute('class', className);
  return el;
}

function textEl(x, y, text, className) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  el.setAttribute('x', x); el.setAttribute('y', y); el.textContent = text;
  if (className) el.setAttribute('class', className);
  return el;
}

async function load() {
  setStatus('Loading dashboard data…');
  try {
    const [settings, summary, timeseries, categories, recent] = await Promise.all([
      api('/api/settings'), api('/api/summary'), api('/api/timeseries'), api('/api/categories'), api('/api/recent')
    ]);
    applyTheme(settings.theme);
    renderSummary(summary);
    state.timeseries = timeseries;
    renderCategories(categories);
    renderRecent(recent);
    drawChart();
    setStatus('');
  } catch (err) {
    console.error(err);
    setStatus('Unable to reach the metrics API. Start the backend server to load dashboard data.', 'error');
    els.chartWrap.textContent = '';
    els.categoryBars.textContent = '';
    els.recentBody.innerHTML = '<tr><td colspan="4">No API data available.</td></tr>';
  }
}

els.toggle.addEventListener('click', async () => {
  const next = state.theme === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  try {
    await api('/api/settings', { method: 'PUT', body: JSON.stringify({ theme: next }) });
  } catch (err) {
    console.error(err);
    setStatus('Theme changed locally, but the API did not persist it.', 'error');
  }
});

window.addEventListener('resize', () => requestAnimationFrame(drawChart));
if ('ResizeObserver' in window) {
  state.resizeObserver = new ResizeObserver(() => requestAnimationFrame(drawChart));
  state.resizeObserver.observe(els.chartWrap);
}

load();
