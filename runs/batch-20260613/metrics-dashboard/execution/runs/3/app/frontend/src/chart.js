/**
 * Hand-drawn SVG time-series line chart.
 *
 * Features:
 *  - Reads CSS custom properties for colors (theme-aware)
 *  - Redraws to fit its container on every call
 *  - Axes with labeled ticks, gridlines, area fill, line, dots
 *  - Nothing drawn outside the chart area (clip-path)
 *  - Responsive: adapts tick density to available width
 */

// Read a CSS custom property from :root
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// SVG namespace helper
const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, v);
  }
  return el;
}

function niceMax(rawMax) {
  // Round up to a "nice" number for the Y axis
  if (rawMax <= 0) return 10;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawMax)));
  const normalized = rawMax / magnitude;
  let nice;
  if (normalized <= 1)      nice = 1;
  else if (normalized <= 2) nice = 2;
  else if (normalized <= 5) nice = 5;
  else                      nice = 10;
  return nice * magnitude;
}

function formatAxisValue(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}

function formatAxisDate(dateStr) {
  // dateStr may be 'YYYY-MM-DD' or full ISO string
  // Extract just the date portion to avoid timezone shifts
  const datePart = String(dateStr).slice(0, 10); // 'YYYY-MM-DD'
  const [year, month, day] = datePart.split('-').map(Number);
  const d = new Date(year, month - 1, day); // local time, no TZ shift
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * Draw (or redraw) the time-series chart into `svgEl`.
 *
 * @param {SVGSVGElement} svg   - the SVG element to draw into
 * @param {HTMLElement}   container - parent element (used to measure width)
 * @param {Array}         data  - [{date, visitors, revenue}, ...]
 */
export function drawTimeseriesChart(svg, container, data) {
  // Clear previous content
  while (svg.firstChild) svg.removeChild(svg.firstChild);

  if (!data || data.length === 0) {
    svg.setAttribute('viewBox', '0 0 400 200');
    svg.setAttribute('height', '200');
    const t = svgEl('text', { x: 200, y: 100, 'text-anchor': 'middle', fill: cssVar('--chart-label'), 'font-size': '14' });
    t.textContent = 'No data';
    svg.appendChild(t);
    return;
  }

  // ── Dimensions ────────────────────────────────────────────────────────────
  const containerWidth = container.clientWidth || 400;
  // Aspect ratio: wider containers get a taller chart, but cap it
  const aspectRatio = containerWidth < 500 ? 0.55 : 0.45;
  const totalWidth  = containerWidth;
  const totalHeight = Math.max(180, Math.min(Math.round(totalWidth * aspectRatio), 340));

  // Margins — leave room for axis labels
  // Y-axis label width depends on max value
  const maxVal = Math.max(...data.map(d => d.visitors));
  const yMax   = niceMax(maxVal);
  const yLabelWidth = formatAxisValue(yMax).length * 7 + 4; // approx char width

  const margin = {
    top:    16,
    right:  16,
    bottom: 44, // room for x-axis labels
    left:   Math.max(40, yLabelWidth + 8),
  };

  const plotW = totalWidth  - margin.left - margin.right;
  const plotH = totalHeight - margin.top  - margin.bottom;

  svg.setAttribute('width',   totalWidth);
  svg.setAttribute('height',  totalHeight);
  svg.setAttribute('viewBox', `0 0 ${totalWidth} ${totalHeight}`);

  // ── Colors from CSS vars ──────────────────────────────────────────────────
  const colorLine  = cssVar('--chart-line');
  const colorArea  = cssVar('--chart-area');
  const colorGrid  = cssVar('--chart-grid');
  const colorAxis  = cssVar('--chart-axis');
  const colorLabel = cssVar('--chart-label');
  const colorDot   = cssVar('--chart-dot');
  const colorDotBg = cssVar('--chart-dot-bg');

  // ── Clip path ─────────────────────────────────────────────────────────────
  const clipId = 'chart-clip-' + Math.random().toString(36).slice(2, 7);
  const defs = svgEl('defs');
  const clipPath = svgEl('clipPath', { id: clipId });
  const clipRect = svgEl('rect', {
    x: 0, y: 0,
    width:  plotW,
    height: plotH,
  });
  clipPath.appendChild(clipRect);
  defs.appendChild(clipPath);
  svg.appendChild(defs);

  // ── Plot group (translated to margin) ────────────────────────────────────
  const g = svgEl('g', { transform: `translate(${margin.left},${margin.top})` });
  svg.appendChild(g);

  // ── Scales ────────────────────────────────────────────────────────────────
  const n = data.length;

  function xScale(i) {
    // Map index [0, n-1] to [0, plotW]
    return n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW;
  }

  function yScale(v) {
    // Map value [0, yMax] to [plotH, 0]
    return plotH - (v / yMax) * plotH;
  }

  // ── Y gridlines & labels ──────────────────────────────────────────────────
  const yTickCount = Math.min(5, Math.max(3, Math.floor(plotH / 50)));
  for (let t = 0; t <= yTickCount; t++) {
    const v  = (yMax / yTickCount) * t;
    const y  = yScale(v);

    // Gridline
    const line = svgEl('line', {
      x1: 0, y1: y, x2: plotW, y2: y,
      stroke: colorGrid,
      'stroke-width': t === 0 ? 1.5 : 1,
      'stroke-dasharray': t === 0 ? 'none' : '3 3',
    });
    g.appendChild(line);

    // Y label
    const label = svgEl('text', {
      x: -6,
      y: y,
      'text-anchor': 'end',
      'dominant-baseline': 'middle',
      fill: colorLabel,
      'font-size': '11',
      'font-family': 'system-ui, sans-serif',
    });
    label.textContent = formatAxisValue(Math.round(v));
    g.appendChild(label);
  }

  // ── X axis ticks & labels ─────────────────────────────────────────────────
  // Decide how many x labels to show based on available width
  const minTickSpacing = 48; // px between labels
  const maxTicks = Math.max(2, Math.floor(plotW / minTickSpacing));
  // Pick evenly spaced indices
  const step = Math.max(1, Math.ceil((n - 1) / (maxTicks - 1)));
  const xIndices = [];
  for (let i = 0; i < n; i += step) xIndices.push(i);
  if (xIndices[xIndices.length - 1] !== n - 1) xIndices.push(n - 1);

  // X axis baseline
  const xAxis = svgEl('line', {
    x1: 0, y1: plotH, x2: plotW, y2: plotH,
    stroke: colorAxis,
    'stroke-width': 1,
  });
  g.appendChild(xAxis);

  xIndices.forEach(i => {
    const x = xScale(i);

    // Tick mark
    const tick = svgEl('line', {
      x1: x, y1: plotH, x2: x, y2: plotH + 4,
      stroke: colorAxis,
      'stroke-width': 1,
    });
    g.appendChild(tick);

    // Label
    const label = svgEl('text', {
      x,
      y: plotH + 16,
      'text-anchor': 'middle',
      fill: colorLabel,
      'font-size': '10',
      'font-family': 'system-ui, sans-serif',
    });
    label.textContent = formatAxisDate(data[i].date);
    g.appendChild(label);
  });

  // ── Area fill ─────────────────────────────────────────────────────────────
  const areaPoints = data.map((d, i) => `${xScale(i)},${yScale(d.visitors)}`).join(' ');
  const areaPath = [
    `M 0,${plotH}`,
    ...data.map((d, i) => `L ${xScale(i)},${yScale(d.visitors)}`),
    `L ${xScale(n - 1)},${plotH}`,
    'Z',
  ].join(' ');

  const area = svgEl('path', {
    d: areaPath,
    fill: colorArea,
    'clip-path': `url(#${clipId})`,
  });
  g.appendChild(area);

  // ── Line ──────────────────────────────────────────────────────────────────
  const linePath = data.map((d, i) => `${i === 0 ? 'M' : 'L'} ${xScale(i)},${yScale(d.visitors)}`).join(' ');

  const line = svgEl('path', {
    d: linePath,
    fill: 'none',
    stroke: colorLine,
    'stroke-width': '2',
    'stroke-linejoin': 'round',
    'stroke-linecap': 'round',
    'clip-path': `url(#${clipId})`,
  });
  g.appendChild(line);

  // ── Dots (only if not too many points) ───────────────────────────────────
  const showDots = n <= 35;
  if (showDots) {
    data.forEach((d, i) => {
      const cx = xScale(i);
      const cy = yScale(d.visitors);

      // Outer dot (background)
      const outer = svgEl('circle', {
        cx, cy, r: 3.5,
        fill: colorDotBg,
        stroke: colorDot,
        'stroke-width': '2',
        'clip-path': `url(#${clipId})`,
      });
      g.appendChild(outer);
    });
  }

  // ── Y axis line ───────────────────────────────────────────────────────────
  const yAxisLine = svgEl('line', {
    x1: 0, y1: 0, x2: 0, y2: plotH,
    stroke: colorAxis,
    'stroke-width': 1,
  });
  g.appendChild(yAxisLine);
}
