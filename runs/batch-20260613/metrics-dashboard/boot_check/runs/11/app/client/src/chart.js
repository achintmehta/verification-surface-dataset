const SVG_NS = 'http://www.w3.org/2000/svg';

function el(name, attrs = {}, text) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  if (text != null) node.textContent = text;
  return node;
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

function formatTick(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1) + 'k';
  return String(n);
}

/**
 * A self-contained, resize-aware line chart drawn directly as SVG.
 * Reads CSS variables for colors so it follows the active theme.
 */
export class LineChart {
  constructor(svg, container) {
    this.svg = svg;
    this.container = container;
    this.series = [];
    this._ro = new ResizeObserver(() => this.draw());
    this._ro.observe(container);
    window.addEventListener('resize', () => this.draw());
  }

  setData(series) {
    // series: [{ day: 'YYYY-MM-DD', visitors: number }]
    this.series = Array.isArray(series) ? series : [];
    this.draw();
  }

  _color(name, fallback) {
    const v = getComputedStyle(this.svg).getPropertyValue(name).trim();
    return v || fallback;
  }

  draw() {
    const svg = this.svg;
    // Clear
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    const rect = this.container.getBoundingClientRect();
    const W = Math.max(120, Math.floor(rect.width));
    const H = Math.max(120, Math.floor(rect.height));
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('width', W);
    svg.setAttribute('height', H);

    const data = this.series;
    if (!data.length) return;

    const cGrid = this._color('--chart-grid', '#e6eaf2');
    const cAxis = this._color('--chart-axis', '#93a0b3');
    const cLine = this._color('--chart-line', '#2563eb');
    const cArea = this._color('--chart-area', 'rgba(37,99,235,0.12)');
    const cLabel = this._color('--chart-label', '#5b6675');

    // Margins: leave room for y labels (left) and x labels (bottom).
    const m = { top: 12, right: 14, bottom: 26, left: 44 };
    const plotW = Math.max(10, W - m.left - m.right);
    const plotH = Math.max(10, H - m.top - m.bottom);

    const maxV = niceCeil(Math.max(...data.map((d) => d.visitors)));
    const minV = 0;

    const xFor = (i) =>
      m.left + (data.length === 1 ? plotW / 2 : (i / (data.length - 1)) * plotW);
    const yFor = (v) => m.top + plotH - ((v - minV) / (maxV - minV)) * plotH;

    // --- gridlines + y ticks ---
    const yTicks = 4;
    for (let t = 0; t <= yTicks; t++) {
      const val = (maxV / yTicks) * t;
      const y = yFor(val);
      svg.appendChild(
        el('line', { x1: m.left, y1: y, x2: m.left + plotW, y2: y, stroke: cGrid, 'stroke-width': 1 })
      );
      svg.appendChild(
        el(
          'text',
          {
            x: m.left - 8,
            y: y + 4,
            'text-anchor': 'end',
            'font-size': 11,
            fill: cLabel,
          },
          formatTick(val)
        )
      );
    }

    // --- x axis baseline ---
    svg.appendChild(
      el('line', {
        x1: m.left,
        y1: m.top + plotH,
        x2: m.left + plotW,
        y2: m.top + plotH,
        stroke: cAxis,
        'stroke-width': 1,
      })
    );

    // --- x ticks: show ~5 dates, never crowd ---
    const tickEvery = Math.max(1, Math.round(data.length / 5));
    for (let i = 0; i < data.length; i += tickEvery) {
      const x = xFor(i);
      const label = data[i].day.slice(5); // MM-DD
      svg.appendChild(
        el(
          'text',
          { x, y: m.top + plotH + 16, 'text-anchor': 'middle', 'font-size': 10, fill: cLabel },
          label
        )
      );
    }

    // --- area + line path ---
    let areaD = `M ${xFor(0)} ${m.top + plotH}`;
    let lineD = '';
    data.forEach((d, i) => {
      const x = xFor(i);
      const y = yFor(d.visitors);
      areaD += ` L ${x} ${y}`;
      lineD += (i === 0 ? 'M' : ' L') + ` ${x} ${y}`;
    });
    areaD += ` L ${xFor(data.length - 1)} ${m.top + plotH} Z`;

    svg.appendChild(el('path', { d: areaD, fill: cArea, stroke: 'none' }));
    svg.appendChild(
      el('path', {
        d: lineD,
        fill: 'none',
        stroke: cLine,
        'stroke-width': 2,
        'stroke-linejoin': 'round',
        'stroke-linecap': 'round',
      })
    );
  }
}
