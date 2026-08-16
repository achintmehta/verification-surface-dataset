const SVG_NS = 'http://www.w3.org/2000/svg';

function el(name, attrs = {}, text) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) {
    node.setAttribute(k, String(v));
  }
  if (text != null) node.textContent = text;
  return node;
}

function niceMax(value) {
  if (value <= 0) return 10;
  const pow = Math.pow(10, Math.floor(Math.log10(value)));
  const n = value / pow;
  let step;
  if (n <= 1) step = 1;
  else if (n <= 2) step = 2;
  else if (n <= 5) step = 5;
  else step = 10;
  return step * pow;
}

function fmtShort(n) {
  if (n >= 1000) return Math.round(n / 100) / 10 + 'k';
  return String(n);
}

/**
 * Renders a responsive time-series line chart into `host`.
 * Returns an object with `update(data)` and `destroy()`.
 * The chart redraws on container resize via ResizeObserver.
 */
export function createChart(host) {
  let data = [];

  function read(varName, fallback) {
    const v = getComputedStyle(host).getPropertyValue(varName).trim();
    return v || fallback;
  }

  function draw() {
    const w = host.clientWidth || 600;
    const h = host.clientHeight || 260;
    host.replaceChildren();
    if (!w || !h) return;

    const svg = el('svg', {
      viewBox: `0 0 ${w} ${h}`,
      preserveAspectRatio: 'none',
      role: 'img',
      'aria-label': 'Visitors over the last 30 days',
    });

    if (!data.length) {
      svg.appendChild(
        el(
          'text',
          {
            x: w / 2,
            y: h / 2,
            fill: read('--chart-label', '#888'),
            'font-size': 13,
            'text-anchor': 'middle',
          },
          'No data'
        )
      );
      host.appendChild(svg);
      return;
    }

    const axisColor = read('--chart-axis', '#999');
    const gridColor = read('--chart-grid', '#eee');
    const lineColor = read('--chart-line', '#2563eb');
    const fillColor = read('--chart-fill', 'rgba(37,99,235,0.12)');
    const labelColor = read('--chart-label', '#666');

    // Margins leave room for axis labels.
    const m = { top: 12, right: 14, bottom: 26, left: 44 };
    const plotW = Math.max(1, w - m.left - m.right);
    const plotH = Math.max(1, h - m.top - m.bottom);

    const values = data.map((d) => d.visitors);
    const maxV = niceMax(Math.max(...values));
    const minV = 0;

    const x = (i) =>
      m.left + (data.length === 1 ? plotW / 2 : (i / (data.length - 1)) * plotW);
    const y = (v) => m.top + plotH - ((v - minV) / (maxV - minV)) * plotH;

    // --- Y gridlines + labels ---
    const ticks = 4;
    for (let t = 0; t <= ticks; t++) {
      const v = minV + ((maxV - minV) * t) / ticks;
      const yy = y(v);
      svg.appendChild(
        el('line', {
          x1: m.left,
          y1: yy,
          x2: m.left + plotW,
          y2: yy,
          stroke: gridColor,
          'stroke-width': 1,
        })
      );
      svg.appendChild(
        el(
          'text',
          {
            x: m.left - 6,
            y: yy + 3.5,
            fill: labelColor,
            'font-size': 10,
            'text-anchor': 'end',
          },
          fmtShort(Math.round(v))
        )
      );
    }

    // --- X axis baseline ---
    svg.appendChild(
      el('line', {
        x1: m.left,
        y1: m.top + plotH,
        x2: m.left + plotW,
        y2: m.top + plotH,
        stroke: axisColor,
        'stroke-width': 1,
      })
    );

    // --- X tick labels (about 5, evenly spaced) ---
    const xTicks = Math.min(5, data.length);
    for (let t = 0; t < xTicks; t++) {
      const idx = Math.round((t / (xTicks - 1 || 1)) * (data.length - 1));
      const d = data[idx];
      const label = d.date.slice(5); // MM-DD
      svg.appendChild(
        el(
          'text',
          {
            x: x(idx),
            y: m.top + plotH + 16,
            fill: labelColor,
            'font-size': 10,
            'text-anchor':
              t === 0 ? 'start' : t === xTicks - 1 ? 'end' : 'middle',
          },
          label
        )
      );
    }

    // --- Area fill ---
    let area = `M ${x(0)} ${y(values[0])}`;
    for (let i = 1; i < data.length; i++) area += ` L ${x(i)} ${y(values[i])}`;
    area += ` L ${x(data.length - 1)} ${m.top + plotH} L ${x(0)} ${
      m.top + plotH
    } Z`;
    svg.appendChild(el('path', { d: area, fill: fillColor, stroke: 'none' }));

    // --- Line ---
    let line = `M ${x(0)} ${y(values[0])}`;
    for (let i = 1; i < data.length; i++) line += ` L ${x(i)} ${y(values[i])}`;
    svg.appendChild(
      el('path', {
        d: line,
        fill: 'none',
        stroke: lineColor,
        'stroke-width': 2,
        'stroke-linejoin': 'round',
        'stroke-linecap': 'round',
      })
    );

    host.appendChild(svg);
  }

  const ro = new ResizeObserver(() => draw());
  ro.observe(host);

  return {
    update(next) {
      data = Array.isArray(next) ? next : [];
      draw();
    },
    redraw: draw,
    destroy() {
      ro.disconnect();
    },
  };
}
