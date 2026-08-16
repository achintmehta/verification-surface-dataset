const API = '';

const state = {
  summary: null,
  timeseries: null,
  categories: null,
  recent: null,
  theme: document.documentElement.getAttribute('data-theme') || 'light',
  error: false
};

const fmtInt = new Intl.NumberFormat('en-US');
const fmtCurrency = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0
});
const fmtDateShort = (iso) => {
  const d = new Date(iso + (iso.length === 10 ? 'T00:00:00Z' : ''));
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
};
const fmtDateTime = (iso) => {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
    ' ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
};

async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error('request failed: ' + url);
  return res.json();
}

async function loadAll() {
  state.error = false;
  try {
    const [summary, timeseries, categories, recent, settings] = await Promise.all([
      fetchJSON(API + '/api/summary'),
      fetchJSON(API + '/api/timeseries'),
      fetchJSON(API + '/api/categories'),
      fetchJSON(API + '/api/recent'),
      fetchJSON(API + '/api/settings')
    ]);
    state.summary = summary;
    state.timeseries = timeseries;
    state.categories = categories;
    state.recent = recent;
    state.theme = settings.theme === 'dark' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', state.theme);
  } catch (e) {
    console.error(e);
    state.error = true;
  }
  render();
}

/* ---------- Rendering ---------- */

const dash = document.getElementById('dashboard');

function render() {
  if (state.error || !state.summary) {
    dash.innerHTML = `
      <div class="state state--error">
        <div class="state__title">Unable to load dashboard data</div>
        <div>The backend API is not responding. No data is available to display.</div>
        <button class="retry-btn" id="retry-btn" type="button">Retry</button>
      </div>`;
    const btn = document.getElementById('retry-btn');
    if (btn) btn.addEventListener('click', loadAll);
    return;
  }

  const s = state.summary;
  const trend = s.trend7d ?? 0;
  const up = trend >= 0;
  const bestVisitors = s.bestDay ? fmtInt.format(s.bestDay.visitors) : '—';
  const bestDate = s.bestDay ? fmtDateShort(s.bestDay.date) : '';

  dash.innerHTML = `
    ${statCard('stat0', 'Total Visitors', fmtInt.format(s.totalVisitors), '30-day total')}
    ${statCard('stat1', 'Total Revenue', fmtCurrency.format(s.totalRevenue), '30-day total')}
    ${statCard('stat2', 'Best Day', bestVisitors, bestDate ? `${bestDate} · visitors` : 'visitors')}
    ${statCard(
      'stat3',
      '7-Day Trend',
      `<span class="trend ${up ? 'trend--up' : 'trend--down'}">${up ? '▲' : '▼'} ${Math.abs(trend).toFixed(1)}%</span>`,
      'vs previous 7 days',
      true
    )}

    <section class="card chart-card">
      <h2 class="card__title">Visitors — Last 30 Days</h2>
      <div class="chart-wrap" id="chart-wrap"></div>
    </section>

    <section class="card breakdown-card">
      <h2 class="card__title">Category Breakdown</h2>
      <div id="breakdown"></div>
    </section>

    <section class="card recent-card">
      <h2 class="card__title">Recent Items</h2>
      <div class="table-scroll">
        <table class="recent-table">
          <thead>
            <tr><th>Name</th><th>Category</th><th class="num">Value</th><th>Created</th></tr>
          </thead>
          <tbody>${recentRows()}</tbody>
        </table>
      </div>
    </section>
  `;

  renderBreakdown();
  drawChart();
  observeChart();
}

function statCard(area, label, valueHTML, sub, raw) {
  const value = raw ? valueHTML : escapeHtml(valueHTML);
  return `
    <section class="card stat-card ${area}">
      <span class="stat-card__label">${escapeHtml(label)}</span>
      <span class="stat-card__value">${value}</span>
      <span class="stat-card__sub">${escapeHtml(sub)}</span>
    </section>`;
}

function recentRows() {
  return state.recent
    .map(
      (r) => `
      <tr>
        <td class="cell-name">${escapeHtml(r.name)}</td>
        <td class="cell-cat" title="${escapeHtml(r.category)}">${escapeHtml(r.category)}</td>
        <td class="num">${fmtCurrency.format(r.value)}</td>
        <td>${escapeHtml(fmtDateTime(r.createdAt))}</td>
      </tr>`
    )
    .join('');
}

function renderBreakdown() {
  const el = document.getElementById('breakdown');
  if (!el) return;
  const max = Math.max(...state.categories.map((c) => c.value), 1);
  el.innerHTML = state.categories
    .map((c) => {
      const pct = Math.max(2, (c.value / max) * 100);
      return `
      <div class="bar-row">
        <div class="bar-head">
          <span class="bar-name" title="${escapeHtml(c.name)}">${escapeHtml(c.name)}</span>
          <span class="bar-value">${fmtInt.format(c.value)}</span>
        </div>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
      </div>`;
    })
    .join('');
}

/* ---------- Chart (hand-drawn SVG) ---------- */

const SVG_NS = 'http://www.w3.org/2000/svg';

function drawChart() {
  const wrap = document.getElementById('chart-wrap');
  if (!wrap || !state.timeseries || state.timeseries.length === 0) return;

  const W = wrap.clientWidth || 600;
  const H = wrap.clientHeight || 280;
  if (W === 0 || H === 0) return;

  const data = state.timeseries;
  const padL = 48;
  const padR = 14;
  const padT = 14;
  const padB = 28;
  const plotW = Math.max(1, W - padL - padR);
  const plotH = Math.max(1, H - padT - padB);

  const values = data.map((d) => d.visitors);
  let minV = Math.min(...values);
  let maxV = Math.max(...values);
  if (minV === maxV) { minV -= 1; maxV += 1; }
  // pad range slightly
  const range = maxV - minV;
  minV = Math.max(0, minV - range * 0.1);
  maxV = maxV + range * 0.1;

  const x = (i) => padL + (data.length === 1 ? plotW / 2 : (i / (data.length - 1)) * plotW);
  const y = (v) => padT + plotH - ((v - minV) / (maxV - minV)) * plotH;

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', '30 day visitors time series');

  // Y gridlines + labels
  const yTicks = 4;
  for (let t = 0; t <= yTicks; t++) {
    const v = minV + ((maxV - minV) * t) / yTicks;
    const yy = y(v);
    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('x1', padL);
    line.setAttribute('x2', padL + plotW);
    line.setAttribute('y1', yy);
    line.setAttribute('y2', yy);
    line.setAttribute('class', 'chart-grid-line');
    svg.appendChild(line);

    const label = document.createElementNS(SVG_NS, 'text');
    label.setAttribute('x', padL - 8);
    label.setAttribute('y', yy + 4);
    label.setAttribute('text-anchor', 'end');
    label.setAttribute('class', 'chart-axis-label');
    label.textContent = compact(v);
    svg.appendChild(label);
  }

  // X axis labels (a handful of ticks to avoid crowding)
  const xTickCount = Math.min(6, data.length);
  for (let t = 0; t < xTickCount; t++) {
    const idx = Math.round((t / (xTickCount - 1)) * (data.length - 1));
    const xx = x(idx);
    const label = document.createElementNS(SVG_NS, 'text');
    label.setAttribute('x', xx);
    label.setAttribute('y', H - 8);
    let anchor = 'middle';
    if (t === 0) anchor = 'start';
    if (t === xTickCount - 1) anchor = 'end';
    label.setAttribute('text-anchor', anchor);
    label.setAttribute('class', 'chart-axis-label');
    label.textContent = fmtDateShort(data[idx].date);
    svg.appendChild(label);
  }

  // Axis lines
  const axisX = document.createElementNS(SVG_NS, 'line');
  axisX.setAttribute('x1', padL);
  axisX.setAttribute('x2', padL + plotW);
  axisX.setAttribute('y1', padT + plotH);
  axisX.setAttribute('y2', padT + plotH);
  axisX.setAttribute('class', 'chart-axis-line');
  svg.appendChild(axisX);

  const axisY = document.createElementNS(SVG_NS, 'line');
  axisY.setAttribute('x1', padL);
  axisY.setAttribute('x2', padL);
  axisY.setAttribute('y1', padT);
  axisY.setAttribute('y2', padT + plotH);
  axisY.setAttribute('class', 'chart-axis-line');
  svg.appendChild(axisY);

  // Build path
  let d = '';
  data.forEach((pt, i) => {
    d += (i === 0 ? 'M' : 'L') + x(i).toFixed(2) + ',' + y(pt.visitors).toFixed(2) + ' ';
  });

  // Area fill
  const fillPath = document.createElementNS(SVG_NS, 'path');
  const areaD = d + `L${x(data.length - 1).toFixed(2)},${(padT + plotH).toFixed(2)} L${x(0).toFixed(2)},${(padT + plotH).toFixed(2)} Z`;
  fillPath.setAttribute('d', areaD);
  fillPath.setAttribute('class', 'chart-series-fill');
  svg.appendChild(fillPath);

  // Line
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', d.trim());
  path.setAttribute('class', 'chart-series-path');
  svg.appendChild(path);

  wrap.innerHTML = '';
  wrap.appendChild(svg);
}

function compact(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return Math.round(n).toString();
}

/* ---------- Theme toggle ---------- */

const toggle = document.getElementById('theme-toggle');
toggle.addEventListener('click', async () => {
  const next = state.theme === 'dark' ? 'light' : 'dark';
  state.theme = next;
  document.documentElement.setAttribute('data-theme', next);
  drawChart(); // recolor chart immediately (relies on CSS vars, but re-draw is safe)
  try {
    await fetch(API + '/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: next })
    });
  } catch (e) {
    console.error('failed to persist theme', e);
  }
});

/* ---------- Resize handling ---------- */

let resizeRaf = null;
window.addEventListener('resize', () => {
  if (resizeRaf) cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(drawChart);
});

let chartObserver = null;
function observeChart() {
  if (!window.ResizeObserver) return;
  const wrap = document.getElementById('chart-wrap');
  if (!wrap) return;
  if (!chartObserver) {
    chartObserver = new ResizeObserver(() => drawChart());
  } else {
    chartObserver.disconnect();
  }
  chartObserver.observe(wrap);
}

/* ---------- Utils ---------- */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

loadAll();
