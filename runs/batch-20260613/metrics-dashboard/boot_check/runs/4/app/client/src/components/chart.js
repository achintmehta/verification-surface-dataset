/**
 * TimeSeriesChart — hand-drawn canvas line chart.
 *
 * Features:
 *  - Axes (x: dates, y: revenue)
 *  - Dashed gridlines
 *  - Labeled ticks (responsive density)
 *  - Smooth bezier line + gradient area fill
 *  - Data point dots
 *  - Redraws on container resize (via external ResizeObserver)
 *  - Redraws on theme change (via 'themechange' custom event)
 *  - All colors read from CSS custom properties → fully theme-aware
 */

export class TimeSeriesChart {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {Array<{date: string, visitors: number, revenue: number}>} data
   */
  constructor(canvas, data) {
    this.canvas = canvas;
    this.data = data || [];
    this.dpr = window.devicePixelRatio || 1;

    // Redraw when theme changes
    this._onThemeChange = () => this.draw();
    window.addEventListener('themechange', this._onThemeChange);
  }

  destroy() {
    window.removeEventListener('themechange', this._onThemeChange);
  }

  /** Read a CSS custom property from the document root. */
  _cssVar(name) {
    return getComputedStyle(document.documentElement)
      .getPropertyValue(name)
      .trim();
  }

  /**
   * Main draw method.
   * Sizes the canvas to its CSS container and renders the full chart.
   */
  draw() {
    const canvas = this.canvas;
    const container = canvas.parentElement;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const cssW = Math.floor(rect.width);
    const cssH = Math.floor(rect.height);

    if (cssW <= 0 || cssH <= 0) return;

    // HiDPI: set physical pixel size, scale context
    const dpr = this.dpr;
    canvas.width  = cssW * dpr;
    canvas.height = cssH * dpr;
    canvas.style.width  = cssW + 'px';
    canvas.style.height = cssH + 'px';

    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    // ── Theme-aware colors ────────────────────────────────────────────────────
    const C = {
      line:      this._cssVar('--color-chart-line'),
      fillStart: this._cssVar('--color-chart-fill-start'),
      fillEnd:   this._cssVar('--color-chart-fill-end'),
      grid:      this._cssVar('--color-chart-grid'),
      axis:      this._cssVar('--color-chart-axis'),
      dot:       this._cssVar('--color-chart-dot'),
      dotBorder: this._cssVar('--color-chart-dot-border'),
    };

    // ── Clear ─────────────────────────────────────────────────────────────────
    ctx.clearRect(0, 0, cssW, cssH);

    if (!this.data || this.data.length < 2) {
      ctx.fillStyle = C.axis;
      ctx.font = '13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('No data available', cssW / 2, cssH / 2);
      return;
    }

    // ── Margins (responsive) ──────────────────────────────────────────────────
    const narrow = cssW < 380;
    const M = {
      top:    14,
      right:  narrow ? 8 : 14,
      bottom: narrow ? 42 : 46,
      left:   narrow ? 50 : 62,
    };

    const plotW = cssW - M.left - M.right;
    const plotH = cssH - M.top  - M.bottom;

    if (plotW <= 0 || plotH <= 0) return;

    // ── Data ranges ───────────────────────────────────────────────────────────
    const revenues = this.data.map(d => d.revenue);
    const rawMin = Math.min(...revenues);
    const rawMax = Math.max(...revenues);
    const { min: yMin, max: yMax, ticks: yTicks } = niceScale(rawMin, rawMax, 5);

    const n = this.data.length;

    // ── Coordinate mappers ────────────────────────────────────────────────────
    const xOf = (i) => M.left + (i / (n - 1)) * plotW;
    const yOf = (v) => M.top  + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

    // ── Gridlines ─────────────────────────────────────────────────────────────
    ctx.save();
    ctx.strokeStyle = C.grid;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]);
    for (const t of yTicks) {
      const y = yOf(t);
      ctx.beginPath();
      ctx.moveTo(M.left, y);
      ctx.lineTo(M.left + plotW, y);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.restore();

    // ── Axes ──────────────────────────────────────────────────────────────────
    ctx.save();
    ctx.strokeStyle = C.grid;
    ctx.lineWidth = 1;
    // Y axis
    ctx.beginPath();
    ctx.moveTo(M.left, M.top);
    ctx.lineTo(M.left, M.top + plotH);
    ctx.stroke();
    // X axis
    ctx.beginPath();
    ctx.moveTo(M.left,          M.top + plotH);
    ctx.lineTo(M.left + plotW,  M.top + plotH);
    ctx.stroke();
    ctx.restore();

    // ── Y-axis tick labels ────────────────────────────────────────────────────
    const yFontSz = narrow ? 9 : 10;
    ctx.save();
    ctx.fillStyle   = C.axis;
    ctx.font        = `${yFontSz}px system-ui, -apple-system, sans-serif`;
    ctx.textAlign   = 'right';
    ctx.textBaseline = 'middle';
    for (const t of yTicks) {
      const y = yOf(t);
      ctx.fillText(fmtY(t), M.left - 5, y);
      // Tick mark
      ctx.save();
      ctx.strokeStyle = C.axis;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(M.left - 3, y);
      ctx.lineTo(M.left,     y);
      ctx.stroke();
      ctx.restore();
    }
    ctx.restore();

    // ── X-axis tick labels ────────────────────────────────────────────────────
    const xFontSz   = narrow ? 8 : 9;
    const maxLabels = narrow ? 4 : (cssW < 500 ? 5 : (cssW < 700 ? 7 : 9));
    // Pick evenly-spaced indices including first and last
    const labelIdxs = pickIndices(n, maxLabels);

    ctx.save();
    ctx.fillStyle    = C.axis;
    ctx.font         = `${xFontSz}px system-ui, -apple-system, sans-serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'top';
    for (const i of labelIdxs) {
      const x = xOf(i);
      ctx.fillText(fmtX(this.data[i].date), x, M.top + plotH + 7);
      // Tick mark
      ctx.save();
      ctx.strokeStyle = C.axis;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, M.top + plotH);
      ctx.lineTo(x, M.top + plotH + 4);
      ctx.stroke();
      ctx.restore();
    }
    ctx.restore();

    // ── Area fill (gradient) ──────────────────────────────────────────────────
    const grad = ctx.createLinearGradient(0, M.top, 0, M.top + plotH);
    grad.addColorStop(0, C.fillStart);
    grad.addColorStop(1, C.fillEnd);

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(xOf(0), yOf(this.data[0].revenue));
    for (let i = 1; i < n; i++) {
      smoothTo(ctx, xOf(i - 1), yOf(this.data[i - 1].revenue),
                    xOf(i),     yOf(this.data[i].revenue));
    }
    ctx.lineTo(xOf(n - 1), M.top + plotH);
    ctx.lineTo(xOf(0),     M.top + plotH);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.restore();

    // ── Line ──────────────────────────────────────────────────────────────────
    ctx.save();
    ctx.strokeStyle = C.line;
    ctx.lineWidth   = 2;
    ctx.lineJoin    = 'round';
    ctx.lineCap     = 'round';
    ctx.beginPath();
    ctx.moveTo(xOf(0), yOf(this.data[0].revenue));
    for (let i = 1; i < n; i++) {
      smoothTo(ctx, xOf(i - 1), yOf(this.data[i - 1].revenue),
                    xOf(i),     yOf(this.data[i].revenue));
    }
    ctx.stroke();
    ctx.restore();

    // ── Data-point dots ───────────────────────────────────────────────────────
    // Show all dots when there's room; otherwise every 5th + endpoints
    const dotR      = narrow ? 2 : 2.5;
    const showAll   = n <= 15 || (plotW / n) > 10;

    ctx.save();
    for (let i = 0; i < n; i++) {
      if (!showAll && i % 5 !== 0 && i !== 0 && i !== n - 1) continue;
      const x = xOf(i);
      const y = yOf(this.data[i].revenue);
      // Border ring
      ctx.beginPath();
      ctx.arc(x, y, dotR + 1.5, 0, Math.PI * 2);
      ctx.fillStyle = C.dotBorder;
      ctx.fill();
      // Filled dot
      ctx.beginPath();
      ctx.arc(x, y, dotR, 0, Math.PI * 2);
      ctx.fillStyle = C.dot;
      ctx.fill();
    }
    ctx.restore();

    // ── Y-axis rotated label ──────────────────────────────────────────────────
    if (!narrow) {
      ctx.save();
      ctx.fillStyle    = C.axis;
      ctx.font         = `9px system-ui, -apple-system, sans-serif`;
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.translate(10, M.top + plotH / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText('Revenue ($)', 0, 0);
      ctx.restore();
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Draw a smooth cubic bezier segment between two points.
 * Control points are placed at the horizontal midpoint.
 */
function smoothTo(ctx, x0, y0, x1, y1) {
  const cpX = (x0 + x1) / 2;
  ctx.bezierCurveTo(cpX, y0, cpX, y1, x1, y1);
}

/**
 * Compute nice axis bounds and evenly-spaced tick values.
 */
function niceScale(dataMin, dataMax, targetTicks) {
  const range = dataMax - dataMin;
  if (range === 0) {
    const pad = Math.abs(dataMin) * 0.1 || 1;
    return {
      min: dataMin - pad,
      max: dataMax + pad,
      ticks: [dataMin],
    };
  }
  const rawStep   = range / (targetTicks - 1);
  const mag       = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const niceStep  = Math.ceil(rawStep / mag) * mag;
  const niceMin   = Math.floor(dataMin / niceStep) * niceStep;
  const niceMax   = Math.ceil(dataMax  / niceStep) * niceStep;

  const ticks = [];
  // Use integer steps to avoid floating-point drift
  const steps = Math.round((niceMax - niceMin) / niceStep);
  for (let k = 0; k <= steps; k++) {
    ticks.push(niceMin + k * niceStep);
  }
  return { min: niceMin, max: niceMax, ticks };
}

/**
 * Pick `count` evenly-spaced indices from [0, n-1], always including 0 and n-1.
 */
function pickIndices(n, count) {
  if (count >= n) return Array.from({ length: n }, (_, i) => i);
  const result = new Set([0, n - 1]);
  const step = (n - 1) / (count - 1);
  for (let k = 1; k < count - 1; k++) {
    result.add(Math.round(k * step));
  }
  return [...result].sort((a, b) => a - b);
}

/**
 * Format a Y-axis tick as compact currency.
 */
function fmtY(v) {
  if (Math.abs(v) >= 1_000_000) return '$' + (v / 1_000_000).toFixed(1) + 'M';
  if (Math.abs(v) >= 1_000)     return '$' + (v / 1_000).toFixed(0) + 'k';
  return '$' + v.toFixed(0);
}

/**
 * Format an X-axis date as "Jan 1".
 * Parses date-only strings (YYYY-MM-DD) in UTC to avoid timezone shifts.
 */
function fmtX(dateStr) {
  // date-only strings: parse as UTC midnight
  const parts = String(dateStr).split('T')[0].split('-');
  const d = new Date(Date.UTC(+parts[0], +parts[1] - 1, +parts[2]));
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day:   'numeric',
    timeZone: 'UTC',
  });
}
