const SVG_NS = 'http://www.w3.org/2000/svg';

function el(name, attrs = {}, text) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  if (text != null) node.textContent = text;
  return node;
}

function niceMax(value) {
  if (value <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(value)));
  const norm = value / mag;
  let step;
  if (norm <= 1) step = 1;
  else if (norm <= 2) step = 2;
  else if (norm <= 5) step = 5;
  else step = 10;
  return step * mag;
}

/**
 * Draw a responsive time-series line chart into `container`.
 * Re-renders on container resize via ResizeObserver. Returns a cleanup fn.
 */
export function renderChart(container, series) {
  container.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'chart-wrap';
  container.appendChild(wrap);

  const draw = () => {
    const width = Math.max(220, Math.floor(wrap.clientWidth || container.clientWidth || 320));
    // Maintain a sensible aspect ratio; shorter on narrow screens.
    const height = Math.round(Math.max(180, Math.min(320, width * 0.45)));

    // Margins leave room for axis labels/ticks so nothing is drawn outside.
    const m = { top: 12, right: 14, bottom: 28, left: 48 };
    const plotW = width - m.left - m.right;
    const plotH = height - m.top - m.bottom;

    const values = series.map((d) => d.visitors);
    const maxV = niceMax(Math.max(...values, 1));
    const n = series.length;

    const x = (i) => m.left + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
    const y = (v) => m.top + plotH - (v / maxV) * plotH;

    const svg = el('svg', {
      viewBox: `0 0 ${width} ${height}`,
      width: '100%',
      height,
      preserveAspectRatio: 'xMidYMid meet',
      role: 'img',
      'aria-label': '30-day visitors time series'
    });

    // ---- horizontal gridlines + y ticks ----
    const tickCount = 4;
    for (let t = 0; t <= tickCount; t++) {
      const val = (maxV / tickCount) * t;
      const yy = y(val);
      svg.appendChild(
        el('line', {
          class: 'chart-grid',
          x1: m.left,
          x2: m.left + plotW,
          y1: yy,
          y2: yy
        })
      );
      svg.appendChild(
        el(
          'text',
          {
            class: 'chart-tick',
            x: m.left - 8,
            y: yy + 4,
            'text-anchor': 'end'
          },
          formatTick(val)
        )
      );
    }

    // ---- baseline (x axis) ----
    svg.appendChild(
      el('line', {
        class: 'chart-baseline',
        x1: m.left,
        x2: m.left + plotW,
        y1: m.top + plotH,
        y2: m.top + plotH
      })
    );

    // ---- area fill ----
    let areaPath = `M ${x(0)} ${m.top + plotH}`;
    series.forEach((d, i) => {
      areaPath += ` L ${x(i)} ${y(d.visitors)}`;
    });
    areaPath += ` L ${x(n - 1)} ${m.top + plotH} Z`;
    svg.appendChild(el('path', { class: 'chart-fill', d: areaPath }));

    // ---- line series ----
    let linePath = '';
    series.forEach((d, i) => {
      linePath += `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(d.visitors)} `;
    });
    svg.appendChild(el('path', { class: 'chart-series', d: linePath.trim() }));

    // ---- x ticks (first, ~middle, last) to avoid crowding ----
    const xTickIdx = n <= 1 ? [0] : [0, Math.floor((n - 1) / 2), n - 1];
    const seen = new Set();
    xTickIdx.forEach((i) => {
      if (seen.has(i)) return;
      seen.add(i);
      const anchor = i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle';
      svg.appendChild(
        el(
          'text',
          {
            class: 'chart-tick',
            x: x(i),
            y: m.top + plotH + 18,
            'text-anchor': anchor
          },
          shortDate(series[i].day)
        )
      );
    });

    wrap.innerHTML = '';
    wrap.appendChild(svg);
  };

  draw();

  const ro = new ResizeObserver(() => draw());
  ro.observe(wrap);
  // Also redraw on window resize as a fallback.
  const onResize = () => draw();
  window.addEventListener('resize', onResize);

  return () => {
    ro.disconnect();
    window.removeEventListener('resize', onResize);
  };
}

function formatTick(v) {
  if (v >= 1000) return (v / 1000).toFixed(v % 1000 === 0 ? 0 : 1) + 'k';
  return String(Math.round(v));
}

function shortDate(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}
