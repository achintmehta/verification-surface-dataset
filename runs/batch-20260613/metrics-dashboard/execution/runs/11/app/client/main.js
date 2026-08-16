// ---------- API layer ----------
async function api(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) throw new Error(`Request to ${path} failed: ${res.status}`);
  return res.json();
}

// ---------- Formatting helpers ----------
const nf = new Intl.NumberFormat('en-US');
const cf = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0
});

function fmtNumber(n) {
  return nf.format(Math.round(n));
}
function fmtCurrency(n) {
  return cf.format(n);
}
function fmtDateShort(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
function fmtDateTime(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

const SVGNS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

// ---------- App state ----------
const state = {
  summary: null,
  timeseries: null,
  categories: null,
  recent: null,
  theme: 'light'
};

// ---------- Stat cards ----------
function renderStatCards() {
  const s = state.summary;
  const cards = [];

  cards.push(
    statCard('Total Visitors', fmtNumber(s.totalVisitors), 'last 30 days')
  );
  cards.push(
    statCard('Total Revenue', fmtCurrency(s.totalRevenue), 'last 30 days')
  );

  const trendUp = s.trendPct >= 0;
  const trendNode = el('span', { class: `trend ${trendUp ? 'trend--up' : 'trend--down'}` }, [
    `${trendUp ? '▲' : '▼'} ${Math.abs(s.trendPct).toFixed(1)}%`
  ]);
  const trendCard = el('div', { class: 'card stat-card' }, [
    el('div', { class: 'stat-label', text: '7-Day Trend' }),
    el('div', { class: 'stat-value' }, [trendNode]),
    el('div', { class: 'stat-sub' }, ['vs previous 7 days'])
  ]);
  cards.push(trendCard);

  const best = s.bestDay;
  cards.push(
    statCard(
      'Best Day',
      best ? fmtCurrency(best.revenue) : '—',
      best ? fmtDateTime(best.date) : ''
    )
  );

  return cards;
}

function statCard(label, value, sub) {
  return el('div', { class: 'card stat-card' }, [
    el('div', { class: 'stat-label', text: label }),
    el('div', { class: 'stat-value', text: value }),
    sub ? el('div', { class: 'stat-sub', text: sub }) : null
  ]);
}

// ---------- Time-series chart (hand-drawn SVG) ----------
function buildChartWidget() {
  const wrap = el('div', { class: 'chart-wrap' });
  const card = el('div', { class: 'card widget widget--chart' }, [
    el('h2', { class: 'card__title', text: 'Revenue — Last 30 Days' }),
    wrap,
    el('div', { class: 'chart-legend' }, [
      el('span', {}, [el('span', { class: 'chart-legend__dot' }), 'Daily revenue'])
    ])
  ]);

  // Redraw on container resize so the chart always fits and stays crisp.
  const ro = new ResizeObserver(() => drawChart(wrap));
  ro.observe(wrap);
  // Initial draw after layout.
  requestAnimationFrame(() => drawChart(wrap));
  return card;
}

function drawChart(wrap) {
  const data = state.timeseries;
  if (!data || !data.length) return;

  const cw = Math.max(220, wrap.clientWidth || 600);
  const height = Math.max(200, Math.min(360, Math.round(cw * 0.45)));
  const width = cw;

  const css = getComputedStyle(document.documentElement);
  const colLine = css.getPropertyValue('--chart-line').trim() || '#3a6df0';
  const colFill = css.getPropertyValue('--chart-fill').trim() || 'rgba(58,109,240,.14)';
  const colGrid = css.getPropertyValue('--chart-grid').trim() || '#e2e6ef';
  const colAxis = css.getPropertyValue('--chart-axis').trim() || '#9aa4b6';
  const colText = css.getPropertyValue('--text-muted').trim() || '#5b6678';

  // Margins reserve room for axis labels so nothing draws outside the area.
  const m = { top: 12, right: 14, bottom: 28, left: 54 };
  const plotW = width - m.left - m.right;
  const plotH = height - m.top - m.bottom;

  const values = data.map((d) => d.revenue);
  const maxV = Math.max(...values);
  const minV = Math.min(...values);
  // Pad the scale a little and base it at 0 for honest bar/line height.
  const yMax = niceCeil(maxV * 1.05);
  const yMin = 0;

  const x = (i) => m.left + (data.length === 1 ? plotW / 2 : (i / (data.length - 1)) * plotW);
  const y = (v) => m.top + plotH - ((v - yMin) / (yMax - yMin || 1)) * plotH;

  const svg = svgEl('svg', {
    class: 'chart-svg',
    viewBox: `0 0 ${width} ${height}`,
    width: width,
    height: height,
    preserveAspectRatio: 'xMidYMid meet',
    role: 'img',
    'aria-label': '30-day revenue line chart'
  });

  // --- Y gridlines + labels ---
  const yTicks = 4;
  for (let t = 0; t <= yTicks; t++) {
    const v = yMin + (t / yTicks) * (yMax - yMin);
    const yy = y(v);
    svg.append(
      svgEl('line', {
        x1: m.left,
        x2: m.left + plotW,
        y1: yy,
        y2: yy,
        stroke: colGrid,
        'stroke-width': 1
      })
    );
    const label = svgEl('text', {
      x: m.left - 8,
      y: yy + 4,
      'text-anchor': 'end',
      'font-size': 11,
      fill: colText
    });
    label.textContent = compactCurrency(v);
    svg.append(label);
  }

  // --- Axes ---
  svg.append(
    svgEl('line', { x1: m.left, y1: m.top, x2: m.left, y2: m.top + plotH, stroke: colAxis, 'stroke-width': 1 })
  );
  svg.append(
    svgEl('line', {
      x1: m.left,
      y1: m.top + plotH,
      x2: m.left + plotW,
      y2: m.top + plotH,
      stroke: colAxis,
      'stroke-width': 1
    })
  );

  // --- X tick labels (a handful, evenly spaced to avoid crowding) ---
  const maxLabels = Math.max(2, Math.min(7, Math.floor(plotW / 70)));
  const step = Math.max(1, Math.round((data.length - 1) / (maxLabels - 1)));
  for (let i = 0; i < data.length; i += step) {
    const label = svgEl('text', {
      x: x(i),
      y: m.top + plotH + 18,
      'text-anchor': 'middle',
      'font-size': 11,
      fill: colText
    });
    label.textContent = fmtDateShort(data[i].date);
    svg.append(label);
  }

  // --- Area fill ---
  let areaD = `M ${x(0)} ${y(values[0])}`;
  for (let i = 1; i < data.length; i++) areaD += ` L ${x(i)} ${y(values[i])}`;
  areaD += ` L ${x(data.length - 1)} ${m.top + plotH} L ${x(0)} ${m.top + plotH} Z`;
  svg.append(svgEl('path', { d: areaD, fill: colFill, stroke: 'none' }));

  // --- Line path ---
  let lineD = `M ${x(0)} ${y(values[0])}`;
  for (let i = 1; i < data.length; i++) lineD += ` L ${x(i)} ${y(values[i])}`;
  svg.append(
    svgEl('path', {
      d: lineD,
      fill: 'none',
      stroke: colLine,
      'stroke-width': 2,
      'stroke-linejoin': 'round',
      'stroke-linecap': 'round'
    })
  );

  // Small endpoint marker.
  svg.append(
    svgEl('circle', {
      cx: x(data.length - 1),
      cy: y(values[values.length - 1]),
      r: 3.5,
      fill: colLine
    })
  );

  wrap.replaceChildren(svg);
}

function niceCeil(n) {
  if (n <= 0) return 10;
  const pow = Math.pow(10, Math.floor(Math.log10(n)));
  const frac = n / pow;
  let nice;
  if (frac <= 1) nice = 1;
  else if (frac <= 2) nice = 2;
  else if (frac <= 5) nice = 5;
  else nice = 10;
  return nice * pow;
}

function compactCurrency(v) {
  if (v >= 1000) return '$' + (v / 1000).toFixed(v >= 10000 ? 0 : 1) + 'k';
  return '$' + Math.round(v);
}

// ---------- Category breakdown ----------
function buildCategoriesWidget() {
  const data = state.categories;
  const max = Math.max(...data.map((c) => c.value), 1);
  const rows = data.map((c) =>
    el('div', { class: 'bar-row' }, [
      el('div', { class: 'bar-row__head' }, [
        el('span', { class: 'bar-row__name', title: c.name, text: c.name }),
        el('span', { class: 'bar-row__value', text: fmtNumber(c.value) })
      ]),
      el('div', { class: 'bar-track' }, [
        el('div', { class: 'bar-fill', style: `width:${Math.max(2, (c.value / max) * 100)}%` })
      ])
    ])
  );
  return el('div', { class: 'card widget widget--categories' }, [
    el('h2', { class: 'card__title', text: 'Traffic by Category' }),
    el('div', { class: 'bar-list' }, rows)
  ]);
}

// ---------- Recent items table ----------
function buildTableWidget() {
  const data = state.recent;
  const head = el('thead', {}, [
    el('tr', {}, [
      el('th', { text: 'Name' }),
      el('th', { class: 'cat-cell', text: 'Category' }),
      el('th', { class: 'num', text: 'Value' }),
      el('th', { text: 'Created' })
    ])
  ]);
  const body = el(
    'tbody',
    {},
    data.map((r) =>
      el('tr', {}, [
        el('td', { text: r.name }),
        el('td', { class: 'cat-cell', title: r.category, text: r.category }),
        el('td', { class: 'num', text: fmtCurrency(r.value) }),
        el('td', { text: fmtDateTime(r.createdAt) })
      ])
    )
  );
  return el('div', { class: 'card widget widget--table' }, [
    el('h2', { class: 'card__title', text: 'Recent Items' }),
    el('div', { class: 'table-scroll' }, [el('table', { class: 'data-table' }, [head, body])])
  ]);
}

// ---------- Render orchestration ----------
function renderDashboard() {
  const root = document.getElementById('dashboard');
  const nodes = [];
  for (const c of renderStatCards()) nodes.push(c);
  nodes.push(buildChartWidget());
  nodes.push(buildCategoriesWidget());
  nodes.push(buildTableWidget());
  root.replaceChildren(...nodes);
}

function renderError(message) {
  const root = document.getElementById('dashboard');
  root.replaceChildren(
    el('div', { class: 'state-msg state-msg--error' }, [
      el('strong', { text: 'Unable to load dashboard data.' }),
      el('div', { text: message || 'The API server may be unavailable. Please retry.' }),
      el(
        'div',
        { style: 'margin-top:0.75rem' },
        [el('button', { class: 'theme-toggle', type: 'button', onclick: () => boot() }, ['Retry'])]
      )
    ])
  );
}

// ---------- Theme ----------
function applyTheme(theme) {
  state.theme = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', state.theme);
  const label = document.querySelector('.theme-toggle__label');
  if (label) label.textContent = state.theme === 'dark' ? 'Light' : 'Dark';
  // Redraw chart with theme-aware colors.
  const wrap = document.querySelector('.chart-wrap');
  if (wrap) drawChart(wrap);
}

async function toggleTheme() {
  const next = state.theme === 'dark' ? 'light' : 'dark';
  applyTheme(next); // optimistic
  try {
    const saved = await api('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: next })
    });
    applyTheme(saved.theme);
  } catch (e) {
    // Revert if persistence failed.
    applyTheme(next === 'dark' ? 'light' : 'dark');
    console.error('Failed to persist theme', e);
  }
}

document.getElementById('theme-toggle').addEventListener('click', toggleTheme);

// ---------- Boot ----------
async function boot() {
  const root = document.getElementById('dashboard');
  root.replaceChildren(el('div', { class: 'state-msg', text: 'Loading dashboard…' }));
  try {
    // Apply persisted theme before painting the data.
    const settings = await api('/api/settings');
    applyTheme(settings.theme);

    const [summary, timeseries, categories, recent] = await Promise.all([
      api('/api/summary'),
      api('/api/timeseries'),
      api('/api/categories'),
      api('/api/recent')
    ]);
    state.summary = summary;
    state.timeseries = timeseries;
    state.categories = categories;
    state.recent = recent;
    renderDashboard();
    // Ensure chart reflects current theme after (re)render.
    const wrap = document.querySelector('.chart-wrap');
    if (wrap) requestAnimationFrame(() => drawChart(wrap));
  } catch (e) {
    renderError(String(e.message || e));
  }
}

// Redraw chart on window resize as a fallback to ResizeObserver.
let resizeRaf;
window.addEventListener('resize', () => {
  cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(() => {
    const wrap = document.querySelector('.chart-wrap');
    if (wrap) drawChart(wrap);
  });
});

boot();
