// Hand-drawn time-series line chart using SVG. No charting library.
// The chart reads the pixel size of its container and redraws to fit,
// re-rendering on container resize (via ResizeObserver).

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
 * Creates a chart bound to a container element.
 * @returns {{ setData: (rows:Array)=>void, destroy: ()=>void }}
 */
export function createChart(container) {
  let data = [];

  function render() {
    const width = Math.max(240, Math.floor(container.clientWidth));
    // Aspect ratio adapts: a bit taller (relatively) on narrow screens.
    const height = Math.round(
      Math.min(360, Math.max(200, width * (width < 480 ? 0.62 : 0.42)))
    );

    container.replaceChildren();
    const svg = el('svg', {
      viewBox: `0 0 ${width} ${height}`,
      width: '100%',
      role: 'img',
      'aria-label': 'Visitors over the last 30 days',
      preserveAspectRatio: 'xMidYMid meet',
    });

    if (!data.length) {
      container.appendChild(svg);
      return;
    }

    // Margins leave room for axis labels so nothing is clipped or overdrawn.
    const m = { top: 12, right: 14, bottom: 28, left: 44 };
    const plotW = width - m.left - m.right;
    const plotH = height - m.top - m.bottom;

    const maxVal = niceMax(Math.max(...data.map((d) => d.visitors)));
    const n = data.length;

    const x = (i) => m.left + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
    const y = (v) => m.top + plotH - (v / maxVal) * plotH;

    // ---- Y gridlines + labels ----
    const yTicks = 4;
    for (let t = 0; t <= yTicks; t++) {
      const val = (maxVal / yTicks) * t;
      const yy = y(val);
      svg.appendChild(
        el('line', {
          class: 'chart__grid-line',
          x1: m.left,
          y1: yy,
          x2: m.left + plotW,
          y2: yy,
        })
      );
      svg.appendChild(
        el(
          'text',
          {
            class: 'chart__label',
            x: m.left - 8,
            y: yy + 4,
            'text-anchor': 'end',
          },
          formatTick(Math.round(val))
        )
      );
    }

    // ---- Axes ----
    svg.appendChild(
      el('line', {
        class: 'chart__axis-line',
        x1: m.left,
        y1: m.top,
        x2: m.left,
        y2: m.top + plotH,
      })
    );
    svg.appendChild(
      el('line', {
        class: 'chart__axis-line',
        x1: m.left,
        y1: m.top + plotH,
        x2: m.left + plotW,
        y2: m.top + plotH,
      })
    );

    // ---- X labels: pick a sensible number of ticks that won't collide ----
    const approxLabelW = 52;
    const maxLabels = Math.max(2, Math.floor(plotW / approxLabelW));
    const step = Math.max(1, Math.ceil(n / maxLabels));
    for (let i = 0; i < n; i += step) {
      const label = shortDate(data[i].date);
      svg.appendChild(
        el(
          'text',
          {
            class: 'chart__label',
            x: x(i),
            y: m.top + plotH + 18,
            'text-anchor': 'middle',
          },
          label
        )
      );
    }

    // ---- Area fill + series line ----
    const linePts = data.map((d, i) => `${x(i)},${y(d.visitors)}`);
    const areaPath =
      `M ${x(0)},${m.top + plotH} ` +
      data.map((d, i) => `L ${x(i)},${y(d.visitors)}`).join(' ') +
      ` L ${x(n - 1)},${m.top + plotH} Z`;

    svg.appendChild(el('path', { class: 'chart__series-fill', d: areaPath }));
    svg.appendChild(
      el('polyline', { class: 'chart__series', points: linePts.join(' ') })
    );

    container.appendChild(svg);
  }

  function shortDate(iso) {
    // iso = YYYY-MM-DD
    const [, mm, dd] = iso.split('-');
    const months = [
      'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
    ];
    return `${months[Number(mm) - 1]} ${Number(dd)}`;
  }

  const ro = new ResizeObserver(() => render());
  ro.observe(container);

  return {
    setData(rows) {
      data = Array.isArray(rows) ? rows : [];
      render();
    },
    destroy() {
      ro.disconnect();
    },
  };
}
