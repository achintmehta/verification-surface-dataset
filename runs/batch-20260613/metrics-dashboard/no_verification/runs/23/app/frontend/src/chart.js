/**
 * Hand-drawn SVG time-series line chart.
 * Redraws to fit its container on resize.
 */

import { getCurrentTheme } from './theme.js';

const NS = 'http://www.w3.org/2000/svg';

function getColors() {
  const dark = getCurrentTheme() === 'dark';
  return {
    grid: dark ? '#334155' : '#e5e7eb',
    axis: dark ? '#94a3b8' : '#6b7280',
    line: dark ? '#60a5fa' : '#3b82f6',
    fill: dark ? 'rgba(96,165,250,0.10)' : 'rgba(59,130,246,0.10)',
    dot: dark ? '#60a5fa' : '#3b82f6',
    text: dark ? '#cbd5e1' : '#4b5563',
    tooltip: dark ? '#1e293b' : '#ffffff',
    tooltipBorder: dark ? '#475569' : '#d1d5db',
    tooltipText: dark ? '#e2e8f0' : '#1a1a2e',
  };
}

let currentData = null;
let containerEl = null;
let resizeObserver = null;

export function drawTimeseriesChart(container, data) {
  currentData = data;
  containerEl = container;

  // Clean up previous observer
  if (resizeObserver) {
    resizeObserver.disconnect();
  }

  render();

  // Observe resize
  resizeObserver = new ResizeObserver(() => {
    render();
  });
  resizeObserver.observe(container);
}

export function redrawChart() {
  if (currentData && containerEl) render();
}

function render() {
  const container = containerEl;
  const data = currentData;
  if (!container || !data || data.length === 0) return;

  // Clear
  container.innerHTML = '';

  const rect = container.getBoundingClientRect();
  const W = Math.floor(rect.width);
  const H = Math.max(220, Math.floor(rect.height || 260));

  // Margins
  const margin = { top: 20, right: 20, bottom: 50, left: 55 };
  const chartW = W - margin.left - margin.right;
  const chartH = H - margin.top - margin.bottom;

  if (chartW < 40 || chartH < 40) return;

  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.style.width = '100%';
  svg.style.height = `${H}px`;
  svg.style.display = 'block';

  const colors = getColors();

  // Compute scales
  const visitors = data.map(d => d.visitors);
  const minV = Math.min(...visitors);
  const maxV = Math.max(...visitors);
  const vPad = (maxV - minV) * 0.1 || 100;
  const yMin = Math.max(0, minV - vPad);
  const yMax = maxV + vPad;

  const xScale = (i) => margin.left + (i / (data.length - 1)) * chartW;
  const yScale = (v) => margin.top + chartH - ((v - yMin) / (yMax - yMin)) * chartH;

  // Gridlines (horizontal)
  const numGridLines = 5;
  for (let i = 0; i <= numGridLines; i++) {
    const y = margin.top + (i / numGridLines) * chartH;
    const line = document.createElementNS(NS, 'line');
    line.setAttribute('x1', margin.left);
    line.setAttribute('x2', margin.left + chartW);
    line.setAttribute('y1', y);
    line.setAttribute('y2', y);
    line.setAttribute('stroke', colors.grid);
    line.setAttribute('stroke-width', '1');
    svg.appendChild(line);

    // Y-axis label
    const val = yMax - (i / numGridLines) * (yMax - yMin);
    const label = document.createElementNS(NS, 'text');
    label.setAttribute('x', margin.left - 8);
    label.setAttribute('y', y + 4);
    label.setAttribute('text-anchor', 'end');
    label.setAttribute('fill', colors.axis);
    label.setAttribute('font-size', '11');
    label.setAttribute('font-family', 'inherit');
    label.textContent = val >= 1000 ? (val / 1000).toFixed(1) + 'k' : Math.round(val);
    svg.appendChild(label);
  }

  // X-axis labels (show ~6 labels max to avoid crowding)
  const maxLabels = Math.min(data.length, Math.max(3, Math.floor(chartW / 60)));
  const step = Math.max(1, Math.floor((data.length - 1) / (maxLabels - 1)));
  for (let i = 0; i < data.length; i += step) {
    const x = xScale(i);
    const dateStr = data[i].date;
    // Parse date — handle both "YYYY-MM-DD" and ISO formats
    const d = new Date(dateStr);
    const label = `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;

    const text = document.createElementNS(NS, 'text');
    text.setAttribute('x', x);
    text.setAttribute('y', margin.top + chartH + 20);
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('fill', colors.axis);
    text.setAttribute('font-size', '11');
    text.setAttribute('font-family', 'inherit');
    text.textContent = label;
    svg.appendChild(text);

    // Small tick
    const tick = document.createElementNS(NS, 'line');
    tick.setAttribute('x1', x);
    tick.setAttribute('x2', x);
    tick.setAttribute('y1', margin.top + chartH);
    tick.setAttribute('y2', margin.top + chartH + 5);
    tick.setAttribute('stroke', colors.axis);
    tick.setAttribute('stroke-width', '1');
    svg.appendChild(tick);
  }
  // Last label if not already shown
  if ((data.length - 1) % step !== 0) {
    const i = data.length - 1;
    const x = xScale(i);
    const d = new Date(data[i].date);
    const label = `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
    const text = document.createElementNS(NS, 'text');
    text.setAttribute('x', x);
    text.setAttribute('y', margin.top + chartH + 20);
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('fill', colors.axis);
    text.setAttribute('font-size', '11');
    text.setAttribute('font-family', 'inherit');
    text.textContent = label;
    svg.appendChild(text);
  }

  // Axes
  // Y axis
  const yAxis = document.createElementNS(NS, 'line');
  yAxis.setAttribute('x1', margin.left);
  yAxis.setAttribute('x2', margin.left);
  yAxis.setAttribute('y1', margin.top);
  yAxis.setAttribute('y2', margin.top + chartH);
  yAxis.setAttribute('stroke', colors.axis);
  yAxis.setAttribute('stroke-width', '1.5');
  svg.appendChild(yAxis);

  // X axis
  const xAxis = document.createElementNS(NS, 'line');
  xAxis.setAttribute('x1', margin.left);
  xAxis.setAttribute('x2', margin.left + chartW);
  xAxis.setAttribute('y1', margin.top + chartH);
  xAxis.setAttribute('y2', margin.top + chartH);
  xAxis.setAttribute('stroke', colors.axis);
  xAxis.setAttribute('stroke-width', '1.5');
  svg.appendChild(xAxis);

  // Area fill
  let areaPath = `M ${xScale(0)},${margin.top + chartH}`;
  for (let i = 0; i < data.length; i++) {
    areaPath += ` L ${xScale(i)},${yScale(data[i].visitors)}`;
  }
  areaPath += ` L ${xScale(data.length - 1)},${margin.top + chartH} Z`;

  const area = document.createElementNS(NS, 'path');
  area.setAttribute('d', areaPath);
  area.setAttribute('fill', colors.fill);
  svg.appendChild(area);

  // Line
  let linePath = '';
  for (let i = 0; i < data.length; i++) {
    const x = xScale(i);
    const y = yScale(data[i].visitors);
    linePath += (i === 0 ? 'M ' : ' L ') + `${x},${y}`;
  }

  const line = document.createElementNS(NS, 'path');
  line.setAttribute('d', linePath);
  line.setAttribute('fill', 'none');
  line.setAttribute('stroke', colors.line);
  line.setAttribute('stroke-width', '2.5');
  line.setAttribute('stroke-linejoin', 'round');
  line.setAttribute('stroke-linecap', 'round');
  svg.appendChild(line);

  // Data dots
  for (let i = 0; i < data.length; i++) {
    const cx = xScale(i);
    const cy = yScale(data[i].visitors);

    const dot = document.createElementNS(NS, 'circle');
    dot.setAttribute('cx', cx);
    dot.setAttribute('cy', cy);
    dot.setAttribute('r', '3');
    dot.setAttribute('fill', colors.dot);
    dot.setAttribute('stroke', colors.tooltip);
    dot.setAttribute('stroke-width', '1.5');
    svg.appendChild(dot);
  }

  // Y-axis title
  const yTitle = document.createElementNS(NS, 'text');
  yTitle.setAttribute('x', 14);
  yTitle.setAttribute('y', margin.top + chartH / 2);
  yTitle.setAttribute('text-anchor', 'middle');
  yTitle.setAttribute('fill', colors.axis);
  yTitle.setAttribute('font-size', '11');
  yTitle.setAttribute('font-family', 'inherit');
  yTitle.setAttribute('transform', `rotate(-90, 14, ${margin.top + chartH / 2})`);
  yTitle.textContent = 'Visitors';
  svg.appendChild(yTitle);

  container.appendChild(svg);
}
