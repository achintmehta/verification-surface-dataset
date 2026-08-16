// Hand-drawn SVG line chart. No chart library.
// Reads theme colors from CSS custom properties so it restyles on toggle, and
// exposes render() which re-measures the container — call it on resize.

const SVG_NS = 'http://www.w3.org/2000/svg';

function el(name, attrs = {}, text) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  if (text != null) node.textContent = text;
  return node;
}

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
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

/**
 * Creates a chart bound to a container element.
 * Returns { render } — render() draws/redraws to fit the container's
 * current size. Call it after data changes, on theme change, and on resize.
 */
export function createChart(container) {
  let series = []; // [{ day, visitors }]

  function render() {
    if (!series.length) return;

    const rect = container.getBoundingClientRect();
    const width = Math.max(220, Math.round(rect.width));
    const height = Math.max(160, Math.round(rect.height));

    // Margins leave room for axis ticks/labels INSIDE the chart area so
    // nothing is ever drawn outside the box.
    const m = { top: 12, right: 14, bottom: 28, left: 46 };
    const innerW = Math.max(10, width - m.left - m.right);
    const innerH = Math.max(10, height - m.top - m.bottom);

    const colLine = cssVar('--chart-line', '#2563eb');
    const colArea = cssVar('--chart-area', 'rgba(37,99,235,0.12)');
    const colGrid = cssVar('--chart-grid', '#e2e8f0');
    const colAxis = cssVar('--chart-axis', '#94a3b8');
    const colText = cssVar('--chart-axis-text', '#5b6678');

    const values = series.map((d) => d.visitors);
    const dataMax = Math.max(...values);
    const yMax = niceMax(dataMax);

    const n = series.length;
    const x = (i) => m.left + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW);
    const y = (v) => m.top + innerH - (v / yMax) * innerH;

    const svg = el('svg', {
      viewBox: `0 0 ${width} ${height}`,
      width,
      height,
      preserveAspectRatio: 'none',
      role: 'img',
    });

    // ---- Y gridlines + labels ----
    const yTicks = 4;
    for (let t = 0; t <= yTicks; t++) {
      const val = (yMax / yTicks) * t;
      const yy = y(val);
      svg.appendChild(
        el('line', {
          x1: m.left,
          y1: yy,
          x2: m.left + innerW,
          y2: yy,
          stroke: colGrid,
          'stroke-width': 1,
        })
      );
      svg.appendChild(
        el(
          'text',
          {
            x: m.left - 8,
            y: yy + 3.5,
            'text-anchor': 'end',
            'font-size': 10,
            fill: colText,
          },
          formatTick(val)
        )
      );
    }

    // ---- X axis labels (first, middle, last to avoid crowding) ----
    const xLabelIdx = [0, Math.floor((n - 1) / 2), n - 1];
    for (const i of xLabelIdx) {
      const label = shortDate(series[i].day);
      const anchor = i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle';
      svg.appendChild(
        el(
          'text',
          {
            x: x(i),
            y: m.top + innerH + 18,
            'text-anchor': anchor,
            'font-size': 10,
            fill: colText,
          },
          label
        )
      );
    }

    // ---- Axis baseline ----
    svg.appendChild(
      el('line', {
        x1: m.left,
        y1: m.top + innerH,
        x2: m.left + innerW,
        y2: m.top + innerH,
        stroke: colAxis,
        'stroke-width': 1,
      })
    );

    // ---- Area + line path ----
    let line = '';
    series.forEach((d, i) => {
      line += `${i === 0 ? 'M' : 'L'}${x(i).toFixed(2)} ${y(d.visitors).toFixed(2)} `;
    });
    const area =
      `M${x(0).toFixed(2)} ${(m.top + innerH).toFixed(2)} ` +
      series.map((d, i) => `L${x(i).toFixed(2)} ${y(d.visitors).toFixed(2)}`).join(' ') +
      ` L${x(n - 1).toFixed(2)} ${(m.top + innerH).toFixed(2)} Z`;

    svg.appendChild(el('path', { d: area, fill: colArea, stroke: 'none' }));
    svg.appendChild(
      el('path', {
        d: line.trim(),
        fill: 'none',
        stroke: colLine,
        'stroke-width': 2,
        'stroke-linejoin': 'round',
        'stroke-linecap': 'round',
      })
    );

    // Replace content.
    container.replaceChildren(svg);
  }

  function setData(next) {
    series = Array.isArray(next) ? next : [];
    render();
  }

  return { render, setData };
}

function formatTick(v) {
  if (v >= 1000) return `${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)}k`;
  return String(Math.round(v));
}

function shortDate(iso) {
  // iso like 2024-06-30
  const [, mm, dd] = iso.split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[Number(mm) - 1]} ${Number(dd)}`;
}
