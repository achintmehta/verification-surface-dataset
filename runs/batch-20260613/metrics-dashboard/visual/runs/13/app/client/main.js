const SVG_NS = 'http://www.w3.org/2000/svg';

const fmtInt = (n) => new Intl.NumberFormat('en-US').format(Math.round(n));
const fmtMoney = (n) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
const fmtCompact = (n) =>
  new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);

const state = { timeseries: [] };

async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

/* ---------------- Summary cards ---------------- */
function renderSummary(summary) {
  const el = document.getElementById('stat-cards');
  const trendPos = summary.trendPct >= 0;
  const bestDate = summary.bestDay
    ? new Date(summary.bestDay.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : '—';
  const cards = [
    {
      label: 'Total Visitors',
      value: fmtInt(summary.totalVisitors),
      sub: 'Across last 30 days'
    },
    {
      label: 'Total Revenue',
      value: fmtMoney(summary.totalRevenue),
      sub: 'Across last 30 days'
    },
    {
      label: 'Best Day',
      value: summary.bestDay ? fmtMoney(summary.bestDay.revenue) : '—',
      sub: `on ${bestDate}`
    },
    {
      label: '7-Day Trend',
      value: `${trendPos ? '+' : ''}${summary.trendPct.toFixed(1)}%`,
      trend: { pos: trendPos, text: trendPos ? 'vs prior 7 days' : 'vs prior 7 days' }
    }
  ];
  el.innerHTML = cards
    .map((c) => {
      const sub = c.trend
        ? `<div class="stat-card__sub"><span class="trend ${c.trend.pos ? 'pos' : 'neg'}">${
            c.trend.pos ? '▲' : '▼'
          }</span> ${c.trend.text}</div>`
        : `<div class="stat-card__sub">${c.sub}</div>`;
      return `<article class="stat-card">
        <p class="stat-card__label">${c.label}</p>
        <div class="stat-card__value">${c.value}</div>
        ${sub}
      </article>`;
    })
    .join('');
}

/* ---------------- Chart (hand-drawn SVG) ---------------- */
function renderChart() {
  const svg = document.getElementById('chart');
  const wrap = document.getElementById('chart-wrap');
  const data = state.timeseries;
  if (!svg || !wrap || data.length === 0) return;

  // Use the wrapper's actual pixel size so the chart fits its container.
  const W = Math.max(1, Math.round(wrap.clientWidth));
  const H = Math.max(1, Math.round(wrap.clientHeight));

  // viewBox in CSS pixels keeps everything crisp & non-overflowing.
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  while (svg.firstChild) svg.removeChild(svg.firstChild);

  const css = getComputedStyle(document.documentElement);
  const cGrid = css.getPropertyValue('--chart-grid').trim();
  const cAxis = css.getPropertyValue('--chart-axis').trim();
  const cLine = css.getPropertyValue('--chart-line').trim();
  const cFill = css.getPropertyValue('--chart-fill').trim();

  // Margins: leave room for axis labels. Tighter on small widths.
  const compact = W < 460;
  const m = {
    top: 12,
    right: 12,
    bottom: 26,
    left: compact ? 40 : 52
  };
  const plotW = Math.max(1, W - m.left - m.right);
  const plotH = Math.max(1, H - m.top - m.bottom);

  const values = data.map((d) => d.visitors);
  const maxV = Math.max(...values);
  const minV = Math.min(...values);
  // pad the range
  const yMax = Math.ceil(maxV / 100) * 100;
  const yMin = Math.max(0, Math.floor(minV / 100) * 100 - 100);
  const yRange = yMax - yMin || 1;

  const x = (i) => m.left + (data.length === 1 ? plotW / 2 : (i / (data.length - 1)) * plotW);
  const y = (v) => m.top + plotH - ((v - yMin) / yRange) * plotH;

  const frag = document.createDocumentFragment();
  const add = (tag, attrs, text) => {
    const node = document.createElementNS(SVG_NS, tag);
    for (const k in attrs) node.setAttribute(k, attrs[k]);
    if (text != null) node.textContent = text;
    frag.appendChild(node);
    return node;
  };

  // Y gridlines + labels (4 ticks)
  const yTicks = 4;
  for (let t = 0; t <= yTicks; t++) {
    const val = yMin + (yRange * t) / yTicks;
    const gy = y(val);
    add('line', {
      x1: m.left, y1: gy, x2: m.left + plotW, y2: gy,
      stroke: cGrid, 'stroke-width': 1
    });
    add('text', {
      x: m.left - 8, y: gy + 4,
      'text-anchor': 'end', 'font-size': 11, fill: cAxis
    }, fmtCompact(val));
  }

  // X axis baseline
  add('line', {
    x1: m.left, y1: m.top + plotH, x2: m.left + plotW, y2: m.top + plotH,
    stroke: cAxis, 'stroke-width': 1
  });

  // X tick labels (first, ~middle, last) to avoid crowding
  const xTickIdx = [0, Math.floor((data.length - 1) / 2), data.length - 1];
  const seen = new Set();
  for (const i of xTickIdx) {
    if (seen.has(i)) continue;
    seen.add(i);
    const label = new Date(data[i].date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    let anchor = 'middle';
    if (i === 0) anchor = 'start';
    if (i === data.length - 1) anchor = 'end';
    add('text', {
      x: x(i), y: m.top + plotH + 18,
      'text-anchor': anchor, 'font-size': 11, fill: cAxis
    }, label);
  }

  // Area fill
  let areaD = `M ${x(0)} ${y(values[0])}`;
  for (let i = 1; i < data.length; i++) areaD += ` L ${x(i)} ${y(values[i])}`;
  areaD += ` L ${x(data.length - 1)} ${m.top + plotH} L ${x(0)} ${m.top + plotH} Z`;
  add('path', { d: areaD, fill: cFill, stroke: 'none' });

  // Line
  let lineD = `M ${x(0)} ${y(values[0])}`;
  for (let i = 1; i < data.length; i++) lineD += ` L ${x(i)} ${y(values[i])}`;
  add('path', {
    d: lineD, fill: 'none', stroke: cLine,
    'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round'
  });

  svg.appendChild(frag);
}

/* ---------------- Category breakdown ---------------- */
function renderCategories(cats) {
  const el = document.getElementById('breakdown');
  if (!cats.length) {
    el.innerHTML = '<p class="skeleton">No categories.</p>';
    return;
  }
  const max = Math.max(...cats.map((c) => c.value));
  el.innerHTML = cats
    .map((c) => {
      const pct = max > 0 ? (c.value / max) * 100 : 0;
      return `<div class="bar-row">
        <div class="bar-row__head">
          <span class="bar-row__name" title="${escapeHtml(c.name)}">${escapeHtml(c.name)}</span>
          <span class="bar-row__value">${fmtInt(c.value)}</span>
        </div>
        <div class="bar-row__track">
          <div class="bar-row__fill" style="width:${pct.toFixed(1)}%"></div>
        </div>
      </div>`;
    })
    .join('');
}

/* ---------------- Recent table ---------------- */
function renderRecent(items) {
  const body = document.getElementById('recent-body');
  if (!items.length) {
    body.innerHTML = '<tr><td colspan="4" class="skeleton">No recent items.</td></tr>';
    return;
  }
  body.innerHTML = items
    .map((it) => {
      const date = new Date(it.createdAt).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric'
      });
      return `<tr>
        <td>${escapeHtml(it.name)}</td>
        <td><span class="cat-pill" title="${escapeHtml(it.category)}">${escapeHtml(it.category)}</span></td>
        <td class="num">${fmtMoney(it.value)}</td>
        <td>${date}</td>
      </tr>`;
    })
    .join('');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

/* ---------------- Theme ---------------- */
async function applyTheme(theme, persist) {
  document.documentElement.setAttribute('data-theme', theme);
  renderChart(); // recolor chart internals
  if (persist) {
    try {
      await fetchJSON('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ theme })
      });
    } catch (e) {
      console.error('Failed to persist theme', e);
    }
  }
}

function setupThemeToggle() {
  const btn = document.getElementById('theme-toggle');
  btn.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme') || 'light';
    applyTheme(current === 'light' ? 'dark' : 'light', true);
  });
}

/* ---------------- Errors ---------------- */
function showError(show) {
  document.getElementById('global-error').hidden = !show;
}

/* ---------------- Boot ---------------- */
async function loadDashboard() {
  showError(false);
  try {
    const [summary, timeseries, categories, recent, settings] = await Promise.all([
      fetchJSON('/api/summary'),
      fetchJSON('/api/timeseries'),
      fetchJSON('/api/categories'),
      fetchJSON('/api/recent'),
      fetchJSON('/api/settings')
    ]);
    state.timeseries = timeseries;
    document.documentElement.setAttribute('data-theme', settings.theme || 'light');

    renderSummary(summary);
    renderCategories(categories);
    renderRecent(recent);
    renderChart();
  } catch (e) {
    console.error(e);
    showError(true);
  }
}

function setupResize() {
  let raf = null;
  const ro = new ResizeObserver(() => {
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => renderChart());
  });
  ro.observe(document.getElementById('chart-wrap'));
  window.addEventListener('resize', () => renderChart());
}

document.getElementById('retry-btn').addEventListener('click', loadDashboard);
setupThemeToggle();
setupResize();
loadDashboard();
