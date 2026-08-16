/**
 * Hand-drawn SVG time-series line chart.
 *
 * Features:
 *  - Reads CSS custom properties for all colours → theme-aware
 *  - Redraws to fit its container on every call (called by ResizeObserver)
 *  - Draws: area fill, series line, X/Y axes, horizontal gridlines,
 *    X-axis date ticks, Y-axis value ticks with nice rounding
 *  - Clip-path keeps all series drawing inside the plot area
 *  - Dot on the last data point
 *  - Handles edge cases: empty data, single point, zero values
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/* ------------------------------------------------------------------ */
/*  SVG element factory (internal alias — see make() below)            */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  Read a CSS custom property from the body element                   */
/* ------------------------------------------------------------------ */
function cssVar(name) {
  return getComputedStyle(document.body).getPropertyValue(name).trim();
}

/* ------------------------------------------------------------------ */
/*  Axis helpers                                                        */
/* ------------------------------------------------------------------ */

/**
 * Round a raw maximum up to a "nice" number so axis ticks land on
 * round values (1k, 2.5k, 5k, 10k …).
 */
function niceMax(value) {
  if (value <= 0) return 10;
  const exp    = Math.floor(Math.log10(value));
  const factor = Math.pow(10, exp);
  const norm   = value / factor;
  let nice;
  if      (norm <= 1)   nice = 1;
  else if (norm <= 2)   nice = 2;
  else if (norm <= 2.5) nice = 2.5;
  else if (norm <= 5)   nice = 5;
  else                  nice = 10;
  return nice * factor;
}

/** Compact number format for Y-axis tick labels */
function fmtAxisVal(v) {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000)     return `${(v / 1_000).toFixed(0)}k`;
  return String(Math.round(v));
}

/** Short date label for X-axis ticks: "Jan 1" */
function fmtAxisDate(dateStr) {
  // Append time to avoid UTC-vs-local shift on date-only strings
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/* ------------------------------------------------------------------ */
/*  Main render function                                                */
/* ------------------------------------------------------------------ */

/**
 * Render (or re-render) the time-series chart into `svg`.
 *
 * @param {SVGSVGElement}  svg          - The <svg> element to draw into
 * @param {HTMLElement}    containerEl  - The container whose size we measure
 * @param {Array}          data         - Array of { date, visitors, revenue }
 */
export function renderChart(svg, containerEl, data) {
  // ── Clear previous render ──────────────────────────────────────────
  while (svg.firstChild) svg.removeChild(svg.firstChild);

  // ── Guard: no data ─────────────────────────────────────────────────
  if (!data || data.length === 0) {
    svg.appendChild(makeNoData());
    return;
  }

  // ── Measure container ──────────────────────────────────────────────
  // getBoundingClientRect gives the rendered size even before layout settles
  const rect = containerEl.getBoundingClientRect();
  const W = Math.max(rect.width  || containerEl.clientWidth  || 600, 100);
  const H = Math.max(rect.height || containerEl.clientHeight || 260, 80);

  // ── Margins ────────────────────────────────────────────────────────
  // Adapt left margin to available width so Y labels don't crowd on mobile
  const leftMargin = W < 300 ? 38 : 52;
  const margin = {
    top:    14,
    right:  14,
    bottom: 42,
    left:   leftMargin,
  };

  const plotW = Math.max(W - margin.left - margin.right, 10);
  const plotH = Math.max(H - margin.top  - margin.bottom, 10);

  // ── Set SVG dimensions ─────────────────────────────────────────────
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width',   W);
  svg.setAttribute('height',  H);
  // Clip at the SVG boundary — overflow:hidden on the container handles the rest
  svg.setAttribute('overflow', 'hidden');

  // ── Data extents ───────────────────────────────────────────────────
  const values = data.map(d => Number(d.visitors));
  const rawMax = Math.max(...values, 1);
  const yMax   = niceMax(rawMax * 1.08);   // 8% headroom
  const yMin   = 0;
  const n      = data.length;

  // ── Scale functions ────────────────────────────────────────────────
  // Guard against n===1 (single point → place it in the centre)
  const xScale = i => margin.left + (n > 1 ? (i / (n - 1)) * plotW : plotW / 2);
  const yScale = v  => margin.top  + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

  // ── Clip path ──────────────────────────────────────────────────────
  const clipId = 'chart-plot-clip';
  const defs   = make('defs');
  const clip   = make('clipPath', { id: clipId });
  clip.appendChild(make('rect', {
    x: margin.left, y: margin.top,
    width: plotW,   height: plotH,
  }));
  defs.appendChild(clip);
  svg.appendChild(defs);

  // ── Colours from CSS custom properties ────────────────────────────
  const colGrid    = cssVar('--color-chart-grid');
  const colAxis    = cssVar('--color-chart-axis');
  const colLine    = cssVar('--color-chart-line');
  const colFill    = cssVar('--color-chart-fill');
  const colSurface = cssVar('--color-surface');

  // ── Y-axis gridlines + tick labels ────────────────────────────────
  const Y_TICKS = 5;
  for (let ti = 0; ti <= Y_TICKS; ti++) {
    const v  = yMin + (ti / Y_TICKS) * (yMax - yMin);
    const cy = yScale(v);

    // Gridline (solid baseline, dashed for the rest)
    svg.appendChild(make('line', {
      x1: margin.left,
      y1: cy,
      x2: margin.left + plotW,
      y2: cy,
      stroke: colGrid,
      'stroke-width': '1',
      'stroke-dasharray': ti === 0 ? '0' : '4 3',
    }));

    // Tick label
    svg.appendChild(make('text', {
      x: margin.left - 6,
      y: cy,
      'text-anchor': 'end',
      'dominant-baseline': 'middle',
      fill: colAxis,
      'font-family': 'system-ui, sans-serif',
      'font-size': W < 300 ? '9' : '11',
    }, fmtAxisVal(v)));
  }

  // ── X-axis tick labels ────────────────────────────────────────────
  // Determine how many ticks fit without overlapping (~55px per label)
  const maxXTicks = Math.max(2, Math.floor(plotW / 55));
  const xTickCount = Math.min(maxXTicks, n);
  const xTickIndices = new Set([0, n - 1]);
  if (xTickCount > 2) {
    const step = (n - 1) / (xTickCount - 1);
    for (let t = 1; t < xTickCount - 1; t++) {
      xTickIndices.add(Math.round(t * step));
    }
  }

  for (const i of xTickIndices) {
    const cx    = xScale(i);
    const label = fmtAxisDate(data[i].date);

    // Tick mark
    svg.appendChild(make('line', {
      x1: cx, y1: margin.top + plotH,
      x2: cx, y2: margin.top + plotH + 4,
      stroke: colAxis, 'stroke-width': '1',
    }));

    // Label — anchor first to 'start', last to 'end', others to 'middle'
    const anchor = i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle';
    svg.appendChild(make('text', {
      x: cx,
      y: margin.top + plotH + 16,
      'text-anchor': anchor,
      'dominant-baseline': 'hanging',
      fill: colAxis,
      'font-family': 'system-ui, sans-serif',
      'font-size': W < 300 ? '9' : '11',
    }, label));
  }

  // ── Axes ──────────────────────────────────────────────────────────
  // Y-axis vertical line
  svg.appendChild(make('line', {
    x1: margin.left, y1: margin.top,
    x2: margin.left, y2: margin.top + plotH,
    stroke: colAxis, 'stroke-width': '1',
  }));
  // X-axis horizontal line
  svg.appendChild(make('line', {
    x1: margin.left,         y1: margin.top + plotH,
    x2: margin.left + plotW, y2: margin.top + plotH,
    stroke: colAxis, 'stroke-width': '1',
  }));

  // ── Area fill ─────────────────────────────────────────────────────
  const areaD = [
    `M ${xScale(0).toFixed(2)},${(margin.top + plotH).toFixed(2)}`,
    ...data.map((d, i) =>
      `L ${xScale(i).toFixed(2)},${yScale(Number(d.visitors)).toFixed(2)}`
    ),
    `L ${xScale(n - 1).toFixed(2)},${(margin.top + plotH).toFixed(2)}`,
    'Z',
  ].join(' ');

  svg.appendChild(make('path', {
    d: areaD,
    fill: colFill,
    'clip-path': `url(#${clipId})`,
  }));

  // ── Series line ───────────────────────────────────────────────────
  const lineD = data
    .map((d, i) =>
      `${i === 0 ? 'M' : 'L'} ${xScale(i).toFixed(2)},${yScale(Number(d.visitors)).toFixed(2)}`
    )
    .join(' ');

  svg.appendChild(make('path', {
    d: lineD,
    stroke: colLine,
    'stroke-width': '2.5',
    fill: 'none',
    'stroke-linejoin': 'round',
    'stroke-linecap': 'round',
    'clip-path': `url(#${clipId})`,
  }));

  // ── Dot on last point ─────────────────────────────────────────────
  svg.appendChild(make('circle', {
    cx: xScale(n - 1).toFixed(2),
    cy: yScale(values[n - 1]).toFixed(2),
    r: '4',
    fill: colLine,
    stroke: colSurface,
    'stroke-width': '2',
    'clip-path': `url(#${clipId})`,
  }));

  // ── Y-axis label (rotated) ────────────────────────────────────────
  svg.appendChild(make('text', {
    x: 0,
    y: 0,
    transform: `translate(11, ${(margin.top + plotH / 2).toFixed(1)}) rotate(-90)`,
    'text-anchor': 'middle',
    'dominant-baseline': 'middle',
    fill: colAxis,
    'font-family': 'system-ui, sans-serif',
    'font-size': '10',
  }, 'Visitors'));
}

/* ------------------------------------------------------------------ */
/*  Internal helpers                                                    */
/* ------------------------------------------------------------------ */

/** Create an SVG element with attributes and optional text content */
function make(tag, attrs = {}, text = '') {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    node.setAttribute(k, String(v));
  }
  if (text) node.textContent = text;
  return node;
}

/** "No data" placeholder text centred in the SVG */
function makeNoData() {
  return make('text', {
    x: '50%',
    y: '50%',
    'text-anchor': 'middle',
    'dominant-baseline': 'middle',
    fill: cssVar('--color-chart-axis'),
    'font-family': 'system-ui, sans-serif',
    'font-size': '14',
  }, 'No data available');
}

export function destroyChart() {
  // SVG is cleared on next renderChart call; ResizeObserver managed in main.js
}
