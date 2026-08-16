// Hand-drawn responsive SVG line chart. No external libraries.
// It reads CSS custom properties for theme colors so toggling the theme
// restyles the chart internals, and it redraws to fit its container.

const SVG_NS = 'http://www.w3.org/2000/svg';

function el(name, attrs = {}, text) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

function cssVar(host, name, fallback) {
  const v = getComputedStyle(host).getPropertyValue(name).trim();
  return v || fallback;
}

function formatDay(iso) {
  // iso = "YYYY-MM-DD" -> "M/D"
  const [, m, d] = iso.split('-');
  return `${parseInt(m, 10)}/${parseInt(d, 10)}`;
}

function formatNum(n) {
  if (n >= 1000) return `${Math.round(n / 100) / 10}k`;
  return String(n);
}

export function createChart(container) {
  let data = [];

  function draw() {
    const width = Math.max(240, container.clientWidth);
    // Keep a pleasant aspect ratio but cap height.
    const height = Math.max(180, Math.min(320, Math.round(width * 0.42)));

    const padL = 46;
    const padR = 14;
    const padT = 12;
    const padB = 28;

    const plotW = width - padL - padR;
    const plotH = height - padT - padB;

    container.innerHTML = '';

    if (!data.length) {
      const p = document.createElement('div');
      p.className = 'empty';
      p.textContent = 'No data';
      container.appendChild(p);
      return;
    }

    const lineColor = cssVar(container, '--chart-line', '#2563eb');
    const fillColor = cssVar(container, '--chart-fill', 'rgba(37,99,235,0.12)');
    const gridColor = cssVar(container, '--chart-grid', '#e6e9f1');
    const axisColor = cssVar(container, '--chart-axis', '#9aa3b5');
    const labelColor = cssVar(container, '--chart-label', '#5b6477');

    const values = data.map((d) => d.visitors);
    const maxV = Math.max(...values);
    const minV = Math.min(...values);
    const lo = Math.max(0, Math.floor((minV * 0.9) / 100) * 100);
    const hi = Math.ceil((maxV * 1.05) / 100) * 100 || 100;
    const range = hi - lo || 1;

    const x = (i) => padL + (data.length === 1 ? plotW / 2 : (i / (data.length - 1)) * plotW);
    const y = (v) => padT + plotH - ((v - lo) / range) * plotH;

    const svg = el('svg', {
      viewBox: `0 0 ${width} ${height}`,
      width: '100%',
      height: 'auto',
      role: 'img',
      'aria-label': '30-day visitors line chart',
      preserveAspectRatio: 'xMidYMid meet',
    });

    // ---- horizontal gridlines + Y tick labels ----
    const yTicks = 4;
    for (let t = 0; t <= yTicks; t++) {
      const val = lo + (range * t) / yTicks;
      const yy = y(val);
      svg.appendChild(
        el('line', {
          x1: padL,
          x2: width - padR,
          y1: yy,
          y2: yy,
          stroke: gridColor,
          'stroke-width': 1,
        })
      );
      svg.appendChild(
        el(
          'text',
          {
            x: padL - 8,
            y: yy + 4,
            'text-anchor': 'end',
            'font-size': 11,
            fill: labelColor,
          },
          formatNum(Math.round(val))
        )
      );
    }

    // ---- X axis line ----
    svg.appendChild(
      el('line', {
        x1: padL,
        x2: width - padR,
        y1: padT + plotH,
        y2: padT + plotH,
        stroke: axisColor,
        'stroke-width': 1,
      })
    );

    // ---- X tick labels (spaced to avoid crowding) ----
    const maxLabels = Math.max(3, Math.floor(plotW / 60));
    const step = Math.max(1, Math.ceil(data.length / maxLabels));
    for (let i = 0; i < data.length; i += step) {
      svg.appendChild(
        el(
          'text',
          {
            x: x(i),
            y: padT + plotH + 18,
            'text-anchor': 'middle',
            'font-size': 11,
            fill: labelColor,
          },
          formatDay(data[i].day)
        )
      );
    }

    // ---- area fill ----
    let areaD = `M ${x(0)} ${y(data[0].visitors)}`;
    for (let i = 1; i < data.length; i++) areaD += ` L ${x(i)} ${y(data[i].visitors)}`;
    areaD += ` L ${x(data.length - 1)} ${padT + plotH} L ${x(0)} ${padT + plotH} Z`;
    svg.appendChild(el('path', { d: areaD, fill: fillColor, stroke: 'none' }));

    // ---- line ----
    let lineD = `M ${x(0)} ${y(data[0].visitors)}`;
    for (let i = 1; i < data.length; i++) lineD += ` L ${x(i)} ${y(data[i].visitors)}`;
    svg.appendChild(
      el('path', {
        d: lineD,
        fill: 'none',
        stroke: lineColor,
        'stroke-width': 2,
        'stroke-linejoin': 'round',
        'stroke-linecap': 'round',
      })
    );

    // ---- last point dot ----
    const li = data.length - 1;
    svg.appendChild(
      el('circle', { cx: x(li), cy: y(data[li].visitors), r: 3.5, fill: lineColor })
    );

    container.appendChild(svg);
  }

  // Redraw on container resize.
  const ro = new ResizeObserver(() => draw());
  ro.observe(container);
  // Fallback for window resize (older browsers / safety).
  window.addEventListener('resize', draw);

  return {
    setData(d) {
      data = d || [];
      draw();
    },
    redraw: draw,
    destroy() {
      ro.disconnect();
      window.removeEventListener('resize', draw);
    },
  };
}
