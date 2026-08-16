/**
 * Hand-drawn SVG time-series line chart.
 * Redraws to fit its container on resize.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

function createSVGElement(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, val] of Object.entries(attrs)) {
    el.setAttribute(key, String(val));
  }
  return el;
}

function getThemeColors() {
  const style = getComputedStyle(document.documentElement);
  return {
    grid: style.getPropertyValue('--chart-grid').trim() || '#e5e7eb',
    axis: style.getPropertyValue('--chart-axis').trim() || '#6b7280',
    line: style.getPropertyValue('--chart-line').trim() || '#3b82f6',
    fill: style.getPropertyValue('--chart-fill').trim() || 'rgba(59, 130, 246, 0.1)',
    dot: style.getPropertyValue('--chart-dot').trim() || '#3b82f6',
    text: style.getPropertyValue('--text-primary').trim() || '#1a1a2e',
    textSec: style.getPropertyValue('--text-secondary').trim() || '#6b7280',
    cardBg: style.getPropertyValue('--bg-card').trim() || '#ffffff',
  };
}

/**
 * Draw a time-series line chart into an SVG element.
 * @param {SVGElement} svg - target SVG element
 * @param {Array} data - array of { date, visitors }
 */
export function drawTimeseriesChart(svg, data) {
  // Clear
  svg.innerHTML = '';

  if (!data || data.length === 0) return;

  const container = svg.parentElement;
  const rect = container.getBoundingClientRect();
  const totalWidth = Math.floor(rect.width);
  const totalHeight = Math.floor(rect.height);

  if (totalWidth <= 0 || totalHeight <= 0) return;

  svg.setAttribute('viewBox', `0 0 ${totalWidth} ${totalHeight}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  const colors = getThemeColors();

  // Margins
  const isNarrow = totalWidth < 500;
  const margin = {
    top: 20,
    right: isNarrow ? 10 : 20,
    bottom: isNarrow ? 40 : 45,
    left: isNarrow ? 40 : 55,
  };

  const chartWidth = totalWidth - margin.left - margin.right;
  const chartHeight = totalHeight - margin.top - margin.bottom;

  if (chartWidth <= 0 || chartHeight <= 0) return;

  // Data ranges
  const values = data.map(d => d.visitors);
  const minVal = Math.min(...values);
  const maxVal = Math.max(...values);
  const valRange = maxVal - minVal || 1;
  const padding = valRange * 0.1;
  const yMin = Math.max(0, minVal - padding);
  const yMax = maxVal + padding;
  const yRange = yMax - yMin;

  // Scale functions
  const xScale = (i) => margin.left + (i / (data.length - 1)) * chartWidth;
  const yScale = (v) => margin.top + chartHeight - ((v - yMin) / yRange) * chartHeight;

  // Chart area group
  const chartGroup = createSVGElement('g');

  // Gridlines and Y-axis labels
  const numTicks = isNarrow ? 4 : 5;
  for (let i = 0; i <= numTicks; i++) {
    const val = yMin + (i / numTicks) * yRange;
    const y = yScale(val);

    // Gridline
    chartGroup.appendChild(createSVGElement('line', {
      x1: margin.left,
      y1: y,
      x2: totalWidth - margin.right,
      y2: y,
      stroke: colors.grid,
      'stroke-width': 1,
      'stroke-dasharray': '3,3',
    }));

    // Y label
    const label = createSVGElement('text', {
      x: margin.left - 8,
      y: y + 4,
      fill: colors.textSec,
      'font-size': isNarrow ? 9 : 11,
      'text-anchor': 'end',
      'font-family': 'sans-serif',
    });
    label.textContent = formatCompact(val);
    chartGroup.appendChild(label);
  }

  // X-axis labels
  const maxXLabels = isNarrow ? 5 : Math.min(data.length, 10);
  const xStep = Math.max(1, Math.floor((data.length - 1) / (maxXLabels - 1)));
  for (let i = 0; i < data.length; i += xStep) {
    const x = xScale(i);
    const date = new Date(data[i].date);
    const label = createSVGElement('text', {
      x,
      y: margin.top + chartHeight + (isNarrow ? 18 : 22),
      fill: colors.textSec,
      'font-size': isNarrow ? 9 : 11,
      'text-anchor': 'middle',
      'font-family': 'sans-serif',
    });
    label.textContent = `${date.getMonth() + 1}/${date.getDate()}`;
    chartGroup.appendChild(label);

    // Tick mark
    chartGroup.appendChild(createSVGElement('line', {
      x1: x,
      y1: margin.top + chartHeight,
      x2: x,
      y2: margin.top + chartHeight + 5,
      stroke: colors.axis,
      'stroke-width': 1,
    }));
  }

  // Axes
  // X axis
  chartGroup.appendChild(createSVGElement('line', {
    x1: margin.left,
    y1: margin.top + chartHeight,
    x2: totalWidth - margin.right,
    y2: margin.top + chartHeight,
    stroke: colors.axis,
    'stroke-width': 1.5,
  }));

  // Y axis
  chartGroup.appendChild(createSVGElement('line', {
    x1: margin.left,
    y1: margin.top,
    x2: margin.left,
    y2: margin.top + chartHeight,
    stroke: colors.axis,
    'stroke-width': 1.5,
  }));

  // Area fill
  const areaPoints = data.map((d, i) => `${xScale(i)},${yScale(d.visitors)}`);
  areaPoints.push(`${xScale(data.length - 1)},${margin.top + chartHeight}`);
  areaPoints.push(`${xScale(0)},${margin.top + chartHeight}`);

  chartGroup.appendChild(createSVGElement('polygon', {
    points: areaPoints.join(' '),
    fill: colors.fill,
  }));

  // Line
  const linePoints = data.map((d, i) => `${xScale(i)},${yScale(d.visitors)}`).join(' ');
  chartGroup.appendChild(createSVGElement('polyline', {
    points: linePoints,
    fill: 'none',
    stroke: colors.line,
    'stroke-width': 2.5,
    'stroke-linejoin': 'round',
    'stroke-linecap': 'round',
  }));

  // Data points
  const showDots = !isNarrow || data.length <= 15;
  if (showDots) {
    data.forEach((d, i) => {
      const cx = xScale(i);
      const cy = yScale(d.visitors);
      chartGroup.appendChild(createSVGElement('circle', {
        cx,
        cy,
        r: isNarrow ? 2.5 : 3.5,
        fill: colors.dot,
        stroke: colors.cardBg,
        'stroke-width': 1.5,
      }));
    });
  }

  svg.appendChild(chartGroup);
}

function formatCompact(value) {
  if (value >= 1000) {
    return (value / 1000).toFixed(1) + 'k';
  }
  return Math.round(value).toString();
}

/**
 * Set up resize observer to redraw chart on container resize.
 * @param {SVGElement} svg
 * @param {Array} data
 * @returns {Function} cleanup function
 */
export function setupChartResize(svg, data) {
  const container = svg.parentElement;
  let resizeTimeout = null;

  const observer = new ResizeObserver(() => {
    if (resizeTimeout) clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
      drawTimeseriesChart(svg, data);
    }, 50);
  });

  observer.observe(container);

  return () => {
    observer.disconnect();
    if (resizeTimeout) clearTimeout(resizeTimeout);
  };
}
