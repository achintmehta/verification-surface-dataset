/**
 * Hand-drawn time-series chart using Canvas 2D.
 * Draws a dual-series line chart (revenue + visitors) with axes, gridlines,
 * and labeled ticks. Redraws on container resize via ResizeObserver.
 */

export class TimeSeriesChart {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {Array<{date: string, visitors: number, revenue: number}>} data
   */
  constructor(canvas, data) {
    this.canvas = canvas;
    this.ctx    = canvas.getContext('2d');
    this.data   = data;
    this._ro    = null;
    this._rafId = null;

    this._bindResize();
    this.draw();
  }

  /** Update data and redraw */
  update(data) {
    this.data = data;
    this.draw();
  }

  /** Destroy the ResizeObserver */
  destroy() {
    if (this._ro) this._ro.disconnect();
    if (this._rafId) cancelAnimationFrame(this._rafId);
  }

  _bindResize() {
    this._ro = new ResizeObserver(() => {
      if (this._rafId) cancelAnimationFrame(this._rafId);
      this._rafId = requestAnimationFrame(() => this.draw());
    });
    this._ro.observe(this.canvas.parentElement);
  }

  /** Read CSS custom properties for current theme colours */
  _colors() {
    const s = getComputedStyle(document.documentElement);
    const get = (v) => s.getPropertyValue(v).trim();
    return {
      line:        get('--chart-line')           || '#4f46e5',
      visitors:    get('--chart-line-visitors')  || '#06b6d4',
      grid:        get('--chart-grid')           || '#e2e8f0',
      axis:        get('--chart-axis')           || '#718096',
      label:       get('--chart-label')          || '#4a5568',
      bg:          get('--chart-bg')             || '#ffffff',
    };
  }

  draw() {
    const canvas    = this.canvas;
    const container = canvas.parentElement;
    if (!container) return;

    const dpr  = window.devicePixelRatio || 1;
    const cssW = container.clientWidth;
    const cssH = container.clientHeight;

    if (cssW < 1 || cssH < 1) return;

    // Resize backing store to match physical pixels
    canvas.width  = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);

    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const W = cssW;
    const H = cssH;

    const colors = this._colors();

    // ── Clear ─────────────────────────────────────────────────────────────────
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = colors.bg;
    ctx.fillRect(0, 0, W, H);

    if (!this.data || this.data.length === 0) {
      ctx.fillStyle = colors.label;
      ctx.font = '14px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('No data available', W / 2, H / 2);
      return;
    }

    // ── Margins ───────────────────────────────────────────────────────────────
    const isNarrow = W < 400;
    const isMedium = W < 600;

    const marginTop    = 24;
    const marginBottom = isNarrow ? 38 : 46;
    const marginLeft   = isNarrow ? 52 : isMedium ? 62 : 72;
    const marginRight  = isNarrow ? 28 : 36;

    const plotW = W - marginLeft - marginRight;
    const plotH = H - marginTop  - marginBottom;

    if (plotW < 20 || plotH < 20) return;

    // ── Data ──────────────────────────────────────────────────────────────────
    const revenues = this.data.map(d => d.revenue);
    const visitors = this.data.map(d => d.visitors);
    const n        = this.data.length;

    const revMax = Math.max(...revenues) * 1.12;
    const visMax = Math.max(...visitors) * 1.12;

    // ── Scale helpers ─────────────────────────────────────────────────────────
    const xScale    = (i) => marginLeft + (i / (n - 1)) * plotW;
    const yScaleRev = (v) => marginTop + plotH - (v / revMax) * plotH;
    const yScaleVis = (v) => marginTop + plotH - (v / visMax) * plotH;

    // ── Plot area background ──────────────────────────────────────────────────
    ctx.save();
    ctx.fillStyle = hexToRgba(colors.grid, 0.18);
    ctx.fillRect(marginLeft, marginTop, plotW, plotH);
    ctx.restore();

    // ── Gridlines & Y-axis ticks ──────────────────────────────────────────────
    const yTickCount = isNarrow ? 4 : 5;
    const yTicks     = niceLinearTicks(0, revMax, yTickCount);
    const labelSize  = isNarrow ? 9 : 10;

    ctx.save();
    ctx.strokeStyle = colors.grid;
    ctx.lineWidth   = 1;
    ctx.setLineDash([3, 3]);

    for (const tick of yTicks) {
      if (tick === 0) continue; // skip zero line (drawn by axis)
      const y = yScaleRev(tick);
      ctx.beginPath();
      ctx.moveTo(marginLeft, y);
      ctx.lineTo(marginLeft + plotW, y);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.restore();

    // ── Y-axis labels ─────────────────────────────────────────────────────────
    ctx.save();
    ctx.fillStyle    = colors.label;
    ctx.font         = `${labelSize}px -apple-system, sans-serif`;
    ctx.textAlign    = 'right';
    ctx.textBaseline = 'middle';

    for (const tick of yTicks) {
      const y = yScaleRev(tick);
      ctx.fillText(formatCompact(tick), marginLeft - 6, y);
    }
    ctx.restore();

    // ── X-axis ticks & labels ─────────────────────────────────────────────────
    const xTickCount   = isNarrow ? 4 : isMedium ? 5 : 7;
    const xTickStep    = Math.max(1, Math.floor((n - 1) / (xTickCount - 1)));
    const xTickIndices = [];

    for (let i = 0; i <= n - 1; i += xTickStep) {
      xTickIndices.push(Math.min(i, n - 1));
    }
    // Ensure last point is included without duplication
    if (xTickIndices[xTickIndices.length - 1] !== n - 1) {
      const lastX = xScale(n - 1);
      const prevX = xScale(xTickIndices[xTickIndices.length - 1]);
      if (lastX - prevX > 32) {
        xTickIndices.push(n - 1);
      } else {
        xTickIndices[xTickIndices.length - 1] = n - 1;
      }
    }

    ctx.save();
    ctx.fillStyle    = colors.label;
    ctx.font         = `${labelSize}px -apple-system, sans-serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'top';
    ctx.strokeStyle  = colors.axis;
    ctx.lineWidth    = 1;

    for (const i of xTickIndices) {
      const x     = xScale(i);
      const label = formatDateShort(this.data[i].date);
      ctx.beginPath();
      ctx.moveTo(x, marginTop + plotH);
      ctx.lineTo(x, marginTop + plotH + 4);
      ctx.stroke();
      ctx.fillText(label, x, marginTop + plotH + 8);
    }
    ctx.restore();

    // ── Axes ──────────────────────────────────────────────────────────────────
    ctx.save();
    ctx.strokeStyle = colors.axis;
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    ctx.moveTo(marginLeft, marginTop);
    ctx.lineTo(marginLeft, marginTop + plotH);
    ctx.lineTo(marginLeft + plotW, marginTop + plotH);
    ctx.stroke();
    ctx.restore();

    // ── Revenue area fill ─────────────────────────────────────────────────────
    ctx.save();
    const areaGrad = ctx.createLinearGradient(0, marginTop, 0, marginTop + plotH);
    areaGrad.addColorStop(0, hexToRgba(colors.line, 0.22));
    areaGrad.addColorStop(1, hexToRgba(colors.line, 0.02));

    ctx.beginPath();
    ctx.moveTo(xScale(0), yScaleRev(revenues[0]));
    for (let i = 1; i < n; i++) {
      ctx.lineTo(xScale(i), yScaleRev(revenues[i]));
    }
    ctx.lineTo(xScale(n - 1), marginTop + plotH);
    ctx.lineTo(xScale(0),     marginTop + plotH);
    ctx.closePath();
    ctx.fillStyle = areaGrad;
    ctx.fill();
    ctx.restore();

    // ── Revenue line ──────────────────────────────────────────────────────────
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(xScale(0), yScaleRev(revenues[0]));
    for (let i = 1; i < n; i++) {
      ctx.lineTo(xScale(i), yScaleRev(revenues[i]));
    }
    ctx.strokeStyle = colors.line;
    ctx.lineWidth   = 2;
    ctx.lineJoin    = 'round';
    ctx.stroke();
    ctx.restore();

    // ── Visitors line (dashed) ────────────────────────────────────────────────
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(xScale(0), yScaleVis(visitors[0]));
    for (let i = 1; i < n; i++) {
      ctx.lineTo(xScale(i), yScaleVis(visitors[i]));
    }
    ctx.strokeStyle = colors.visitors;
    ctx.lineWidth   = 1.5;
    ctx.lineJoin    = 'round';
    ctx.setLineDash([5, 3]);
    ctx.stroke();
    ctx.restore();

    // ── Legend ────────────────────────────────────────────────────────────────
    const legendSize = isNarrow ? 9 : 10;
    const legendY    = marginTop + 6;
    const legendX    = marginLeft + 8;

    ctx.save();
    ctx.font         = `${legendSize}px -apple-system, sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.textAlign    = 'left';

    // Revenue swatch (solid line)
    ctx.strokeStyle = colors.line;
    ctx.lineWidth   = 2.5;
    ctx.beginPath();
    ctx.moveTo(legendX, legendY);
    ctx.lineTo(legendX + 16, legendY);
    ctx.stroke();
    ctx.fillStyle = colors.label;
    ctx.fillText('Revenue', legendX + 20, legendY);

    // Visitors swatch (dashed line)
    const visLegX = legendX + (isNarrow ? 72 : 84);
    ctx.strokeStyle = colors.visitors;
    ctx.lineWidth   = 1.5;
    ctx.setLineDash([4, 2]);
    ctx.beginPath();
    ctx.moveTo(visLegX, legendY);
    ctx.lineTo(visLegX + 16, legendY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = colors.label;
    ctx.fillText('Visitors', visLegX + 20, legendY);

    ctx.restore();
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Generate nice round tick values for a linear axis */
function niceLinearTicks(min, max, count) {
  const range = max - min;
  if (range === 0) return [min];
  const rawStep = range / (count - 1);
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const niceSteps = [1, 2, 2.5, 5, 10];
  let step = magnitude;
  for (const ns of niceSteps) {
    if (ns * magnitude >= rawStep) { step = ns * magnitude; break; }
  }
  const ticks = [];
  const start = Math.ceil(min / step) * step;
  for (let t = start; t <= max + step * 0.01; t += step) {
    ticks.push(parseFloat(t.toPrecision(10)));
    if (ticks.length > count + 2) break;
  }
  return ticks;
}

/** Format a number compactly: 1234567 → "1.2M", 12345 → "12.3K" */
function formatCompact(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(Math.round(n));
}

/** Format ISO date string to short label: "2024-01-15" or "2024-01-15T00:00:00.000Z" → "Jan 15" */
function formatDateShort(dateStr) {
  const s = String(dateStr).slice(0, 10); // YYYY-MM-DD
  const [y, m, d] = s.split('-').map(Number);
  const date = new Date(y, m - 1, d); // local time, no timezone shift
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** Convert hex colour to rgba string */
function hexToRgba(hex, alpha) {
  const h = hex.replace('#', '');
  if (h.length === 3) {
    const r = parseInt(h[0] + h[0], 16);
    const g = parseInt(h[1] + h[1], 16);
    const b = parseInt(h[2] + h[2], 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
  if (h.length === 6) {
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
  return `rgba(79,70,229,${alpha})`;
}
