/**
 * Hand-drawn SVG time-series line chart.
 *
 * Draws into `container` (a DOM element) by creating/replacing an <svg>.
 * Reads CSS custom properties for colours so it automatically respects
 * the current light/dark theme.
 *
 * Layout:
 *   - Left margin: Y-axis labels
 *   - Bottom margin: X-axis labels
 *   - Top/right margin: breathing room
 *   - Plot area: gridlines + area fill + line + dots
 */

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export function drawChart(container, data) {
  if (!data || data.length === 0) return;

  // Measure container
  const W = container.clientWidth  || 600;
  const H = container.clientHeight || 260;

  // Margins — scale with container width so labels fit at narrow widths
  const marginLeft   = Math.max(44, Math.min(64, W * 0.1));
  const marginRight  = 16;
  const marginTop    = 16;
  const marginBottom = Math.max(32, Math.min(44, H * 0.18));

  const plotW = W - marginLeft - marginRight;
  const plotH = H - marginTop  - marginBottom;

  if (plotW <= 0 || plotH <= 0) return;

  // Read theme colours from CSS custom properties
  const style = getComputedStyle(document.documentElement);
  const clrLine    = style.getPropertyValue('--chart-line').trim()    || '#3b82f6';
  const clrArea    = style.getPropertyValue('--chart-area').trim()    || 'rgba(59,130,246,0.12)';
  const clrGrid    = style.getPropertyValue('--chart-grid').trim()    || '#e2e8f0';
  const clrAxis    = style.getPropertyValue('--chart-axis').trim()    || '#94a3b8';
  const clrDot     = style.getPropertyValue('--chart-dot').trim()     || '#3b82f6';
  const clrDotBg   = style.getPropertyValue('--chart-dot-bg').trim()  || '#ffffff';

  // Data
  const visitors = data.map(d => Number(d.visitors));
  const dates    = data.map(d => d.date);
  const n        = visitors.length;

  const minV = Math.min(...visitors);
  const maxV = Math.max(...visitors);

  // Nice Y axis
  const { niceMin, niceMax, ticks: yTicks } = niceScale(minV, maxV, 5);

  // Scales
  function scaleX(i) {
    return marginLeft + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  }
  function scaleY(v) {
    return marginTop + plotH - ((v - niceMin) / (niceMax - niceMin)) * plotH;
  }

  // X-axis ticks — show ~6 evenly spaced labels, always include first & last
  const xTickIndices = pickXTicks(n, W);

  // ---------------------------------------------------------------------------
  // Build SVG
  // ---------------------------------------------------------------------------
  const svg = createSVG('svg', {
    viewBox: `0 0 ${W} ${H}`,
    width: W,
    height: H,
    'aria-hidden': 'true',
    style: 'display:block;overflow:visible',
  });

  // Clip path so the series line/area never draws outside the plot area
  const clipId = 'chart-clip-' + Math.random().toString(36).slice(2, 7);
  const defs = createSVG('defs');
  const clipPath = createSVG('clipPath', { id: clipId });
  clipPath.appendChild(createSVG('rect', {
    x: marginLeft, y: marginTop, width: plotW, height: plotH,
  }));
  defs.appendChild(clipPath);
  svg.appendChild(defs);

  // --- Gridlines (horizontal, one per Y tick) ---
  const gridGroup = createSVG('g', { class: 'chart-gridlines' });
  for (const tick of yTicks) {
    const y = scaleY(tick);
    gridGroup.appendChild(createSVG('line', {
      x1: marginLeft, y1: y, x2: marginLeft + plotW, y2: y,
      stroke: clrGrid, 'stroke-width': 1,
      'stroke-dasharray': tick === 0 ? 'none' : '4 3',
    }));
  }
  svg.appendChild(gridGroup);

  // --- Y-axis labels ---
  const yLabelGroup = createSVG('g', { class: 'chart-y-labels' });
  for (const tick of yTicks) {
    const y = scaleY(tick);
    const label = fmtAxisNum(tick);
    const text = createSVG('text', {
      x: marginLeft - 6,
      y: y,
      'text-anchor': 'end',
      'dominant-baseline': 'middle',
      fill: clrAxis,
      'font-size': Math.max(9, Math.min(11, W * 0.018)),
      'font-family': 'inherit',
    });
    text.textContent = label;
    yLabelGroup.appendChild(text);
  }
  svg.appendChild(yLabelGroup);

  // --- Area fill (clipped) ---
  const areaPoints = buildAreaPath(visitors, scaleX, scaleY, marginTop + plotH);
  const areaPath = createSVG('path', {
    d: areaPoints,
    fill: clrArea,
    stroke: 'none',
    'clip-path': `url(#${clipId})`,
  });
  svg.appendChild(areaPath);

  // --- Series line (clipped) ---
  const linePoints = buildLinePath(visitors, scaleX, scaleY);
  const linePath = createSVG('path', {
    d: linePoints,
    fill: 'none',
    stroke: clrLine,
    'stroke-width': 2,
    'stroke-linejoin': 'round',
    'stroke-linecap': 'round',
    'clip-path': `url(#${clipId})`,
  });
  svg.appendChild(linePath);

  // --- Dots at each data point (clipped) ---
  const dotGroup = createSVG('g', { 'clip-path': `url(#${clipId})` });
  const dotR = Math.max(2, Math.min(3.5, plotW / n / 2));
  // Only draw dots if they won't overlap (spacing > 2*r*3)
  const spacing = n > 1 ? plotW / (n - 1) : plotW;
  const showDots = spacing > dotR * 6;
  if (showDots) {
    for (let i = 0; i < n; i++) {
      dotGroup.appendChild(createSVG('circle', {
        cx: scaleX(i), cy: scaleY(visitors[i]),
        r: dotR,
        fill: clrDotBg,
        stroke: clrDot,
        'stroke-width': 1.5,
      }));
    }
  }
  svg.appendChild(dotGroup);

  // --- X-axis baseline ---
  svg.appendChild(createSVG('line', {
    x1: marginLeft, y1: marginTop + plotH,
    x2: marginLeft + plotW, y2: marginTop + plotH,
    stroke: clrGrid, 'stroke-width': 1,
  }));

  // --- Y-axis baseline ---
  svg.appendChild(createSVG('line', {
    x1: marginLeft, y1: marginTop,
    x2: marginLeft, y2: marginTop + plotH,
    stroke: clrGrid, 'stroke-width': 1,
  }));

  // --- X-axis labels ---
  const xLabelGroup = createSVG('g', { class: 'chart-x-labels' });
  const xFontSize = Math.max(9, Math.min(11, W * 0.018));
  for (const i of xTickIndices) {
    const x = scaleX(i);
    const label = fmtAxisDate(dates[i]);
    const text = createSVG('text', {
      x,
      y: marginTop + plotH + 14,
      'text-anchor': 'middle',
      'dominant-baseline': 'auto',
      fill: clrAxis,
      'font-size': xFontSize,
      'font-family': 'inherit',
    });
    text.textContent = label;
    xLabelGroup.appendChild(text);
  }
  svg.appendChild(xLabelGroup);

  // Replace existing SVG (or append)
  const existing = container.querySelector('svg');
  if (existing) {
    container.replaceChild(svg, existing);
  } else {
    container.appendChild(svg);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create an SVG element with attributes */
function createSVG(tag, attrs = {}) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, v);
  }
  return el;
}

/** Build SVG path "d" for the line */
function buildLinePath(values, scaleX, scaleY) {
  return values.map((v, i) => {
    const x = scaleX(i).toFixed(2);
    const y = scaleY(v).toFixed(2);
    return i === 0 ? `M${x},${y}` : `L${x},${y}`;
  }).join(' ');
}

/** Build SVG path "d" for the filled area under the line */
function buildAreaPath(values, scaleX, scaleY, baselineY) {
  const n = values.length;
  if (n === 0) return '';
  const line = buildLinePath(values, scaleX, scaleY);
  const lastX = scaleX(n - 1).toFixed(2);
  const firstX = scaleX(0).toFixed(2);
  return `${line} L${lastX},${baselineY.toFixed(2)} L${firstX},${baselineY.toFixed(2)} Z`;
}

/**
 * Compute a "nice" scale for the Y axis.
 * Returns { niceMin, niceMax, ticks[] }
 */
function niceScale(dataMin, dataMax, targetTicks = 5) {
  if (dataMin === dataMax) {
    dataMin = dataMin * 0.9;
    dataMax = dataMax * 1.1 + 1;
  }
  const range = dataMax - dataMin;
  const roughStep = range / (targetTicks - 1);
  const magnitude = Math.pow(10, Math.floor(Math.log10(roughStep)));
  const residual = roughStep / magnitude;
  let niceStep;
  if      (residual <= 1)   niceStep = 1   * magnitude;
  else if (residual <= 2)   niceStep = 2   * magnitude;
  else if (residual <= 2.5) niceStep = 2.5 * magnitude;
  else if (residual <= 5)   niceStep = 5   * magnitude;
  else                      niceStep = 10  * magnitude;

  const niceMin = Math.floor(dataMin / niceStep) * niceStep;
  const niceMax = Math.ceil(dataMax  / niceStep) * niceStep;

  const ticks = [];
  for (let t = niceMin; t <= niceMax + niceStep * 0.001; t += niceStep) {
    ticks.push(Math.round(t * 1e9) / 1e9); // floating-point cleanup
  }

  return { niceMin, niceMax, ticks };
}

/**
 * Pick ~6 evenly-spaced X-axis tick indices, always including 0 and n-1.
 * Reduces count if the container is narrow.
 */
function pickXTicks(n, containerWidth) {
  if (n === 0) return [];
  if (n === 1) return [0];

  // How many labels can we fit? Assume ~40px per label minimum
  const maxLabels = Math.max(2, Math.floor(containerWidth / 50));
  const count = Math.min(maxLabels, 6, n);

  const indices = new Set([0, n - 1]);
  if (count <= 2) return [...indices].sort((a, b) => a - b);

  const step = (n - 1) / (count - 1);
  for (let i = 1; i < count - 1; i++) {
    indices.add(Math.round(i * step));
  }
  return [...indices].sort((a, b) => a - b);
}

/** Format a number for the Y axis (e.g. 1500 → "1.5k") */
function fmtAxisNum(n) {
  if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (Math.abs(n) >= 1_000)     return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(Math.round(n));
}

/** Format a date string for the X axis (e.g. "Jan 5") */
function fmtAxisDate(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
