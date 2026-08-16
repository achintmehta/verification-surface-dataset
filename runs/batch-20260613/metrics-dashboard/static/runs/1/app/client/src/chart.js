/**
 * Hand-drawn SVG time-series line chart.
 *
 * Responsibilities:
 *  - Render a 30-day revenue line chart into a container element.
 *  - Redraw on container resize via ResizeObserver.
 *  - Respect the current CSS theme variables for all colors.
 *  - Never overflow its container; all axes, labels, and the series
 *    are clipped to the chart area.
 */

import { formatDate } from './utils/format.js';

/** Read a CSS custom property from :root as a string. */
function cssVar(name) {
  return getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
}

/**
 * Compute "nice" tick values for a given data range.
 * Returns an array of ~5 evenly-spaced round numbers.
 */
function niceTicks(min, max, count = 5) {
  const range = max - min || 1;
  const rawStep = range / (count - 1);
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const niceSteps = [1, 2, 2.5, 5, 10];
  let step = magnitude;
  for (const s of niceSteps) {
    if (s * magnitude >= rawStep) { step = s * magnitude; break; }
  }
  const niceMin = Math.floor(min / step) * step;
  const ticks = [];
  for (let i = 0; i < count + 2; i++) {
    const v = niceMin + i * step;
    if (v > max + step) break;
    ticks.push(v);
  }
  // Keep only ticks within [niceMin, max + step]
  return ticks.filter(t => t >= niceMin && t <= max + step * 0.5);
}

/**
 * SVG namespace helper.
 */
function svgEl(tag, attrs = {}) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, v);
  }
  return el;
}

/**
 * Draw the chart into `container`.
 * @param {HTMLElement} container
 * @param {Array<{date: string, revenue: number}>} data
 */
function drawChart(container, data) {
  if (!data || data.length === 0) return;

  const W = container.clientWidth;
  const H = container.clientHeight;
  if (W === 0 || H === 0) return;

  // ── Margins ──────────────────────────────────────────────────────────────
  // Left margin must accommodate Y-axis labels (currency).
  // Bottom margin must accommodate X-axis labels (dates).
  const MARGIN = {
    top:    16,
    right:  16,
    bottom: 40,
    left:   W < 400 ? 52 : 68,
  };

  const plotW = W - MARGIN.left - MARGIN.right;
  const plotH = H - MARGIN.top  - MARGIN.bottom;

  if (plotW <= 0 || plotH <= 0) return;

  // ── Data extents ─────────────────────────────────────────────────────────
  const revenues = data.map(d => d.revenue);
  const dataMin  = Math.min(...revenues);
  const dataMax  = Math.max(...revenues);

  // Pad the range so the line doesn't touch the very top/bottom
  const pad   = (dataMax - dataMin) * 0.1 || 50;
  const yMin  = Math.max(0, dataMin - pad);
  const yMax  = dataMax + pad;

  // ── Scales ───────────────────────────────────────────────────────────────
  const xScale = (i) => (i / (data.length - 1)) * plotW;
  const yScale = (v) => plotH - ((v - yMin) / (yMax - yMin)) * plotH;

  // ── Colors from CSS vars ─────────────────────────────────────────────────
  const colorLine   = cssVar('--color-chart-line');
  const colorFill   = cssVar('--color-chart-fill');
  const colorGrid   = cssVar('--color-chart-grid');
  const colorAxis   = cssVar('--color-chart-axis');
  const colorLabel  = cssVar('--color-chart-label');
  const colorDot    = cssVar('--color-chart-dot');
  const colorSurface = cssVar('--color-surface');

  // ── Build SVG ────────────────────────────────────────────────────────────
  const svg = svgEl('svg', {
    width:   W,
    height:  H,
    viewBox: `0 0 ${W} ${H}`,
    'aria-hidden': 'true',
  });

  // Clip path so nothing draws outside the plot area
  const clipId = 'chart-clip';
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

  // Plot group — everything inside is offset by margins
  const g = svgEl('g', {
    transform: `translate(${MARGIN.left},${MARGIN.top})`,
  });
  svg.appendChild(g);

  // ── Y-axis ticks & gridlines ─────────────────────────────────────────────
  const yTicks = niceTicks(yMin, yMax, 5);
  const labelFontSize = W < 400 ? 9 : 11;

  for (const tick of yTicks) {
    const y = yScale(tick);
    if (y < -1 || y > plotH + 1) continue;

    // Gridline
    const line = svgEl('line', {
      x1: 0, y1: y, x2: plotW, y2: y,
      stroke: colorGrid,
      'stroke-width': 1,
      'stroke-dasharray': '3 3',
    });
    g.appendChild(line);

    // Y label
    const label = svgEl('text', {
      x: -8,
      y: y,
      'text-anchor': 'end',
      'dominant-baseline': 'middle',
      fill: colorLabel,
      'font-size': labelFontSize,
      'font-family': 'system-ui, sans-serif',
    });
    // Compact currency: $1.2k, $10k, etc.
    const absVal = Math.abs(tick);
    let labelText;
    if (absVal >= 1000) {
      labelText = '$' + (tick / 1000).toFixed(absVal >= 10000 ? 0 : 1) + 'k';
    } else {
      labelText = '$' + tick.toFixed(0);
    }
    label.textContent = labelText;
    g.appendChild(label);
  }

  // ── X-axis ticks ─────────────────────────────────────────────────────────
  // Show ~6 evenly-spaced date labels, always including first and last.
  const maxXLabels = W < 400 ? 4 : W < 700 ? 5 : 7;
  const xIndices = [];
  xIndices.push(0);
  const step = Math.floor((data.length - 1) / (maxXLabels - 1));
  for (let i = step; i < data.length - 1; i += step) {
    xIndices.push(i);
  }
  xIndices.push(data.length - 1);
  // Deduplicate
  const uniqueXIndices = [...new Set(xIndices)];

  for (const idx of uniqueXIndices) {
    const x = xScale(idx);
    const dateStr = data[idx].date;
    const label = svgEl('text', {
      x,
      y: plotH + 24,
      'text-anchor': 'middle',
      fill: colorLabel,
      'font-size': labelFontSize,
      'font-family': 'system-ui, sans-serif',
    });
    label.textContent = formatDate(dateStr);
    g.appendChild(label);

    // Tick mark
    const tick = svgEl('line', {
      x1: x, y1: plotH, x2: x, y2: plotH + 5,
      stroke: colorAxis,
      'stroke-width': 1,
    });
    g.appendChild(tick);
  }

  // ── Axes ─────────────────────────────────────────────────────────────────
  // X axis
  const xAxis = svgEl('line', {
    x1: 0, y1: plotH, x2: plotW, y2: plotH,
    stroke: colorAxis,
    'stroke-width': 1.5,
  });
  g.appendChild(xAxis);

  // Y axis
  const yAxis = svgEl('line', {
    x1: 0, y1: 0, x2: 0, y2: plotH,
    stroke: colorAxis,
    'stroke-width': 1.5,
  });
  g.appendChild(yAxis);

  // ── Series path (area + line) ─────────────────────────────────────────────
  // Build path data
  const points = data.map((d, i) => [xScale(i), yScale(d.revenue)]);

  // Area path: line + close to bottom
  const areaD = [
    `M ${points[0][0]} ${plotH}`,
    `L ${points[0][0]} ${points[0][1]}`,
    ...points.slice(1).map(([x, y]) => `L ${x} ${y}`),
    `L ${points[points.length - 1][0]} ${plotH}`,
    'Z',
  ].join(' ');

  const area = svgEl('path', {
    d: areaD,
    fill: colorFill,
    'clip-path': `url(#${clipId})`,
  });
  g.appendChild(area);

  // Line path
  const lineD = [
    `M ${points[0][0]} ${points[0][1]}`,
    ...points.slice(1).map(([x, y]) => `L ${x} ${y}`),
  ].join(' ');

  const line = svgEl('path', {
    d: lineD,
    stroke: colorLine,
    'stroke-width': 2.5,
    fill: 'none',
    'stroke-linejoin': 'round',
    'stroke-linecap': 'round',
    'clip-path': `url(#${clipId})`,
  });
  g.appendChild(line);

  // ── Dots at each data point ───────────────────────────────────────────────
  // Only draw dots if there's enough space (avoid clutter on narrow screens)
  const dotRadius = W < 500 ? 0 : 3; // hide dots on very narrow
  if (dotRadius > 0) {
    for (const [x, y] of points) {
      const dot = svgEl('circle', {
        cx: x, cy: y, r: dotRadius,
        fill: colorDot,
        stroke: colorSurface,
        'stroke-width': 1.5,
        'clip-path': `url(#${clipId})`,
      });
      g.appendChild(dot);
    }
  }

  // ── Replace existing SVG ─────────────────────────────────────────────────
  container.innerHTML = '';
  container.appendChild(svg);
}

/**
 * Initialize the chart with resize handling.
 * @param {HTMLElement} container
 * @param {Array} data
 * @returns {{ destroy: () => void }}
 */
export function initChart(container, data) {
  let rafId = null;

  function render() {
    rafId = null;
    drawChart(container, data);
  }

  function scheduleRender() {
    if (rafId !== null) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(render);
  }

  // Initial draw
  scheduleRender();

  // Redraw on resize
  const ro = new ResizeObserver(() => {
    scheduleRender();
  });
  ro.observe(container);

  return {
    destroy() {
      ro.disconnect();
      if (rafId !== null) cancelAnimationFrame(rafId);
    },
    /** Call when theme changes to redraw with new CSS vars. */
    redraw() {
      scheduleRender();
    },
  };
}
