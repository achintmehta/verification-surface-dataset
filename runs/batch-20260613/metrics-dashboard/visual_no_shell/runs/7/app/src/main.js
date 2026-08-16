const $ = (id) => document.getElementById(id);
const formatInt = new Intl.NumberFormat('en-US');
const formatCurrency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const shortCurrency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 });
const shortNumber = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

const state = { timeseries: [], categories: [], resizeObserver: null, theme: document.documentElement.dataset.theme || 'light' };

function setStatus(message, type = 'info') {
  const el = $('status');
  el.hidden = !message;
  el.textContent = message || '';
  el.dataset.type = type;
}

function applyTheme(theme) {
  state.theme = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = state.theme;
  document.documentElement.style.colorScheme = state.theme;
  const toggle = $('themeToggle');
  const label = $('themeLabel');
  toggle?.setAttribute('aria-pressed', String(state.theme === 'dark'));
  if (label) label.textContent = state.theme === 'dark' ? 'Dark mode' : 'Light mode';
  drawLineChart();
}

async function fetchJson(url, options) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.json();
}

function renderSummary(summary) {
  $('totalVisitors').textContent = formatInt.format(summary.totalVisitors);
  $('totalRevenue').textContent = formatCurrency.format(summary.totalRevenue);
  const dt = new Date(summary.bestDay.date + 'T00:00:00');
  $('bestDay').textContent = dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  $('bestDayMeta').textContent = `${formatInt.format(summary.bestDay.visitors)} visitors`;
  $('trendPercent').textContent = `${summary.trendPercent >= 0 ? '+' : ''}${summary.trendPercent.toFixed(1)}%`;
  $('trendPercent').classList.toggle('positive', summary.trendPercent >= 0);
  $('trendPercent').classList.toggle('negative', summary.trendPercent < 0);
  $('visitorsTrend').textContent = '30 day total';
  document.querySelectorAll('.skeleton').forEach(el => el.classList.remove('skeleton'));
}

function renderCategories(categories) {
  const max = Math.max(...categories.map(c => c.value), 1);
  $('categoryBars').innerHTML = categories.map(cat => {
    const pct = Math.max(4, (cat.value / max) * 100);
    return `<div class="category-row">
      <div class="category-topline">
        <span class="category-name" title="${escapeHtml(cat.label)}">${escapeHtml(cat.label)}</span>
        <span class="category-value">${formatInt.format(cat.value)}</span>
      </div>
      <div class="bar-track" aria-hidden="true"><div class="bar-fill" style="width:${pct}%"></div></div>
    </div>`;
  }).join('');
}

function renderRecent(items) {
  $('recentTableBody').innerHTML = items.map(item => {
    const date = new Date(item.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return `<tr>
      <td data-label="Name"><span class="item-name">${escapeHtml(item.name)}</span></td>
      <td data-label="Category"><span class="table-category" title="${escapeHtml(item.category)}">${escapeHtml(item.category)}</span></td>
      <td data-label="Value">${formatCurrency.format(item.value)}</td>
      <td data-label="Created">${date}</td>
    </tr>`;
  }).join('');
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch]));
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function makeSvgEl(name, attrs = {}) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', name);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  return el;
}

function niceTicks(min, max, count) {
  if (max <= min) return [min, max];
  const raw = (max - min) / Math.max(1, count - 1);
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const mult = raw / pow;
  const nice = (mult <= 1 ? 1 : mult <= 2 ? 2 : mult <= 5 ? 5 : 10) * pow;
  const start = Math.floor(min / nice) * nice;
  const end = Math.ceil(max / nice) * nice;
  const ticks = [];
  for (let v = start; v <= end + nice * 0.5; v += nice) ticks.push(v);
  return ticks.slice(-6);
}

function drawLineChart() {
  const container = $('lineChart');
  if (!container || !state.timeseries.length) return;
  const width = Math.max(280, Math.floor(container.clientWidth));
  const height = Math.max(260, Math.floor(container.clientHeight || 320));
  container.innerHTML = '';

  const svg = makeSvgEl('svg', { viewBox: `0 0 ${width} ${height}`, width: '100%', height: '100%', role: 'presentation', class: 'line-svg' });
  const isSmall = width < 420;
  const margin = { top: 22, right: isSmall ? 10 : 18, bottom: 42, left: isSmall ? 48 : 62 };
  const plotW = Math.max(1, width - margin.left - margin.right);
  const plotH = Math.max(1, height - margin.top - margin.bottom);
  const values = state.timeseries.map(d => d.visitors);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = (max - min) * 0.12 || 100;
  const yMin = Math.max(0, min - pad);
  const yMax = max + pad;
  const x = (i) => margin.left + (state.timeseries.length === 1 ? 0 : (i / (state.timeseries.length - 1)) * plotW);
  const y = (v) => margin.top + ((yMax - v) / (yMax - yMin)) * plotH;

  const gridColor = cssVar('--chart-grid');
  const axisColor = cssVar('--chart-axis');
  const textColor = cssVar('--muted');
  const lineColor = cssVar('--series');
  const fillColor = cssVar('--series-fill');

  const ticks = niceTicks(yMin, yMax, 5);
  ticks.forEach(tick => {
    const yy = y(tick);
    svg.appendChild(makeSvgEl('line', { x1: margin.left, y1: yy, x2: width - margin.right, y2: yy, stroke: gridColor, 'stroke-width': '1' }));
    const label = makeSvgEl('text', { x: margin.left - 8, y: yy + 4, 'text-anchor': 'end', fill: textColor, 'font-size': isSmall ? '10' : '11' });
    label.textContent = shortNumber.format(tick);
    svg.appendChild(label);
  });

  svg.appendChild(makeSvgEl('line', { x1: margin.left, y1: margin.top, x2: margin.left, y2: height - margin.bottom, stroke: axisColor, 'stroke-width': '1.2' }));
  svg.appendChild(makeSvgEl('line', { x1: margin.left, y1: height - margin.bottom, x2: width - margin.right, y2: height - margin.bottom, stroke: axisColor, 'stroke-width': '1.2' }));

  const xTickIndexes = isSmall ? [0, 14, 29] : [0, 7, 14, 21, 29];
  xTickIndexes.forEach(i => {
    const xx = x(i);
    svg.appendChild(makeSvgEl('line', { x1: xx, y1: height - margin.bottom, x2: xx, y2: height - margin.bottom + 5, stroke: axisColor, 'stroke-width': '1' }));
    const d = new Date(state.timeseries[i].date + 'T00:00:00');
    const label = makeSvgEl('text', { x: xx, y: height - margin.bottom + 24, 'text-anchor': i === 0 ? 'start' : i === 29 ? 'end' : 'middle', fill: textColor, 'font-size': isSmall ? '10' : '11' });
    label.textContent = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    svg.appendChild(label);
  });

  const points = state.timeseries.map((d, i) => `${x(i).toFixed(1)},${y(d.visitors).toFixed(1)}`);
  const area = `${margin.left},${height - margin.bottom} ${points.join(' ')} ${width - margin.right},${height - margin.bottom}`;
  svg.appendChild(makeSvgEl('polyline', { points: area, fill: fillColor, stroke: 'none' }));
  svg.appendChild(makeSvgEl('polyline', { points: points.join(' '), fill: 'none', stroke: lineColor, 'stroke-width': isSmall ? '2.4' : '3', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  state.timeseries.forEach((d, i) => {
    if (i % (isSmall ? 10 : 7) === 0 || i === state.timeseries.length - 1) {
      svg.appendChild(makeSvgEl('circle', { cx: x(i), cy: y(d.visitors), r: isSmall ? '3' : '3.5', fill: lineColor, stroke: cssVar('--card'), 'stroke-width': '2' }));
    }
  });
  const caption = makeSvgEl('text', { x: margin.left, y: 16, fill: textColor, 'font-size': '11', 'font-weight': '700' });
  caption.textContent = `Visitors (latest ${formatInt.format(values.at(-1))}) • Revenue ${shortCurrency.format(state.timeseries.at(-1).revenue)}`;
  svg.appendChild(caption);
  container.appendChild(svg);
}

async function loadDashboard() {
  setStatus('Loading dashboard data…');
  try {
    const [settings, summary, timeseries, categories, recent] = await Promise.all([
      fetchJson('/api/settings'),
      fetchJson('/api/summary'),
      fetchJson('/api/timeseries'),
      fetchJson('/api/categories'),
      fetchJson('/api/recent')
    ]);
    applyTheme(settings.theme);
    state.timeseries = timeseries;
    state.categories = categories;
    renderSummary(summary);
    renderCategories(categories);
    renderRecent(recent);
    drawLineChart();
    setStatus('');
  } catch (err) {
    console.error(err);
    setStatus('Unable to load dashboard data from the API. Start the backend and reload to render live metrics.', 'error');
    document.querySelectorAll('.skeleton').forEach(el => el.textContent = 'Unavailable');
  }
}

$('themeToggle')?.addEventListener('click', async () => {
  const next = state.theme === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  try {
    await fetchJson('/api/settings', { method: 'PUT', body: JSON.stringify({ theme: next }) });
  } catch (err) {
    console.error(err);
    setStatus('Theme changed locally, but could not be persisted to the server.', 'error');
  }
});

state.resizeObserver = new ResizeObserver(() => requestAnimationFrame(drawLineChart));
state.resizeObserver.observe($('lineChart'));
window.addEventListener('resize', () => requestAnimationFrame(drawLineChart));
applyTheme(state.theme);
loadDashboard();
