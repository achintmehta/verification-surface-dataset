/**
 * Hand-drawn SVG time-series line chart.
 * Redraws on container resize using ResizeObserver.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

let cachedData = null;
let resizeObserver = null;

/**
 * Get current theme CSS custom property values.
 */
function getThemeColors() {
  const style = getComputedStyle(document.documentElement);
  return {
    grid: style.getPropertyValue('--chart-grid').trim() || '#e5e7eb',
    axis: style.getPropertyValue('--chart-axis').trim() || '#374151',
    line: style.getPropertyValue('--chart-line').trim() || '#3b82f6',
    dot: style.getPropertyValue('--chart-dot').trim() || '#2563eb',
    text: style.getPropertyValue('--text-secondary').trim() || '#6b7280',
    surface: style.getPropertyValue('--surface').trim() || '#ffffff',
  };
}

function clearSvg(svg) {
  while (svg.firstChild) svg.removeChild(svg.firstChild);
}

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, v);
  }
  return el;
}

/**
 * Draw the chart into the SVG element.
 */
function draw(svg, data) {
  clearSvg(svg);

  const container = svg.parentElement;
  const totalWidth = container.clientWidth;
  const totalHeight = container.clientHeight;

  if (totalWidth < 10 || totalHeight < 10) return;

  // Set SVG viewBox to match container
  svg.setAttribute('viewBox', `0 0 ${totalWidth} ${totalHeight}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  const colors = getThemeColors();

  // Margins that adapt to width
  const isNarrow = totalWidth < 500;
  const margin = {
    top: 20,
    right: isNarrow ? 12 : 24,
    bottom: isNarrow ? 50 : 40,
    left: isNarrow ? 42 : 56,
  };

  const w = totalWidth - margin.left - margin.right;
  const h = totalHeight - margin.top - margin.bottom;

  if (w < 20 || h < 20) return;

  // Data extents
  const visitors = data.map(d => d.visitors);
  const minVal = Math.min(...visitors);
  const maxVal = Math.max(...visitors);
  const valRange = maxVal - minVal || 1;
  const padding = valRange * 0.1;
  const yMin = Math.max(0, minVal - padding);
  const yMax = maxVal + padding;
  const yRange = yMax - yMin;

  // Scales
  const xScale = (i) => margin.left + (i / (data.length - 1)) * w;
  const yScale = (v) => margin.top + h - ((v - yMin) / yRange) * h;

  // Background
  const bg = svgEl('rect', {
    x: 0, y: 0, width: totalWidth, height: totalHeight,
    fill: colors.surface, rx: 0,
  });
  svg.appendChild(bg);

  // Gridlines (horizontal)
  const gridCount = 5;
  for (let i = 0; i <= gridCount; i++) {
    const val = yMin + (yRange / gridCount) * i;
    const y = yScale(val);
    const line = svgEl('line', {
      x1: margin.left, y1: y, x2: totalWidth - margin.right, y2: y,
      stroke: colors.grid, 'stroke-width': 1, 'stroke-dasharray': '4,3',
    });
    svg.appendChild(line);

    // Y-axis label
    const label = svgEl('text', {
      x: margin.left - 6, y: y + 4,
      'text-anchor': 'end',
      'font-size': isNarrow ? '9' : '11',
      fill: colors.text,
      'font-family': 'inherit',
    });
    label.textContent = Math.round(val).toLocaleString();
    svg.appendChild(label);
  }

  // X-axis labels
  // Show a subset of date labels depending on width
  const labelEvery = isNarrow ? Math.ceil(data.length / 5) : Math.ceil(data.length / 8);
  for (let i = 0; i < data.length; i++) {
    if (i % labelEvery !== 0 && i !== data.length - 1) continue;
    const x = xScale(i);
    const dateObj = new Date(data[i].date);
    const labelText = dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

    // Tick mark
    const tick = svgEl('line', {
      x1: x, y1: margin.top + h, x2: x, y2: margin.top + h + 5,
      stroke: colors.axis, 'stroke-width': 1,
    });
    svg.appendChild(tick);

    const text = svgEl('text', {
      x: x, y: margin.top + h + (isNarrow ? 18 : 20),
      'text-anchor': 'middle',
      'font-size': isNarrow ? '8' : '10',
      fill: colors.text,
      'font-family': 'inherit',
    });

    if (isNarrow) {
      // Rotate labels on narrow screens
      text.setAttribute('transform', `rotate(-45, ${x}, ${margin.top + h + 18})`);
      text.setAttribute('text-anchor', 'end');
    }

    text.textContent = labelText;
    svg.appendChild(text);
  }

  // Axes
  // Y axis
  svg.appendChild(svgEl('line', {
    x1: margin.left, y1: margin.top, x2: margin.left, y2: margin.top + h,
    stroke: colors.axis, 'stroke-width': 1.5,
  }));
  // X axis
  svg.appendChild(svgEl('line', {
    x1: margin.left, y1: margin.top + h,
    x2: totalWidth - margin.right, y2: margin.top + h,
    stroke: colors.axis, 'stroke-width': 1.5,
  }));

  // Line path
  const points = data.map((d, i) => `${xScale(i)},${yScale(d.visitors)}`);
  const polyline = svgEl('polyline', {
    points: points.join(' '),
    fill: 'none',
    stroke: colors.line,
    'stroke-width': 2,
    'stroke-linejoin': 'round',
    'stroke-linecap': 'round',
  });
  svg.appendChild(polyline);

  // Area fill (gradient)
  const defs = svgEl('defs');
  const gradId = 'area-gradient';
  const grad = svgEl('linearGradient', { id: gradId, x1: '0', y1: '0', x2: '0', y2: '1' });
  const stop1 = svgEl('stop', { offset: '0%', 'stop-color': colors.line, 'stop-opacity': '0.2' });
  const stop2 = svgEl('stop', { offset: '100%', 'stop-color': colors.line, 'stop-opacity': '0.02' });
  grad.appendChild(stop1);
  grad.appendChild(stop2);
  defs.appendChild(grad);
  svg.appendChild(defs);

  const areaPoints = [
    `${xScale(0)},${yScale(yMin)}`,
    ...points,
    `${xScale(data.length - 1)},${yScale(yMin)}`,
  ];
  const areaPolygon = svgEl('polygon', {
    points: areaPoints.join(' '),
    fill: `url(#${gradId})`,
  });
  svg.appendChild(areaPolygon);

  // Re-append line on top of area
  svg.appendChild(polyline);

  // Data dots
  data.forEach((d, i) => {
    const circle = svgEl('circle', {
      cx: xScale(i), cy: yScale(d.visitors),
      r: isNarrow ? 2 : 3,
      fill: colors.dot,
      stroke: colors.surface,
      'stroke-width': 1.5,
    });
    svg.appendChild(circle);
  });
}

/**
 * Initialize chart with data and set up resize handling.
 */
export function renderChart(data) {
  cachedData = data;
  const svg = document.getElementById('timeseries-chart');
  if (!svg) return;

  draw(svg, data);

  // Set up ResizeObserver for responsive redraw
  if (resizeObserver) resizeObserver.disconnect();

  const container = document.getElementById('chart-container');
  if (container) {
    resizeObserver = new ResizeObserver(() => {
      if (cachedData) draw(svg, cachedData);
    });
    resizeObserver.observe(container);
  }
}

/**
 * Force a redraw (e.g., after theme change).
 */
export function redrawChart() {
  if (!cachedData) return;
  const svg = document.getElementById('timeseries-chart');
  if (svg) draw(svg, cachedData);
}
