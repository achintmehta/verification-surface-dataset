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

function niceNum(range, round) {
  const exp = Math.floor(Math.log10(range));
  const frac = range / Math.pow(10, exp);
  let nf;
  if (round) {
    if (frac < 1.5) nf = 1;
    else if (frac < 3) nf = 2;
    else if (frac < 7) nf = 5;
    else nf = 10;
  } else {
    if (frac <= 1) nf = 1;
    else if (frac <= 2) nf = 2;
    else if (frac <= 5) nf = 5;
    else nf = 10;
  }
  return nf * Math.pow(10, exp);
}

function formatShort(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(n % 1000 === 0 ? 0 : 1) + 'k';
  return String(n);
}

/**
 * Renders a responsive line chart of the time series into `container`.
 * Returns an object with a `destroy()` method that detaches resize handling.
 */
export function createTimeSeriesChart(container, data) {
  let series = data || [];

  function draw() {
    const rect = container.getBoundingClientRect();
    const width = Math.max(220, Math.floor(rect.width));
    const height = Math.max(180, Math.floor(rect.height));

    // Clear
    while (container.firstChild) container.removeChild(container.firstChild);

    const svg = el('svg', {
      viewBox: `0 0 ${width} ${height}`,
      preserveAspectRatio: 'none',
      role: 'img',
      'aria-label': '30-day visitor trend',
    });

    if (!series.length) {
      svg.appendChild(
        el('text', {
          x: width / 2,
          y: height / 2,
          'text-anchor': 'middle',
          fill: cssVar('--chart-label'),
          'font-size': 13,
        }, 'No data')
      );
      container.appendChild(svg);
      return;
    }

    // Margins (room for axis labels). Tighter on small widths.
    const small = width < 420;
    const m = {
      top: 12,
      right: 12,
      bottom: 26,
      left: small ? 38 : 48,
    };
    const plotW = width - m.left - m.right;
    const plotH = height - m.top - m.bottom;

    const values = series.map((d) => d.visitors);
    const maxV = Math.max(...values);
    const minV = Math.min(...values);

    // y domain padded and "nice"
    const rawMin = Math.min(minV, 0) === 0 ? 0 : minV;
    const niceRange = niceNum(maxV - rawMin || maxV || 1, false);
    const tickSpacing = niceNum(niceRange / 4, true);
    const yMin = Math.floor(rawMin / tickSpacing) * tickSpacing;
    const yMax = Math.ceil(maxV / tickSpacing) * tickSpacing;

    const xFor = (i) =>
      m.left + (series.length === 1 ? plotW / 2 : (i / (series.length - 1)) * plotW);
    const yFor = (v) => m.top + plotH - ((v - yMin) / (yMax - yMin || 1)) * plotH;

    const gridColor = cssVar('--chart-grid');
    const axisColor = cssVar('--chart-axis');
    const labelColor = cssVar('--chart-label');
    const lineColor = cssVar('--chart-line');
    const fillColor = cssVar('--chart-fill');

    // ---- gridlines + y ticks ----
    for (let t = yMin; t <= yMax + 1e-6; t += tickSpacing) {
      const y = yFor(t);
      svg.appendChild(
        el('line', {
          x1: m.left, y1: y, x2: m.left + plotW, y2: y,
          stroke: gridColor, 'stroke-width': 1,
        })
      );
      svg.appendChild(
        el('text', {
          x: m.left - 8, y: y + 4,
          'text-anchor': 'end',
          fill: labelColor,
          'font-size': small ? 9 : 10,
        }, formatShort(Math.round(t)))
      );
    }

    // ---- x axis ticks (every ~5 days, always first & last) ----
    const step = Math.max(1, Math.round(series.length / (small ? 4 : 6)));
    for (let i = 0; i < series.length; i++) {
      const isTick = i % step === 0 || i === series.length - 1;
      if (!isTick) continue;
      const x = xFor(i);
      const label = series[i].day.slice(5); // MM-DD
      svg.appendChild(
        el('text', {
          x, y: m.top + plotH + 18,
          'text-anchor': i === series.length - 1 ? 'end' : i === 0 ? 'start' : 'middle',
          fill: labelColor,
          'font-size': small ? 9 : 10,
        }, label)
      );
    }

    // ---- axes ----
    svg.appendChild(
      el('line', {
        x1: m.left, y1: m.top, x2: m.left, y2: m.top + plotH,
        stroke: axisColor, 'stroke-width': 1,
      })
    );
    svg.appendChild(
      el('line', {
        x1: m.left, y1: m.top + plotH, x2: m.left + plotW, y2: m.top + plotH,
        stroke: axisColor, 'stroke-width': 1,
      })
    );

    // ---- area + line ----
    const linePts = series.map((d, i) => `${xFor(i)},${yFor(d.visitors)}`);
    const areaPath =
      `M ${xFor(0)},${m.top + plotH} ` +
      linePts.map((p) => `L ${p}`).join(' ') +
      ` L ${xFor(series.length - 1)},${m.top + plotH} Z`;

    svg.appendChild(el('path', { d: areaPath, fill: fillColor, stroke: 'none' }));
    svg.appendChild(
      el('polyline', {
        points: linePts.join(' '),
        fill: 'none',
        stroke: lineColor,
        'stroke-width': 2,
        'stroke-linejoin': 'round',
        'stroke-linecap': 'round',
      })
    );

    // endpoint dot
    const lastI = series.length - 1;
    svg.appendChild(
      el('circle', {
        cx: xFor(lastI), cy: yFor(series[lastI].visitors), r: 3,
        fill: lineColor,
      })
    );

    container.appendChild(svg);
  }

  // Redraw on container resize.
  let ro;
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => draw());
    ro.observe(container);
  }
  window.addEventListener('resize', draw);

  draw();

  return {
    update(newData) {
      series = newData || [];
      draw();
    },
    redraw: draw,
    destroy() {
      if (ro) ro.disconnect();
      window.removeEventListener('resize', draw);
    },
  };
}
