/**
 * Hand-drawn time-series line chart using Canvas 2D.
 *
 * Design goals:
 *  - Redraws to fit its container on every resize (ResizeObserver).
 *  - Reads CSS custom properties for all colours so it respects the theme.
 *  - Draws axes, gridlines, labeled ticks, and the 30-day series.
 *  - Nothing is drawn outside the chart area.
 *  - Works at 360px, 768px, and 1280px container widths.
 */

export class TimeSeriesChart {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {HTMLElement} container  — the element whose size we track
   */
  constructor(canvas, container) {
    this.canvas = canvas;
    this.container = container;
    this.ctx = canvas.getContext('2d');
    this.data = [];
    this._ro = null;
    this._rafId = null;
    this._boundDraw = this._draw.bind(this);
  }

  /**
   * Set data and trigger a draw.
   * @param {Array<{date: string, revenue: number}>} rows
   */
  setData(rows) {
    this.data = rows;
    this._scheduleRedraw();
  }

  /**
   * Start observing container size changes.
   */
  mount() {
    this._ro = new ResizeObserver(() => {
      this._scheduleRedraw();
    });
    this._ro.observe(this.container);
  }

  /**
   * Stop observing and cancel any pending draw.
   */
  destroy() {
    if (this._ro) {
      this._ro.disconnect();
      this._ro = null;
    }
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  /**
   * Redraw immediately (e.g. after a theme change).
   */
  redraw() {
    this._scheduleRedraw();
  }

  // ── Private ──────────────────────────────────────────────────────────────

  _scheduleRedraw() {
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = requestAnimationFrame(this._boundDraw);
  }

  _getCSSVar(name) {
    return getComputedStyle(document.documentElement)
      .getPropertyValue(name)
      .trim();
  }

  _draw() {
    this._rafId = null;
    if (!this.data.length) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = this.container.getBoundingClientRect();
    const cssW = rect.width;
    const cssH = rect.height;

    if (cssW <= 0 || cssH <= 0) return;

    // Resize backing store
    this.canvas.width  = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);

    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // ── Colours from CSS vars ──────────────────────────────────────────────
    const colorGrid   = this._getCSSVar('--color-chart-grid');
    const colorAxis   = this._getCSSVar('--color-chart-axis');
    const colorLabel  = this._getCSSVar('--color-chart-label');
    const colorLine   = this._getCSSVar('--color-chart-line');
    const colorFillS  = this._getCSSVar('--color-chart-fill-start');
    const colorFillE  = this._getCSSVar('--color-chart-fill-end');
    const colorDot    = this._getCSSVar('--color-chart-dot');
    const colorDotBg  = this._getCSSVar('--color-chart-dot-bg');

    // ── Layout margins ─────────────────────────────────────────────────────
    // Adapt margins to available width so labels always fit
    const isNarrow = cssW < 400;
    const isMedium = cssW < 700;

    const marginLeft   = isNarrow ? 44 : isMedium ? 52 : 60;
    const marginRight  = 16;
    const marginTop    = 16;
    const marginBottom = isNarrow ? 36 : 44;

    const plotW = cssW - marginLeft - marginRight;
    const plotH = cssH - marginTop - marginBottom;

    if (plotW <= 0 || plotH <= 0) return;

    // ── Data range ─────────────────────────────────────────────────────────
    const revenues = this.data.map((d) => d.revenue);
    const rawMin = Math.min(...revenues);
    const rawMax = Math.max(...revenues);
    const padding = (rawMax - rawMin) * 0.1 || 100;
    const yMin = Math.max(0, rawMin - padding);
    const yMax = rawMax + padding;

    const xScale = (i) => marginLeft + (i / (this.data.length - 1)) * plotW;
    const yScale = (v) => marginTop + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

    // ── Clear ──────────────────────────────────────────────────────────────
    ctx.clearRect(0, 0, cssW, cssH);

    // ── Gridlines & Y-axis labels ──────────────────────────────────────────
    const yTickCount = isNarrow ? 3 : 5;
    const fontSize = isNarrow ? 9 : 10;
    ctx.font = `${fontSize}px ${getComputedStyle(document.body).fontFamily || 'system-ui, sans-serif'}`;
    ctx.textBaseline = 'middle';

    for (let t = 0; t <= yTickCount; t++) {
      const v = yMin + (t / yTickCount) * (yMax - yMin);
      const y = yScale(v);

      // Gridline
      ctx.beginPath();
      ctx.strokeStyle = colorGrid;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.moveTo(marginLeft, y);
      ctx.lineTo(marginLeft + plotW, y);
      ctx.stroke();
      ctx.setLineDash([]);

      // Y label
      const label = formatYLabel(v);
      ctx.fillStyle = colorLabel;
      ctx.textAlign = 'right';
      ctx.fillText(label, marginLeft - 6, y);
    }

    // ── X-axis labels ──────────────────────────────────────────────────────
    // Show a tick every N days depending on width
    const n = this.data.length;
    const tickEvery = isNarrow ? 7 : isMedium ? 5 : 3;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'center';
    ctx.fillStyle = colorLabel;

    for (let i = 0; i < n; i++) {
      if (i % tickEvery !== 0 && i !== n - 1) continue;
      const x = xScale(i);
      const label = formatXLabel(this.data[i].date);

      // Tick mark
      ctx.beginPath();
      ctx.strokeStyle = colorAxis;
      ctx.lineWidth = 1;
      ctx.moveTo(x, marginTop + plotH);
      ctx.lineTo(x, marginTop + plotH + 4);
      ctx.stroke();

      ctx.fillText(label, x, marginTop + plotH + 6);
    }

    // ── Axes ───────────────────────────────────────────────────────────────
    ctx.beginPath();
    ctx.strokeStyle = colorAxis;
    ctx.lineWidth = 1;
    // Y axis
    ctx.moveTo(marginLeft, marginTop);
    ctx.lineTo(marginLeft, marginTop + plotH);
    // X axis
    ctx.lineTo(marginLeft + plotW, marginTop + plotH);
    ctx.stroke();

    // ── Clip to plot area so nothing bleeds outside ────────────────────────
    ctx.save();
    ctx.beginPath();
    ctx.rect(marginLeft, marginTop, plotW, plotH);
    ctx.clip();

    // ── Area fill (gradient) ───────────────────────────────────────────────
    const grad = ctx.createLinearGradient(0, marginTop, 0, marginTop + plotH);
    grad.addColorStop(0, colorFillS);
    grad.addColorStop(1, colorFillE);

    ctx.beginPath();
    ctx.moveTo(xScale(0), yScale(this.data[0].revenue));
    for (let i = 1; i < n; i++) {
      ctx.lineTo(xScale(i), yScale(this.data[i].revenue));
    }
    // Close path down to x-axis
    ctx.lineTo(xScale(n - 1), marginTop + plotH);
    ctx.lineTo(xScale(0), marginTop + plotH);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // ── Line ───────────────────────────────────────────────────────────────
    ctx.beginPath();
    ctx.strokeStyle = colorLine;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.moveTo(xScale(0), yScale(this.data[0].revenue));
    for (let i = 1; i < n; i++) {
      ctx.lineTo(xScale(i), yScale(this.data[i].revenue));
    }
    ctx.stroke();

    // ── Dots (only on wider charts to avoid clutter) ───────────────────────
    if (!isNarrow) {
      const dotEvery = isMedium ? 3 : 1;
      for (let i = 0; i < n; i++) {
        if (i % dotEvery !== 0 && i !== n - 1) continue;
        const x = xScale(i);
        const y = yScale(this.data[i].revenue);
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fillStyle = colorDotBg;
        ctx.fill();
        ctx.strokeStyle = colorDot;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }

    // Restore clip
    ctx.restore();
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function formatYLabel(value) {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000)     return `$${(value / 1_000).toFixed(0)}K`;
  return `$${Math.round(value)}`;
}

function formatXLabel(dateStr) {
  // dateStr is YYYY-MM-DD
  const parts = dateStr.split('-');
  const month = parseInt(parts[1], 10);
  const day   = parseInt(parts[2], 10);
  const months = ['Jan','Feb','Mar','Apr','May','Jun',
                  'Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[month - 1]} ${day}`;
}
