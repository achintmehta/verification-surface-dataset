const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Read a CSS custom property from the document root so the chart picks up the
 * active theme.
 */
function themeColor(name, fallback) {
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return v || fallback;
}

function el(tag, attrs) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    node.setAttribute(k, String(v));
  }
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
  return String(Math.round(v));
}

/**
 * Render a responsive line chart into the given <svg> element. The chart uses
 * the SVG's measured pixel size so axis labels, ticks, and the series always
 * fit the container, and it re-renders whenever called (e.g. on resize).
 *
 * @param {SVGSVGElement} svg
 * @param {{date:string, visitors:number}[]} data
 */
export function renderChart(svg, data) {
  const container = svg.parentElement;
  if (!container) return;

  const width = Math.max(1, container.clientWidth);
  const height = Math.max(1, container.clientHeight);

  // Use a 1:1 user-unit-to-pixel viewBox so text stays crisp and unstretched.
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  // Clear previous render.
  while (svg.firstChild) svg.removeChild(svg.firstChild);

  if (!data || data.length === 0) return;

  const axisColor = themeColor('--chart-axis', '#9aa4b8');
  const gridColor = themeColor('--chart-grid', '#e7eaf1');
  const lineColor = themeColor('--chart-line', '#2563eb');
  const areaColor = themeColor('--chart-area', 'rgba(37,99,235,0.12)');
  const labelColor = themeColor('--chart-label', '#5b667d');

  // Margins leave room for axis labels.
  const margin = { top: 12, right: 14, bottom: 26, left: 44 };
  const plotW = Math.max(1, width - margin.left - margin.right);
  const plotH = Math.max(1, height - margin.top - margin.bottom);

  const maxVal = niceMax(Math.max(...data.map((d) => d.visitors)));
  const n = data.length;

  const x = (i) => margin.left + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const y = (v) => margin.top + plotH - (v / maxVal) * plotH;

  // ---- Horizontal gridlines + Y tick labels ----
  const yTicks = 4;
  for (let t = 0; t <= yTicks; t++) {
    const val = (maxVal / yTicks) * t;
    const yy = y(val);
    svg.appendChild(
      el('line', {
        x1: margin.left,
        y1: yy,
        x2: margin.left + plotW,
        y2: yy,
        stroke: gridColor,
        'stroke-width': 1,
      })
    );
    const label = el('text', {
      x: margin.left - 8,
      y: yy + 3,
      'text-anchor': 'end',
      'font-size': 10,
      fill: labelColor,
    });
    label.textContent = formatTick(val);
    svg.appendChild(label);
  }

  // ---- X axis baseline ----
  svg.appendChild(
    el('line', {
      x1: margin.left,
      y1: margin.top + plotH,
      x2: margin.left + plotW,
      y2: margin.top + plotH,
      stroke: axisColor,
      'stroke-width': 1,
    })
  );
  // ---- Y axis line ----
  svg.appendChild(
    el('line', {
      x1: margin.left,
      y1: margin.top,
      x2: margin.left,
      y2: margin.top + plotH,
      stroke: axisColor,
      'stroke-width': 1,
    })
  );

  // ---- X tick labels: show a handful evenly spaced to avoid crowding ----
  const maxLabels = Math.max(2, Math.min(6, Math.floor(plotW / 60)));
  const step = Math.max(1, Math.round((n - 1) / (maxLabels - 1)));
  for (let i = 0; i < n; i += step) {
    const d = data[i];
    const xx = x(i);
    const md = formatDateShort(d.date);
    const anchor = i === 0 ? 'start' : i >= n - step ? 'end' : 'middle';
    const label = el('text', {
      x: xx,
      y: margin.top + plotH + 16,
      'text-anchor': anchor,
      'font-size': 10,
      fill: labelColor,
    });
    label.textContent = md;
    svg.appendChild(label);
  }

  // ---- Area fill ----
  const areaPath =
    `M ${x(0)} ${margin.top + plotH} ` +
    data.map((d, i) => `L ${x(i)} ${y(d.visitors)}`).join(' ') +
    ` L ${x(n - 1)} ${margin.top + plotH} Z`;
  svg.appendChild(
    el('path', { d: areaPath, fill: areaColor, stroke: 'none' })
  );

  // ---- Series line ----
  const linePath = data
    .map((d, i) => `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(d.visitors)}`)
    .join(' ');
  svg.appendChild(
    el('path', {
      d: linePath,
      fill: 'none',
      stroke: lineColor,
      'stroke-width': 2,
      'stroke-linejoin': 'round',
      'stroke-linecap': 'round',
    })
  );
}

function formatDateShort(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}
