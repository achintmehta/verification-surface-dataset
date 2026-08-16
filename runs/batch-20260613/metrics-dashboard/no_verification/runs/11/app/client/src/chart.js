// Hand-drawn time-series line chart on a <canvas>. No charting library.
// Redraws to fit its container (DPR-aware) and re-reads theme colors so it
// restyles when the theme toggles.

function themeColors() {
  const cs = getComputedStyle(document.body);
  return {
    axis: cs.getPropertyValue("--chart-axis").trim() || "#9aa3b5",
    grid: cs.getPropertyValue("--chart-grid").trim() || "#e6e9f1",
    line: cs.getPropertyValue("--chart-line").trim() || "#2f6df6",
    fill: cs.getPropertyValue("--chart-fill").trim() || "rgba(47,109,246,0.12)",
    label: cs.getPropertyValue("--chart-label").trim() || "#5a6478",
  };
}

function niceMax(value) {
  if (value <= 0) return 10;
  const mag = Math.pow(10, Math.floor(Math.log10(value)));
  const norm = value / mag;
  let step;
  if (norm <= 1) step = 1;
  else if (norm <= 2) step = 2;
  else if (norm <= 5) step = 5;
  else step = 10;
  return step * mag;
}

export class TimeSeriesChart {
  constructor(canvas, container) {
    this.canvas = canvas;
    this.container = container;
    this.data = [];

    this._ro = new ResizeObserver(() => this.draw());
    this._ro.observe(container);
    window.addEventListener("resize", () => this.draw());
  }

  setData(data) {
    this.data = Array.isArray(data) ? data : [];
    this.draw();
  }

  destroy() {
    if (this._ro) this._ro.disconnect();
  }

  draw() {
    const { canvas, container, data } = this;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const cssW = container.clientWidth;
    const cssH = container.clientHeight;
    if (cssW <= 0 || cssH <= 0) return;

    // Size the backing store for crispness, then scale the context.
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.width = cssW + "px";
    canvas.style.height = cssH + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    if (!data.length) {
      const c = themeColors();
      ctx.fillStyle = c.label;
      ctx.font = "13px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("No data", cssW / 2, cssH / 2);
      return;
    }

    const c = themeColors();

    // Plot area with margins for axis labels.
    const padLeft = 48;
    const padRight = 12;
    const padTop = 12;
    const padBottom = 28;
    const plotW = Math.max(10, cssW - padLeft - padRight);
    const plotH = Math.max(10, cssH - padTop - padBottom);
    const x0 = padLeft;
    const y0 = padTop;

    const values = data.map((d) => Number(d.visitors) || 0);
    const dataMax = Math.max(...values, 1);
    const max = niceMax(dataMax);
    const min = 0;

    const xFor = (i) =>
      data.length === 1
        ? x0 + plotW / 2
        : x0 + (i / (data.length - 1)) * plotW;
    const yFor = (v) => y0 + plotH - ((v - min) / (max - min)) * plotH;

    // ---- gridlines + Y tick labels ----
    const yTicks = 4;
    ctx.font = "11px system-ui, sans-serif";
    ctx.textBaseline = "middle";
    for (let t = 0; t <= yTicks; t++) {
      const val = min + ((max - min) * t) / yTicks;
      const y = yFor(val);
      ctx.strokeStyle = c.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(x0 + plotW, y);
      ctx.stroke();

      ctx.fillStyle = c.label;
      ctx.textAlign = "right";
      ctx.fillText(formatTick(val), x0 - 8, y);
    }

    // ---- axes ----
    ctx.strokeStyle = c.axis;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x0, y0 + plotH);
    ctx.lineTo(x0 + plotW, y0 + plotH);
    ctx.stroke();

    // ---- X tick labels (a few, to avoid clutter at any width) ----
    const maxLabels = Math.max(2, Math.min(6, Math.floor(plotW / 70)));
    const labelStep = Math.max(1, Math.ceil((data.length - 1) / maxLabels));
    ctx.fillStyle = c.label;
    ctx.textBaseline = "top";
    for (let i = 0; i < data.length; i += labelStep) {
      const x = xFor(i);
      const label = shortDate(data[i].date);
      // Keep first/last labels inside the plot area so nothing is clipped.
      if (i === 0) ctx.textAlign = "left";
      else if (i + labelStep >= data.length) ctx.textAlign = "right";
      else ctx.textAlign = "center";
      ctx.fillText(label, x, y0 + plotH + 8);
    }
    // Always render the last point's date, right-aligned to the axis end.
    if ((data.length - 1) % labelStep !== 0) {
      ctx.textAlign = "right";
      ctx.fillText(shortDate(data[data.length - 1].date), x0 + plotW, y0 + plotH + 8);
    }

    // ---- area fill ----
    ctx.beginPath();
    ctx.moveTo(xFor(0), yFor(values[0]));
    for (let i = 1; i < values.length; i++) ctx.lineTo(xFor(i), yFor(values[i]));
    ctx.lineTo(xFor(values.length - 1), y0 + plotH);
    ctx.lineTo(xFor(0), y0 + plotH);
    ctx.closePath();
    ctx.fillStyle = c.fill;
    ctx.fill();

    // ---- series line ----
    ctx.beginPath();
    ctx.moveTo(xFor(0), yFor(values[0]));
    for (let i = 1; i < values.length; i++) ctx.lineTo(xFor(i), yFor(values[i]));
    ctx.strokeStyle = c.line;
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.stroke();

    // ---- data points ----
    ctx.fillStyle = c.line;
    const r = data.length > 20 ? 1.8 : 2.5;
    for (let i = 0; i < values.length; i++) {
      ctx.beginPath();
      ctx.arc(xFor(i), yFor(values[i]), r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function formatTick(v) {
  if (v >= 1000) return (v / 1000).toFixed(v % 1000 === 0 ? 0 : 1) + "k";
  return String(Math.round(v));
}

function shortDate(iso) {
  // iso is like "2024-06-01" (or a Date string). Show "M/D".
  const d = new Date(iso);
  if (isNaN(d.getTime())) {
    const parts = String(iso).slice(0, 10).split("-");
    if (parts.length === 3) return `${Number(parts[1])}/${Number(parts[2])}`;
    return String(iso);
  }
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}
