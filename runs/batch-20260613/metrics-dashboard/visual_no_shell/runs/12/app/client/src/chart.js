// Hand-drawn responsive line chart (SVG). No external libraries.
// Draws axes, gridlines, labeled ticks and a 30-day series; redraws on resize.

const NS = 'http://www.w3.org/2000/svg';

function el(name, attrs = {}, text) {
  const e = document.createElementNS(NS, name);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (text !== undefined) e.textContent = text;
  return e;
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function fmtShort(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(Math.round(n));
}

export function createChart(container, data) {
  let series = data || [];

  function render() {
    const width = Math.max(280, container.clientWidth || 320);
    // Aspect ratio responsive: shorter on narrow screens.
    const height = width < 480 ? 200 : width < 760 ? 240 : 280;

    container.innerHTML = '';
    if (!series.length) return;

    const padL = 48;
    const padR = 14;
    const padT = 12;
    const padB = 30;
    const plotW = width - padL - padR;
    const plotH = height - padT - padB;

    const values = series.map((d) => d.revenue);
    const maxV = Math.max(...values);
    const minV = Math.min(...values);
    // Nice rounding for axis.
    const top = niceCeil(maxV);
    const bottom = 0;
    const range = top - bottom || 1;

    const n = series.length;
    const x = (i) => padL + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
    const y = (v) => padT + plotH - ((v - bottom) / range) * plotH;

    const svg = el('svg', {
      viewBox: `0 0 ${width} ${height}`,
      width: '100%',
      height: String(height),
      role: 'img',
      'aria-label': '30-day revenue time series',
      preserveAspectRatio: 'xMidYMid meet',
    });

    const axisColor = cssVar('--chart-axis');
    const gridColor = cssVar('--chart-grid');
    const lineColor = cssVar('--chart-line');
    const fillColor = cssVar('--chart-fill');
    const labelColor = cssVar('--text-muted');

    // Horizontal gridlines + y labels
    const yTicks = 4;
    for (let t = 0; t <= yTicks; t++) {
      const val = bottom + (range * t) / yTicks;
      const yy = y(val);
      svg.appendChild(
        el('line', {
          x1: padL, y1: yy, x2: width - padR, y2: yy,
          stroke: gridColor, 'stroke-width': 1,
        })
      );
      svg.appendChild(
        el(
          'text',
          {
            x: padL - 8, y: yy + 3.5, 'text-anchor': 'end',
            'font-size': 10, fill: labelColor,
          },
          fmtShort(val)
        )
      );
    }

    // X axis baseline
    svg.appendChild(
      el('line', {
        x1: padL, y1: padT + plotH, x2: width - padR, y2: padT + plotH,
        stroke: axisColor, 'stroke-width': 1.5,
      })
    );
    // Y axis
    svg.appendChild(
      el('line', {
        x1: padL, y1: padT, x2: padL, y2: padT + plotH,
        stroke: axisColor, 'stroke-width': 1.5,
      })
    );

    // X tick labels: pick a few to avoid overlap based on width.
    const maxLabels = width < 480 ? 4 : width < 760 ? 6 : 8;
    const step = Math.max(1, Math.ceil(n / maxLabels));
    for (let i = 0; i < n; i += step) {
      const d = series[i];
      const xx = x(i);
      svg.appendChild(
        el('line', {
          x1: xx, y1: padT + plotH, x2: xx, y2: padT + plotH + 4,
          stroke: axisColor, 'stroke-width': 1,
        })
      );
      svg.appendChild(
        el(
          'text',
          {
            x: xx, y: padT + plotH + 16, 'text-anchor': 'middle',
            'font-size': 10, fill: labelColor,
          },
          d.date.slice(5) // MM-DD
        )
      );
    }

    // Area fill
    let areaPath = `M ${x(0)} ${y(values[0])}`;
    for (let i = 1; i < n; i++) areaPath += ` L ${x(i)} ${y(values[i])}`;
    areaPath += ` L ${x(n - 1)} ${padT + plotH} L ${x(0)} ${padT + plotH} Z`;
    svg.appendChild(el('path', { d: areaPath, fill: fillColor, stroke: 'none' }));

    // Line
    let linePath = `M ${x(0)} ${y(values[0])}`;
    for (let i = 1; i < n; i++) linePath += ` L ${x(i)} ${y(values[i])}`;
    svg.appendChild(
      el('path', {
        d: linePath, fill: 'none', stroke: lineColor,
        'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
      })
    );

    // Last point marker
    svg.appendChild(
      el('circle', { cx: x(n - 1), cy: y(values[n - 1]), r: 3.5, fill: lineColor })
    );

    container.appendChild(svg);
  }

  function niceCeil(v) {
    if (v <= 0) return 1;
    const mag = Math.pow(10, Math.floor(Math.log10(v)));
    const norm = v / mag;
    let nice;
    if (norm <= 1) nice = 1;
    else if (norm <= 2) nice = 2;
    else if (norm <= 2.5) nice = 2.5;
    else if (norm <= 5) nice = 5;
    else nice = 10;
    return nice * mag;
  }

  // Redraw on container resize.
  const ro = new ResizeObserver(() => render());
  ro.observe(container);
  // Also on window resize as a fallback.
  window.addEventListener('resize', render);

  render();

  return {
    update(newData) {
      series = newData || [];
      render();
    },
    redraw: render,
    destroy() {
      ro.disconnect();
      window.removeEventListener('resize', render);
    },
  };
}
