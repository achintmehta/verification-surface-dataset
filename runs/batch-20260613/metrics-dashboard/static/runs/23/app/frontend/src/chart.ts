import type { TimeseriesPoint } from './api';

/**
 * Hand-drawn canvas line chart with axes, gridlines, labels, and dots.
 * Redraws to fit its container on resize.
 */

interface ChartTheme {
  gridColor: string;
  axisColor: string;
  lineColor: string;
  fillColor: string;
  dotColor: string;
  textColor: string;
  bgColor: string;
}

function getThemeColors(): ChartTheme {
  const style = getComputedStyle(document.documentElement);
  return {
    gridColor: style.getPropertyValue('--chart-grid').trim() || '#e0e4e8',
    axisColor: style.getPropertyValue('--chart-axis').trim() || '#333',
    lineColor: style.getPropertyValue('--chart-line').trim() || '#4361ee',
    fillColor: style.getPropertyValue('--chart-fill').trim() || 'rgba(67,97,238,0.1)',
    dotColor: style.getPropertyValue('--chart-dot').trim() || '#4361ee',
    textColor: style.getPropertyValue('--chart-axis').trim() || '#333',
    bgColor: style.getPropertyValue('--bg-card').trim() || '#ffffff',
  };
}

let chartData: TimeseriesPoint[] = [];
let resizeObserver: ResizeObserver | null = null;

export function drawChart(canvas: HTMLCanvasElement, data: TimeseriesPoint[]): void {
  chartData = data;

  // Set up ResizeObserver for responsive redraw
  if (resizeObserver) {
    resizeObserver.disconnect();
  }

  const container = canvas.parentElement;
  if (container) {
    resizeObserver = new ResizeObserver(() => {
      renderChart(canvas, chartData);
    });
    resizeObserver.observe(container);
  }

  renderChart(canvas, chartData);
}

export function redrawChart(canvas: HTMLCanvasElement): void {
  if (chartData.length > 0) {
    renderChart(canvas, chartData);
  }
}

function renderChart(canvas: HTMLCanvasElement, data: TimeseriesPoint[]): void {
  const container = canvas.parentElement;
  if (!container) return;

  const rect = container.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.floor(rect.width);
  const height = Math.floor(rect.height);

  if (width <= 0 || height <= 0) return;

  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.scale(dpr, dpr);

  const theme = getThemeColors();

  // Clear
  ctx.fillStyle = theme.bgColor;
  ctx.fillRect(0, 0, width, height);

  if (data.length === 0) return;

  // Margins
  const isNarrow = width < 400;
  const marginLeft = isNarrow ? 40 : 60;
  const marginRight = isNarrow ? 10 : 20;
  const marginTop = 15;
  const marginBottom = isNarrow ? 40 : 50;

  const plotW = width - marginLeft - marginRight;
  const plotH = height - marginTop - marginBottom;

  if (plotW <= 0 || plotH <= 0) return;

  const visitors = data.map(d => d.visitors);
  const minVal = Math.min(...visitors);
  const maxVal = Math.max(...visitors);
  const range = maxVal - minVal || 1;
  const padded_min = Math.max(0, minVal - range * 0.1);
  const padded_max = maxVal + range * 0.1;
  const padded_range = padded_max - padded_min;

  // Calculate nice tick values for Y axis
  const yTicks = niceYTicks(padded_min, padded_max, 5);

  // Helper: data index to x coord
  const xStep = data.length > 1 ? plotW / (data.length - 1) : 0;
  const toX = (i: number) => marginLeft + i * xStep;
  const toY = (v: number) => marginTop + plotH - ((v - padded_min) / padded_range) * plotH;

  // --- Gridlines ---
  ctx.strokeStyle = theme.gridColor;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);

  for (const tick of yTicks) {
    const y = toY(tick);
    ctx.beginPath();
    ctx.moveTo(marginLeft, y);
    ctx.lineTo(marginLeft + plotW, y);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // --- Y axis labels ---
  ctx.fillStyle = theme.textColor;
  ctx.font = `${isNarrow ? 9 : 11}px -apple-system, sans-serif`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';

  for (const tick of yTicks) {
    const y = toY(tick);
    const label = formatNumber(tick);
    ctx.fillText(label, marginLeft - 6, y);
  }

  // --- X axis labels ---
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  // Show a subset of date labels to avoid overlap
  const maxLabels = Math.max(2, Math.floor(plotW / (isNarrow ? 45 : 65)));
  const step = Math.max(1, Math.ceil(data.length / maxLabels));

  for (let i = 0; i < data.length; i += step) {
    const x = toX(i);
    const date = new Date(data[i].date);
    const label = `${date.getMonth() + 1}/${date.getDate()}`;
    ctx.fillText(label, x, marginTop + plotH + 8);
  }
  // Always show last label
  if ((data.length - 1) % step !== 0) {
    const lastX = toX(data.length - 1);
    const lastDate = new Date(data[data.length - 1].date);
    const label = `${lastDate.getMonth() + 1}/${lastDate.getDate()}`;
    ctx.fillText(label, lastX, marginTop + plotH + 8);
  }

  // --- Axes ---
  ctx.strokeStyle = theme.axisColor;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  // Y axis
  ctx.moveTo(marginLeft, marginTop);
  ctx.lineTo(marginLeft, marginTop + plotH);
  // X axis
  ctx.lineTo(marginLeft + plotW, marginTop + plotH);
  ctx.stroke();

  // --- Area fill ---
  ctx.fillStyle = theme.fillColor;
  ctx.beginPath();
  ctx.moveTo(toX(0), toY(visitors[0]));
  for (let i = 1; i < data.length; i++) {
    ctx.lineTo(toX(i), toY(visitors[i]));
  }
  ctx.lineTo(toX(data.length - 1), marginTop + plotH);
  ctx.lineTo(toX(0), marginTop + plotH);
  ctx.closePath();
  ctx.fill();

  // --- Line ---
  ctx.strokeStyle = theme.lineColor;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(toX(0), toY(visitors[0]));
  for (let i = 1; i < data.length; i++) {
    ctx.lineTo(toX(i), toY(visitors[i]));
  }
  ctx.stroke();

  // --- Dots ---
  const dotRadius = isNarrow ? 2.5 : 3.5;
  ctx.fillStyle = theme.dotColor;
  for (let i = 0; i < data.length; i++) {
    ctx.beginPath();
    ctx.arc(toX(i), toY(visitors[i]), dotRadius, 0, Math.PI * 2);
    ctx.fill();
  }
}

function niceYTicks(min: number, max: number, targetCount: number): number[] {
  const range = max - min;
  const roughStep = range / targetCount;
  const magnitude = Math.pow(10, Math.floor(Math.log10(roughStep)));
  const residual = roughStep / magnitude;

  let niceStep: number;
  if (residual <= 1.5) niceStep = magnitude;
  else if (residual <= 3) niceStep = 2 * magnitude;
  else if (residual <= 7) niceStep = 5 * magnitude;
  else niceStep = 10 * magnitude;

  const ticks: number[] = [];
  let start = Math.ceil(min / niceStep) * niceStep;
  for (let v = start; v <= max; v += niceStep) {
    ticks.push(Math.round(v * 100) / 100);
  }
  return ticks;
}

function formatNumber(n: number): string {
  if (n >= 1000) {
    return (n / 1000).toFixed(1) + 'k';
  }
  return n.toFixed(0);
}
