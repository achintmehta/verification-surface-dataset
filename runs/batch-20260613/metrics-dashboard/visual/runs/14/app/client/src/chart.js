const SVG_NS = 'http://www.w3.org/2000/svg';

function el(name, attrs = {}, text) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  if (text != null) node.textContent = text;
  return node;
}

function niceMax(value) {
  if (value <= 0) return 10;
  const mag = Math.pow(10, Math.floor(Math.log10(value)));
  const norm = value / mag;
  let nice;
  if (norm <= 1) nice = 1;
  else if (norm <= 2) nice = 2;
  else if (norm <= 5) nice = 5;
  else nice = 10;
  return nice * mag;
}

function fmtCompact(n) {
  if (n >= 1000) return (n / 1000).toFixed(n % 1000 === 0 ? 0 : 1) + 'k';
  return String(n);
}

/**
 * Creates a responsive SVG line chart that redraws to fit its container.
 * Returns an object with destroy().
 */
export function createTimeSeriesChart(container, data) {
  // data: [{ day: 'YYYY-MM-DD', visitors: number }, ...]
  let raf = null;

  function render() {
    const w = Math.max(160, Math.floor(container.clientWidth));
    const h = Math.max(140, Math.floor(container.clientHeight));

    // Clear
    while (container.firstChild) container.removeChild(container.firstChild);

    const svg = el('svg', {
      viewBox: `0 0 ${w} ${h}`,
      width: w,
      height: h,
      preserveAspectRatio: 'none',
      role: 'img',
      'aria-label': '30-day visitors time series',
    });

    if (!data || data.length === 0) {
      svg.appendChild(
        el(
          'text',
          { x: w / 2, y: h / 2, 'text-anchor': 'middle', class: 'chart-tick-label' },
          'No data'
        )
      );
      container.appendChild(svg);
      return;
    }

    // Plot area margins (room for axis labels).
    const mL = 44;
    const mR = 12;
    const mT = 12;
    const mB = 26;
    const plotW = Math.max(1, w - mL - mR);
    const plotH = Math.max(1, h - mT - mB);

    const values = data.map((d) => d.visitors);
    const maxV = niceMax(Math.max(...values));
    const minV = 0;

    const n = data.length;
    const xFor = (i) => mL + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
    const yFor = (v) => mT + plotH - ((v - minV) / (maxV - minV)) * plotH;

    // ----- gridlines + Y ticks -----
    const yTicks = 4;
    for (let t = 0; t <= yTicks; t++) {
      const v = minV + ((maxV - minV) * t) / yTicks;
      const y = yFor(v);
      svg.appendChild(
        el('line', {
          x1: mL,
          y1: y,
          x2: mL + plotW,
          y2: y,
          class: 'chart-grid-line',
        })
      );
      svg.appendChild(
        el(
          'text',
          {
            x: mL - 8,
            y: y + 4,
            'text-anchor': 'end',
            class: 'chart-tick-label',
          },
          fmtCompact(Math.round(v))
        )
      );
    }

    // ----- axes -----
    svg.appendChild(
      el('line', { x1: mL, y1: mT, x2: mL, y2: mT + plotH, class: 'chart-axis-line' })
    );
    svg.appendChild(
      el('line', {
        x1: mL,
        y1: mT + plotH,
        x2: mL + plotW,
        y2: mT + plotH,
        class: 'chart-axis-line',
      })
    );

    // ----- X ticks (avoid crowding by limiting count to fit width) -----
    const maxXLabels = Math.max(2, Math.min(6, Math.floor(plotW / 60)));
    const step = Math.max(1, Math.round((n - 1) / (maxXLabels - 1)));
    for (let i = 0; i < n; i += step) {
      const x = xFor(i);
      const label = data[i].day.slice(5); // MM-DD
      svg.appendChild(
        el(
          'text',
          {
            x,
            y: mT + plotH + 16,
            'text-anchor': i === 0 ? 'start' : 'middle',
            class: 'chart-tick-label',
          },
          label
        )
      );
    }

    // ----- area + line path -----
    let linePath = '';
    let areaPath = '';
    data.forEach((d, i) => {
      const x = xFor(i);
      const y = yFor(d.visitors);
      linePath += (i === 0 ? 'M' : 'L') + x.toFixed(2) + ' ' + y.toFixed(2) + ' ';
    });
    const x0 = xFor(0);
    const xN = xFor(n - 1);
    const baseY = mT + plotH;
    areaPath =
      `M${x0.toFixed(2)} ${baseY.toFixed(2)} ` +
      linePath.replace(/^M/, 'L') +
      `L${xN.toFixed(2)} ${baseY.toFixed(2)} Z`;

    svg.appendChild(el('path', { d: areaPath, class: 'chart-series-area' }));
    svg.appendChild(el('path', { d: linePath.trim(), class: 'chart-series-line' }));

    container.appendChild(svg);
  }

  function scheduleRender() {
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(render);
  }

  const ro = new ResizeObserver(scheduleRender);
  ro.observe(container);
  window.addEventListener('resize', scheduleRender);

  render();

  return {
    destroy() {
      ro.disconnect();
      window.removeEventListener('resize', scheduleRender);
      if (raf) cancelAnimationFrame(raf);
    },
  };
}
