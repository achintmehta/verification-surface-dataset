/**
 * Hand-drawn SVG time-series line chart.
 * Redraws to fit its container on every call to render().
 * Uses CSS custom properties for full theme support.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

function el(tag, attrs = {}) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    e.setAttribute(k, v);
  }
  return e;
}

function getCSSVar(name) {
  const fromRoot = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (fromRoot) return fromRoot;
  return getComputedStyle(document.body).getPropertyValue(name).trim();
}

function niceMax(value) {
  if (value <= 0) return 10;
  // Add 10% headroom then round up to a nice number
  const v = value * 1.08;
  const magnitude = Math.pow(10, Math.floor(Math.log10(v)));
  const normalized = v / magnitude;
  let nice;
  if (normalized <= 1)   nice = 1;
  else if (normalized <= 2)   nice = 2;
  else if (normalized <= 3)   nice = 3;
  else if (normalized <= 4)   nice = 4;
  else if (normalized <= 5)   nice = 5;
  else if (normalized <= 6)   nice = 6;
  else if (normalized <= 8)   nice = 8;
  else                        nice = 10;
  return nice * magnitude;
}

function formatDate(dateStr) {
  // dateStr may be "YYYY-MM-DD" or full ISO timestamp — use UTC
  const d = new Date(dateStr);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

function formatNum(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(Math.round(n));
}

// Smooth cubic bezier path through points
function smoothPath(points) {
  if (points.length < 2) return '';
  const tension = 0.2;
  let d = `M${points[0][0].toFixed(2)},${points[0][1].toFixed(2)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    const cp1x = p1[0] + (p2[0] - p0[0]) * tension;
    const cp1y = p1[1] + (p2[1] - p0[1]) * tension;
    const cp2x = p2[0] - (p3[0] - p1[0]) * tension;
    const cp2y = p2[1] - (p3[1] - p1[1]) * tension;
    d += ` C${cp1x.toFixed(2)},${cp1y.toFixed(2)} ${cp2x.toFixed(2)},${cp2y.toFixed(2)} ${p2[0].toFixed(2)},${p2[1].toFixed(2)}`;
  }
  return d;
}

export function renderChart(svgEl, data) {
  // Clear previous content
  while (svgEl.firstChild) svgEl.removeChild(svgEl.firstChild);

  if (!data || data.length === 0) return;

  // Measure container
  const container = svgEl.parentElement;
  const W = Math.max(container.clientWidth || 0, 200);
  const H = Math.max(container.clientHeight || 0, 180);

  svgEl.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svgEl.setAttribute('width', W);
  svgEl.setAttribute('height', H);

  // Read CSS variables for theming
  const colorGrid      = getCSSVar('--chart-grid')       || '#e2e8f0';
  const colorAxis      = getCSSVar('--chart-axis')       || '#cbd5e1';
  const colorLabel     = getCSSVar('--chart-label')      || '#64748b';
  const colorLine      = getCSSVar('--chart-line')       || '#4f6ef7';
  const colorFillStart = getCSSVar('--chart-fill-start') || 'rgba(79,110,247,0.18)';
  const colorFillEnd   = getCSSVar('--chart-fill-end')   || 'rgba(79,110,247,0.01)';
  const colorDot       = getCSSVar('--chart-dot')        || '#4f6ef7';
  const colorDotStroke = getCSSVar('--chart-dot-stroke') || '#ffffff';

  // Margins — tighter on small widths
  const isNarrow  = W < 380;
  const isMedium  = W < 600;
  const fontSize  = isNarrow ? 9 : isMedium ? 10 : 11;
  const margin = {
    top:    16,
    right:  isNarrow ? 10 : 18,
    bottom: isNarrow ? 38 : 44,
    left:   isNarrow ? 40 : isMedium ? 46 : 54,
  };

  const chartW = W - margin.left - margin.right;
  const chartH = H - margin.top - margin.bottom;

  if (chartW <= 0 || chartH <= 0) return;

  // Data extents
  const values = data.map(d => d.visitors);
  const maxVal = niceMax(Math.max(...values));
  const minVal = 0;

  // Scales
  const xScale = i => (i / (data.length - 1)) * chartW;
  const yScale = v => chartH - ((v - minVal) / (maxVal - minVal)) * chartH;

  // Unique gradient ID (avoid conflicts if multiple charts)
  const gradId = 'chart-area-grad';

  // Defs: gradient
  const defs = el('defs');
  const grad = el('linearGradient', {
    id: gradId,
    x1: '0', y1: '0', x2: '0', y2: '1',
  });
  const stop1 = el('stop', { offset: '0%',   'stop-color': colorFillStart });
  const stop2 = el('stop', { offset: '100%', 'stop-color': colorFillEnd });
  grad.appendChild(stop1);
  grad.appendChild(stop2);
  defs.appendChild(grad);
  svgEl.appendChild(defs);

  // Clip path to keep drawing inside chart area
  const clipId = 'chart-clip';
  const clipPath = el('clipPath', { id: clipId });
  clipPath.appendChild(el('rect', { x: 0, y: 0, width: chartW, height: chartH + 2 }));
  defs.appendChild(clipPath);

  // Group for chart area
  const g = el('g', { transform: `translate(${margin.left},${margin.top})` });

  // --- Y-axis gridlines & ticks ---
  // Generate nice round tick values between 0 and maxVal
  const yTickCount = Math.max(3, Math.min(6, Math.floor(chartH / 48)));
  const rawStep = maxVal / yTickCount;
  // Round step to a nice number
  const stepMag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const niceSteps = [1, 2, 2.5, 5, 10];
  let niceStep = stepMag;
  for (const ns of niceSteps) {
    if (ns * stepMag >= rawStep) { niceStep = ns * stepMag; break; }
  }
  const yTicks = [];
  for (let v = 0; v <= maxVal + niceStep * 0.01; v += niceStep) {
    yTicks.push(Math.round(v));
    if (yTicks.length > yTickCount + 2) break;
  }

  for (const tick of yTicks) {
    const y = yScale(tick);
    // Gridline
    g.appendChild(el('line', {
      x1: 0, y1: y.toFixed(1), x2: chartW, y2: y.toFixed(1),
      stroke: colorGrid,
      'stroke-width': 1,
      'stroke-dasharray': tick === 0 ? 'none' : '4 3',
    }));
    // Y label
    const label = el('text', {
      x: -8,
      y: y.toFixed(1),
      'text-anchor': 'end',
      'dominant-baseline': 'middle',
      fill: colorLabel,
      'font-size': fontSize,
      'font-family': 'inherit',
    });
    label.textContent = formatNum(tick);
    g.appendChild(label);
  }

  // --- X-axis ticks ---
  const maxXTicks = Math.max(3, Math.floor(chartW / (isNarrow ? 38 : 52)));
  const xTickStep = Math.max(1, Math.ceil((data.length - 1) / (maxXTicks - 1)));
  const xTickIndices = new Set();
  for (let i = 0; i < data.length; i += xTickStep) xTickIndices.add(i);
  xTickIndices.add(data.length - 1);

  for (const i of xTickIndices) {
    const x = xScale(i);
    g.appendChild(el('line', {
      x1: x.toFixed(1), y1: chartH, x2: x.toFixed(1), y2: chartH + 4,
      stroke: colorAxis,
      'stroke-width': 1,
    }));
    const label = el('text', {
      x: x.toFixed(1),
      y: chartH + (isNarrow ? 14 : 17),
      'text-anchor': 'middle',
      fill: colorLabel,
      'font-size': fontSize,
      'font-family': 'inherit',
    });
    label.textContent = formatDate(data[i].date);
    g.appendChild(label);
  }

  // --- Axes ---
  g.appendChild(el('line', {
    x1: 0, y1: 0, x2: 0, y2: chartH,
    stroke: colorAxis, 'stroke-width': 1,
  }));
  g.appendChild(el('line', {
    x1: 0, y1: chartH, x2: chartW, y2: chartH,
    stroke: colorAxis, 'stroke-width': 1,
  }));

  // --- Compute points ---
  const points = data.map((d, i) => [xScale(i), yScale(d.visitors)]);

  // --- Area fill (clipped) ---
  const lineD = smoothPath(points);
  const lastPt = points[points.length - 1];
  const firstPt = points[0];
  const areaD = lineD
    + ` L${lastPt[0].toFixed(2)},${chartH}`
    + ` L${firstPt[0].toFixed(2)},${chartH} Z`;

  const areaGroup = el('g', { 'clip-path': `url(#${clipId})` });
  areaGroup.appendChild(el('path', {
    d: areaD,
    fill: `url(#${gradId})`,
    stroke: 'none',
  }));

  // --- Line (clipped) ---
  areaGroup.appendChild(el('path', {
    d: lineD,
    fill: 'none',
    stroke: colorLine,
    'stroke-width': 2,
    'stroke-linejoin': 'round',
    'stroke-linecap': 'round',
  }));

  g.appendChild(areaGroup);

  // --- Dots (only on wider charts) ---
  if (data.length <= 35) {
    const dotR = isNarrow ? 0 : isMedium ? 2.5 : 3;
    if (dotR > 0) {
      for (const [x, y] of points) {
        g.appendChild(el('circle', {
          cx: x.toFixed(2),
          cy: y.toFixed(2),
          r: dotR,
          fill: colorDot,
          stroke: colorDotStroke,
          'stroke-width': 1.5,
        }));
      }
    }
  }

  svgEl.appendChild(g);
}
