const SVG_NS = 'http://www.w3.org/2000/svg';

function el(name, attrs = {}, text) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  if (text != null) node.textContent = text;
  return node;
}

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function niceCeil(value) {
  if (value <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(value)));
  const norm = value / mag;
  let nice;
  if (norm <= 1) nice = 1;
  else if (norm <= 2) nice = 2;
  else if (norm <= 5) nice = 5;
  else nice = 10;
  return nice * mag;
}

/**
 * LineChart draws a 30-day visitors time-series as SVG.
 * It observes its container and re-renders to fit on resize.
 */
export class LineChart {
  constructor(host) {
    this.host = host;
    this.data = [];
    this._ro = new ResizeObserver(() => this.render());
    this._ro.observe(this.host);
    window.addEventListener('resize', this._onWin = () => this.render());
  }

  setData(data) {
    this.data = Array.isArray(data) ? data : [];
    this.render();
  }

  destroy() {
    this._ro.disconnect();
    window.removeEventListener('resize', this._onWin);
  }

  render() {
    const host = this.host;
    const width = Math.max(0, host.clientWidth);
    const height = Math.max(0, host.clientHeight);
    host.innerHTML = '';
    if (!width || !height || this.data.length === 0) return;

    const gridColor = cssVar('--chart-grid', '#e2e7f0');
    const axisColor = cssVar('--chart-axis', '#8a93a6');
    const axisText = cssVar('--chart-axis-text', '#5b6478');
    const lineColor = cssVar('--chart-line', '#2563eb');
    const fillColor = cssVar('--chart-fill', 'rgba(37,99,235,0.12)');

    const svg = el('svg', {
      viewBox: `0 0 ${width} ${height}`,
      preserveAspectRatio: 'none',
      width: '100%',
      height: '100%',
      role: 'img',
      'aria-label': 'Visitors over the last 30 days',
    });

    // Margins reserve room for axis labels so nothing draws outside.
    const m = { top: 14, right: 16, bottom: 26, left: 46 };
    const plotW = Math.max(1, width - m.left - m.right);
    const plotH = Math.max(1, height - m.top - m.bottom);

    const values = this.data.map((d) => Number(d.visitors));
    const maxVal = niceCeil(Math.max(...values, 1));
    const n = this.data.length;

    const x = (i) => m.left + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
    const y = (v) => m.top + plotH - (v / maxVal) * plotH;

    // ---- Y gridlines + labels ----
    const yTicks = 4;
    for (let t = 0; t <= yTicks; t++) {
      const v = (maxVal / yTicks) * t;
      const yy = y(v);
      svg.appendChild(el('line', {
        x1: m.left, y1: yy, x2: m.left + plotW, y2: yy,
        stroke: gridColor, 'stroke-width': 1,
      }));
      svg.appendChild(el('text', {
        x: m.left - 8, y: yy + 3.5,
        'text-anchor': 'end', 'font-size': 10, fill: axisText,
      }, formatTick(v)));
    }

    // ---- X axis line ----
    svg.appendChild(el('line', {
      x1: m.left, y1: m.top + plotH, x2: m.left + plotW, y2: m.top + plotH,
      stroke: axisColor, 'stroke-width': 1,
    }));

    // ---- X tick labels (about 5 evenly spaced) ----
    const xTickCount = Math.min(5, n);
    for (let t = 0; t < xTickCount; t++) {
      const idx = Math.round((t / (xTickCount - 1 || 1)) * (n - 1));
      const d = this.data[idx];
      const label = formatDate(d.day);
      const anchor = t === 0 ? 'start' : t === xTickCount - 1 ? 'end' : 'middle';
      svg.appendChild(el('text', {
        x: x(idx), y: m.top + plotH + 16,
        'text-anchor': anchor, 'font-size': 10, fill: axisText,
      }, label));
    }

    // ---- Area fill ----
    let areaPath = `M ${x(0)} ${y(values[0])}`;
    for (let i = 1; i < n; i++) areaPath += ` L ${x(i)} ${y(values[i])}`;
    areaPath += ` L ${x(n - 1)} ${m.top + plotH} L ${x(0)} ${m.top + plotH} Z`;
    svg.appendChild(el('path', { d: areaPath, fill: fillColor, stroke: 'none' }));

    // ---- Line ----
    let linePath = `M ${x(0)} ${y(values[0])}`;
    for (let i = 1; i < n; i++) linePath += ` L ${x(i)} ${y(values[i])}`;
    svg.appendChild(el('path', {
      d: linePath, fill: 'none', stroke: lineColor,
      'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
    }));

    host.appendChild(svg);
  }
}

function formatTick(v) {
  if (v >= 1000) return (v / 1000).toFixed(v % 1000 === 0 ? 0 : 1) + 'k';
  return String(Math.round(v));
}

function formatDate(iso) {
  // iso like 2024-05-30
  const [, mm, dd] = iso.split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[parseInt(mm, 10) - 1]} ${parseInt(dd, 10)}`;
}
