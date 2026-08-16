import { formatNumber, formatDateShort } from './format.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

function el(name, attrs = {}, text) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) {
    node.setAttribute(k, String(v));
  }
  if (text != null) node.textContent = text;
  return node;
}

function niceCeil(value) {
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

/**
 * Renders a responsive 30-day line chart into `container`.
 * Re-renders on container resize via ResizeObserver. Coordinates are computed
 * from the measured container width so nothing is ever drawn outside the area.
 */
export function createTimeseriesChart(container, data) {
  let currentData = data;

  function draw() {
    const width = Math.max(220, Math.floor(container.clientWidth));
    // Keep a readable aspect ratio but clamp height for narrow/tall screens.
    const height = Math.round(Math.min(360, Math.max(180, width * 0.5)));

    container.innerHTML = '';
    if (!currentData || currentData.length === 0) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = 'No time-series data.';
      container.appendChild(p);
      return;
    }

    const svg = el('svg', {
      class: 'chart-svg',
      viewBox: `0 0 ${width} ${height}`,
      width,
      height,
      role: 'img',
      'aria-label': '30-day visitors time series',
      preserveAspectRatio: 'none',
    });

    // Margins leave room for axis labels; left margin scales a bit with width.
    const m = {
      top: 12,
      right: 14,
      bottom: 26,
      left: width < 420 ? 40 : 52,
    };
    const plotW = width - m.left - m.right;
    const plotH = height - m.top - m.bottom;

    const values = currentData.map((d) => d.visitors);
    const maxY = niceCeil(Math.max(...values));
    const minY = 0;

    const xAt = (i) =>
      m.left + (currentData.length === 1 ? plotW / 2 : (i / (currentData.length - 1)) * plotW);
    const yAt = (v) => m.top + plotH - ((v - minY) / (maxY - minY)) * plotH;

    // --- Horizontal gridlines + Y tick labels ---
    const yTicks = 4;
    for (let t = 0; t <= yTicks; t++) {
      const val = minY + ((maxY - minY) * t) / yTicks;
      const y = yAt(val);
      svg.appendChild(
        el('line', { class: 'chart-grid', x1: m.left, y1: y, x2: m.left + plotW, y2: y })
      );
      svg.appendChild(
        el(
          'text',
          {
            class: 'chart-axis-label',
            x: m.left - 6,
            y: y + 3,
            'text-anchor': 'end',
          },
          formatNumber(val)
        )
      );
    }

    // --- X axis baseline ---
    svg.appendChild(
      el('line', {
        class: 'chart-axis',
        x1: m.left,
        y1: m.top + plotH,
        x2: m.left + plotW,
        y2: m.top + plotH,
      })
    );

    // --- X tick labels: first, ~middle, last (avoid crowding on narrow) ---
    const labelIdx = [0, Math.floor((currentData.length - 1) / 2), currentData.length - 1];
    const seen = new Set();
    for (const i of labelIdx) {
      if (seen.has(i)) continue;
      seen.add(i);
      const anchor = i === 0 ? 'start' : i === currentData.length - 1 ? 'end' : 'middle';
      svg.appendChild(
        el(
          'text',
          {
            class: 'chart-axis-label',
            x: xAt(i),
            y: m.top + plotH + 16,
            'text-anchor': anchor,
          },
          formatDateShort(currentData[i].day)
        )
      );
    }

    // --- Area fill under the line ---
    const linePoints = currentData.map((d, i) => `${xAt(i)},${yAt(d.visitors)}`);
    const areaPath =
      `M ${m.left},${m.top + plotH} ` +
      linePoints.map((p) => `L ${p}`).join(' ') +
      ` L ${m.left + plotW},${m.top + plotH} Z`;
    svg.appendChild(el('path', { class: 'chart-area', d: areaPath }));

    // --- Series line ---
    const linePath = 'M ' + linePoints.join(' L ');
    svg.appendChild(el('path', { class: 'chart-series', d: linePath }));

    container.appendChild(svg);
  }

  draw();

  const ro = new ResizeObserver(() => draw());
  ro.observe(container);

  return {
    update(newData) {
      currentData = newData;
      draw();
    },
    redraw: draw,
    destroy() {
      ro.disconnect();
    },
  };
}
