const SVG_NS = 'http://www.w3.org/2000/svg';

function el(name, attrs = {}, text) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  if (text != null) node.textContent = text;
  return node;
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function niceMax(value) {
  if (value <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(value)));
  const n = value / pow;
  let nice;
  if (n <= 1) nice = 1;
  else if (n <= 2) nice = 2;
  else if (n <= 5) nice = 5;
  else nice = 10;
  return nice * pow;
}

function formatTick(v) {
  if (v >= 1000) return (v / 1000).toFixed(v % 1000 === 0 ? 0 : 1) + 'k';
  return String(v);
}

/**
 * Renders a responsive line chart of `series` (array of {date, visitors}) into
 * the given host element. Re-renders on container resize via ResizeObserver.
 */
export function createLineChart(host, series) {
  let data = series || [];
  let ro = null;

  function draw() {
    const rect = host.getBoundingClientRect();
    const width = Math.max(240, Math.floor(rect.width));
    const height = Math.max(180, Math.floor(rect.height));

    host.innerHTML = '';
    const svg = el('svg', {
      viewBox: `0 0 ${width} ${height}`,
      preserveAspectRatio: 'none',
      role: 'img',
      'aria-label': 'Visitors over the last 30 days',
    });

    if (!data.length) {
      svg.appendChild(
        el('text', { x: width / 2, y: height / 2, 'text-anchor': 'middle', fill: cssVar('--text-muted'), 'font-size': 13 }, 'No data')
      );
      host.appendChild(svg);
      return;
    }

    const gridColor = cssVar('--chart-grid');
    const axisColor = cssVar('--chart-axis');
    const seriesColor = cssVar('--chart-series');
    const fillColor = cssVar('--chart-fill');

    // Margins big enough for labels at all widths.
    const m = { top: 12, right: 14, bottom: 26, left: 44 };
    const plotW = width - m.left - m.right;
    const plotH = height - m.top - m.bottom;

    const maxV = niceMax(Math.max(...data.map((d) => d.visitors)));
    const n = data.length;

    const x = (i) => m.left + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
    const y = (v) => m.top + plotH - (v / maxV) * plotH;

    // ---- Y gridlines + labels ----
    const yTicks = 4;
    for (let t = 0; t <= yTicks; t++) {
      const val = (maxV / yTicks) * t;
      const yy = y(val);
      svg.appendChild(el('line', { x1: m.left, y1: yy, x2: m.left + plotW, y2: yy, stroke: gridColor, 'stroke-width': 1 }));
      svg.appendChild(
        el('text', { x: m.left - 8, y: yy + 4, 'text-anchor': 'end', fill: axisColor, 'font-size': 11 }, formatTick(val))
      );
    }

    // ---- X axis baseline ----
    svg.appendChild(el('line', { x1: m.left, y1: m.top + plotH, x2: m.left + plotW, y2: m.top + plotH, stroke: axisColor, 'stroke-width': 1 }));

    // ---- X labels: choose a small number of evenly spaced ticks ----
    const desiredTicks = Math.max(2, Math.min(6, Math.floor(plotW / 70)));
    const step = Math.max(1, Math.round((n - 1) / (desiredTicks - 1)));
    for (let i = 0; i < n; i += step) {
      const label = data[i].date.slice(5); // MM-DD
      svg.appendChild(
        el('text', { x: x(i), y: m.top + plotH + 16, 'text-anchor': 'middle', fill: axisColor, 'font-size': 11 }, label)
      );
    }
    // Always show last point label.
    if ((n - 1) % step !== 0) {
      svg.appendChild(
        el('text', { x: x(n - 1), y: m.top + plotH + 16, 'text-anchor': 'end', fill: axisColor, 'font-size': 11 }, data[n - 1].date.slice(5))
      );
    }

    // ---- Area fill ----
    let areaPath = `M ${x(0)} ${y(data[0].visitors)}`;
    for (let i = 1; i < n; i++) areaPath += ` L ${x(i)} ${y(data[i].visitors)}`;
    areaPath += ` L ${x(n - 1)} ${m.top + plotH} L ${x(0)} ${m.top + plotH} Z`;
    svg.appendChild(el('path', { d: areaPath, fill: fillColor, stroke: 'none' }));

    // ---- Line ----
    let linePath = `M ${x(0)} ${y(data[0].visitors)}`;
    for (let i = 1; i < n; i++) linePath += ` L ${x(i)} ${y(data[i].visitors)}`;
    svg.appendChild(
      el('path', { d: linePath, fill: 'none', stroke: seriesColor, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' })
    );

    // ---- Endpoint dot ----
    svg.appendChild(el('circle', { cx: x(n - 1), cy: y(data[n - 1].visitors), r: 3.5, fill: seriesColor }));

    host.appendChild(svg);
  }

  function setData(next) {
    data = next || [];
    draw();
  }

  draw();

  // Re-render on container resize.
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => draw());
    ro.observe(host);
  } else {
    window.addEventListener('resize', draw);
  }

  return {
    redraw: draw,
    setData,
    destroy() {
      if (ro) ro.disconnect();
      else window.removeEventListener('resize', draw);
    },
  };
}
