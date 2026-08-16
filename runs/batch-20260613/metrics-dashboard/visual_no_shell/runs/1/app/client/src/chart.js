// ── Hand-drawn SVG time-series line chart ─────────────────────────────────────
// No external charting library. Draws axes, gridlines, ticks, and a filled
// area + line series. Re-renders on container resize via ResizeObserver.

const SVG_NS = 'http://www.w3.org/2000/svg';

let _data = [];          // cached series data
let _rafId = null;       // pending animation frame

// Padding (px) — enough room for Y-axis labels on the left and X-axis labels below
// Left padding shrinks on very narrow containers
function getPad(W) {
  return { top: 16, right: 12, bottom: 44, left: W < 300 ? 44 : 54 };
}

export function renderTimeseries(data) {
  _data = data;
  drawChart();

  // Resize observer — redraws when the container changes width
  const container = document.getElementById('timeseries-container');
  if (!container) return;

  const ro = new ResizeObserver(() => {
    if (_rafId) cancelAnimationFrame(_rafId);
    _rafId = requestAnimationFrame(drawChart);
  });
  ro.observe(container);

  // Also redraw when theme changes
  window.addEventListener('themechange', drawChart);
}

function drawChart() {
  const svg = document.getElementById('timeseries-svg');
  if (!svg) return;

  // Measure the SVG's rendered size
  const rect = svg.getBoundingClientRect();
  const W = rect.width  || svg.parentElement?.clientWidth  || 400;
  const H = rect.height || 240;

  if (W < 10 || H < 10) return;

  const PAD = getPad(W);

  // Clear previous content
  while (svg.firstChild) svg.removeChild(svg.firstChild);

  // Set explicit viewBox so SVG coordinates match CSS pixels
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width',  W);
  svg.setAttribute('height', H);

  if (!_data || _data.length === 0) {
    appendText(svg, W / 2, H / 2, 'No data', {
      'text-anchor': 'middle', 'dominant-baseline': 'middle',
      fill: cssVar('--chart-axis'), 'font-size': '14',
    });
    return;
  }

  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top  - PAD.bottom;

  // ── Data extents ──────────────────────────────────────────────────────────
  const values   = _data.map(d => d.visitors);
  const rawMin   = Math.min(...values);
  const rawMax   = Math.max(...values);
  const padding  = (rawMax - rawMin) * 0.1 || 100;
  const yMin     = Math.max(0, rawMin - padding);
  const yMax     = rawMax + padding;

  // ── Scale helpers ─────────────────────────────────────────────────────────
  const xScale = i => PAD.left + (i / (_data.length - 1)) * plotW;
  const yScale = v => PAD.top  + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

  // ── Gridlines & Y-axis ticks ──────────────────────────────────────────────
  const yTicks = niceTicks(yMin, yMax, 5);
  const gridColor = cssVar('--chart-grid');
  const axisColor = cssVar('--chart-axis');
  const yFontSize = W < 320 ? '10' : '11';

  yTicks.forEach(tick => {
    const y = yScale(tick);
    // Gridline
    appendLine(svg, PAD.left, y, PAD.left + plotW, y, {
      stroke: gridColor, 'stroke-width': '1', 'stroke-dasharray': '4 3',
    });
    // Y-axis label
    appendText(svg, PAD.left - 5, y, formatK(tick), {
      'text-anchor': 'end', 'dominant-baseline': 'middle',
      fill: axisColor, 'font-size': yFontSize,
    });
  });

  // ── X-axis ticks — adapt count to available width ────────────────────────
  // Each label needs ~52px minimum; ensure we never crowd them
  const maxXTicks  = Math.max(2, Math.floor(plotW / 52));
  const xTickCount = Math.min(maxXTicks, _data.length);
  const xFontSize  = W < 320 ? '10' : '11';

  // Build a set of indices to label (evenly spaced, always include last)
  const labelIndices = new Set();
  if (xTickCount >= 2) {
    for (let t = 0; t < xTickCount; t++) {
      labelIndices.add(Math.round(t * (_data.length - 1) / (xTickCount - 1)));
    }
  } else {
    labelIndices.add(0);
  }
  labelIndices.add(_data.length - 1);

  labelIndices.forEach(i => {
    const x   = xScale(i);
    const lbl = formatDate(_data[i].date);
    appendLine(svg, x, PAD.top + plotH, x, PAD.top + plotH + 4, {
      stroke: axisColor, 'stroke-width': '1',
    });
    appendText(svg, x, PAD.top + plotH + 14, lbl, {
      'text-anchor': 'middle', 'dominant-baseline': 'hanging',
      fill: axisColor, 'font-size': xFontSize,
    });
  });

  // ── Axis lines ────────────────────────────────────────────────────────────
  // Y-axis
  appendLine(svg, PAD.left, PAD.top, PAD.left, PAD.top + plotH, {
    stroke: axisColor, 'stroke-width': '1.5',
  });
  // X-axis
  appendLine(svg, PAD.left, PAD.top + plotH, PAD.left + plotW, PAD.top + plotH, {
    stroke: axisColor, 'stroke-width': '1.5',
  });

  // ── Filled area ───────────────────────────────────────────────────────────
  const points = _data.map((d, i) => [xScale(i), yScale(d.visitors)]);
  const lineD  = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const areaD  = lineD
    + ` L${points[points.length - 1][0].toFixed(1)},${(PAD.top + plotH).toFixed(1)}`
    + ` L${points[0][0].toFixed(1)},${(PAD.top + plotH).toFixed(1)} Z`;

  // Gradient definition
  const defs = document.createElementNS(SVG_NS, 'defs');
  const grad = document.createElementNS(SVG_NS, 'linearGradient');
  grad.setAttribute('id', 'area-gradient');
  grad.setAttribute('x1', '0'); grad.setAttribute('y1', '0');
  grad.setAttribute('x2', '0'); grad.setAttribute('y2', '1');
  const stop1 = document.createElementNS(SVG_NS, 'stop');
  stop1.setAttribute('offset', '0%');
  stop1.setAttribute('stop-color', cssVar('--chart-line'));
  stop1.setAttribute('stop-opacity', '0.25');
  const stop2 = document.createElementNS(SVG_NS, 'stop');
  stop2.setAttribute('offset', '100%');
  stop2.setAttribute('stop-color', cssVar('--chart-line'));
  stop2.setAttribute('stop-opacity', '0.02');
  grad.appendChild(stop1);
  grad.appendChild(stop2);
  defs.appendChild(grad);
  svg.appendChild(defs);

  // Clip path so nothing draws outside the plot area
  const clipId = 'plot-clip';
  const clipPath = document.createElementNS(SVG_NS, 'clipPath');
  clipPath.setAttribute('id', clipId);
  const clipRect = document.createElementNS(SVG_NS, 'rect');
  clipRect.setAttribute('x', PAD.left);
  clipRect.setAttribute('y', PAD.top);
  clipRect.setAttribute('width', plotW);
  clipRect.setAttribute('height', plotH);
  clipPath.appendChild(clipRect);
  defs.appendChild(clipPath);

  const areaPath = document.createElementNS(SVG_NS, 'path');
  areaPath.setAttribute('d', areaD);
  areaPath.setAttribute('fill', 'url(#area-gradient)');
  areaPath.setAttribute('clip-path', `url(#${clipId})`);
  svg.appendChild(areaPath);

  // ── Line ──────────────────────────────────────────────────────────────────
  const linePath = document.createElementNS(SVG_NS, 'path');
  linePath.setAttribute('d', lineD);
  linePath.setAttribute('fill', 'none');
  linePath.setAttribute('stroke', cssVar('--chart-line'));
  linePath.setAttribute('stroke-width', '2');
  linePath.setAttribute('stroke-linejoin', 'round');
  linePath.setAttribute('stroke-linecap', 'round');
  linePath.setAttribute('clip-path', `url(#${clipId})`);
  svg.appendChild(linePath);

  // ── Dots (only if there's enough room) ───────────────────────────────────
  if (plotW / _data.length > 8) {
    points.forEach(([cx, cy]) => {
      const circle = document.createElementNS(SVG_NS, 'circle');
      circle.setAttribute('cx', cx.toFixed(1));
      circle.setAttribute('cy', cy.toFixed(1));
      circle.setAttribute('r', '3');
      circle.setAttribute('fill', cssVar('--chart-dot-bg'));
      circle.setAttribute('stroke', cssVar('--chart-dot'));
      circle.setAttribute('stroke-width', '2');
      svg.appendChild(circle);
    });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function appendLine(parent, x1, y1, x2, y2, attrs) {
  const el = document.createElementNS(SVG_NS, 'line');
  el.setAttribute('x1', x1.toFixed(1));
  el.setAttribute('y1', y1.toFixed(1));
  el.setAttribute('x2', x2.toFixed(1));
  el.setAttribute('y2', y2.toFixed(1));
  Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
  parent.appendChild(el);
  return el;
}

function appendText(parent, x, y, text, attrs) {
  const el = document.createElementNS(SVG_NS, 'text');
  el.setAttribute('x', x.toFixed(1));
  el.setAttribute('y', y.toFixed(1));
  el.textContent = text;
  Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
  parent.appendChild(el);
  return el;
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function formatK(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

function formatDate(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * Generate ~n "nice" tick values between lo and hi.
 */
function niceTicks(lo, hi, n) {
  const range  = hi - lo;
  const rough  = range / n;
  const mag    = Math.pow(10, Math.floor(Math.log10(rough)));
  const nice   = [1, 2, 2.5, 5, 10].find(f => f * mag >= rough) * mag;
  const start  = Math.ceil(lo / nice) * nice;
  const ticks  = [];
  for (let t = start; t <= hi + nice * 0.01; t += nice) {
    ticks.push(Math.round(t * 1e6) / 1e6);
  }
  return ticks;
}
