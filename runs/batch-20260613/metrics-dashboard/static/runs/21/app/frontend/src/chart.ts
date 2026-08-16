import type { TimeSeriesPoint } from './api';

/**
 * Hand-drawn SVG time-series line chart.
 * Redraws to fit its container on resize.
 * Returns an object with redraw() and destroy() methods.
 */
export interface ChartHandle {
  redraw: () => void;
  destroy: () => void;
}

export function createChart(container: HTMLElement, data: TimeSeriesPoint[]): ChartHandle {
  function getThemeColors(): {
    gridColor: string;
    axisColor: string;
    lineColor: string;
    fillColor: string;
    textColor: string;
  } {
    const style = getComputedStyle(document.documentElement);
    return {
      gridColor: style.getPropertyValue('--color-chart-grid').trim() || '#e5e7eb',
      axisColor: style.getPropertyValue('--color-chart-axis').trim() || '#6b7280',
      lineColor: style.getPropertyValue('--color-chart-line').trim() || '#3b82f6',
      fillColor: style.getPropertyValue('--color-chart-fill').trim() || 'rgba(59,130,246,0.1)',
      textColor: style.getPropertyValue('--color-chart-axis').trim() || '#6b7280',
    };
  }

  function render(): void {
    container.innerHTML = '';

    if (data.length === 0) {
      container.textContent = 'No data to display';
      return;
    }

    const containerWidth = container.clientWidth;
    if (containerWidth === 0) return;

    const containerHeight = Math.max(200, Math.min(containerWidth * 0.45, 350));

    const margin = { top: 20, right: 20, bottom: 50, left: 55 };
    const width = containerWidth - margin.left - margin.right;
    const height = containerHeight - margin.top - margin.bottom;

    if (width <= 0 || height <= 0) return;

    const colors = getThemeColors();

    const visitors = data.map(d => d.visitors);
    const minVal = Math.min(...visitors);
    const maxVal = Math.max(...visitors);
    const valRange = maxVal - minVal || 1;
    const yPadding = valRange * 0.1;
    const yMin = Math.max(0, minVal - yPadding);
    const yMax = maxVal + yPadding;

    function xScale(i: number): number {
      return margin.left + (i / (data.length - 1)) * width;
    }

    function yScale(v: number): number {
      return margin.top + height - ((v - yMin) / (yMax - yMin)) * height;
    }

    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `0 0 ${containerWidth} ${containerHeight}`);
    svg.setAttribute('width', String(containerWidth));
    svg.setAttribute('height', String(containerHeight));
    svg.style.display = 'block';
    svg.style.width = '100%';
    svg.style.height = 'auto';
    svg.setAttribute('aria-label', 'Visitors time-series chart');
    svg.setAttribute('role', 'img');

    // Gridlines (horizontal)
    const numGridlines = 5;
    for (let i = 0; i <= numGridlines; i++) {
      const yVal = yMin + (i / numGridlines) * (yMax - yMin);
      const y = yScale(yVal);

      const gridLine = document.createElementNS(ns, 'line');
      gridLine.setAttribute('x1', String(margin.left));
      gridLine.setAttribute('x2', String(margin.left + width));
      gridLine.setAttribute('y1', String(y));
      gridLine.setAttribute('y2', String(y));
      gridLine.setAttribute('stroke', colors.gridColor);
      gridLine.setAttribute('stroke-width', '1');
      gridLine.setAttribute('stroke-dasharray', '4,4');
      svg.appendChild(gridLine);

      // Y-axis labels
      const label = document.createElementNS(ns, 'text');
      label.setAttribute('x', String(margin.left - 8));
      label.setAttribute('y', String(y + 4));
      label.setAttribute('text-anchor', 'end');
      label.setAttribute('fill', colors.textColor);
      label.setAttribute('font-size', containerWidth < 500 ? '10' : '11');
      label.setAttribute('font-family', 'inherit');
      label.textContent = formatCompact(Math.round(yVal));
      svg.appendChild(label);
    }

    // Area fill under the line
    let areaPath = `M ${xScale(0)} ${yScale(visitors[0])}`;
    for (let i = 1; i < data.length; i++) {
      areaPath += ` L ${xScale(i)} ${yScale(visitors[i])}`;
    }
    areaPath += ` L ${xScale(data.length - 1)} ${margin.top + height}`;
    areaPath += ` L ${xScale(0)} ${margin.top + height} Z`;

    const area = document.createElementNS(ns, 'path');
    area.setAttribute('d', areaPath);
    area.setAttribute('fill', colors.fillColor);
    svg.appendChild(area);

    // Line path
    let linePath = `M ${xScale(0)} ${yScale(visitors[0])}`;
    for (let i = 1; i < data.length; i++) {
      linePath += ` L ${xScale(i)} ${yScale(visitors[i])}`;
    }

    const line = document.createElementNS(ns, 'path');
    line.setAttribute('d', linePath);
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', colors.lineColor);
    line.setAttribute('stroke-width', '2.5');
    line.setAttribute('stroke-linejoin', 'round');
    line.setAttribute('stroke-linecap', 'round');
    svg.appendChild(line);

    // Data point circles
    const pointRadius = containerWidth < 500 ? '2' : '3';
    for (let i = 0; i < data.length; i++) {
      const circle = document.createElementNS(ns, 'circle');
      circle.setAttribute('cx', String(xScale(i)));
      circle.setAttribute('cy', String(yScale(visitors[i])));
      circle.setAttribute('r', pointRadius);
      circle.setAttribute('fill', colors.lineColor);
      svg.appendChild(circle);
    }

    // X-axis date labels — show a subset to prevent crowding
    const labelInterval = containerWidth < 500 ? 7 : containerWidth < 800 ? 5 : 3;
    const fontSize = containerWidth < 500 ? '9' : '11';
    const xLabelY = margin.top + height + 20;

    for (let i = 0; i < data.length; i += labelInterval) {
      const text = document.createElementNS(ns, 'text');
      text.setAttribute('x', String(xScale(i)));
      text.setAttribute('y', String(xLabelY));
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('fill', colors.textColor);
      text.setAttribute('font-size', fontSize);
      text.setAttribute('font-family', 'inherit');
      const d = new Date(data[i].date);
      text.textContent = `${d.getMonth() + 1}/${d.getDate()}`;
      svg.appendChild(text);
    }

    // Always show the last date label if not already shown
    if ((data.length - 1) % labelInterval !== 0) {
      const text = document.createElementNS(ns, 'text');
      text.setAttribute('x', String(xScale(data.length - 1)));
      text.setAttribute('y', String(xLabelY));
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('fill', colors.textColor);
      text.setAttribute('font-size', fontSize);
      text.setAttribute('font-family', 'inherit');
      const d = new Date(data[data.length - 1].date);
      text.textContent = `${d.getMonth() + 1}/${d.getDate()}`;
      svg.appendChild(text);
    }

    // Y axis line
    const yAxisLine = document.createElementNS(ns, 'line');
    yAxisLine.setAttribute('x1', String(margin.left));
    yAxisLine.setAttribute('x2', String(margin.left));
    yAxisLine.setAttribute('y1', String(margin.top));
    yAxisLine.setAttribute('y2', String(margin.top + height));
    yAxisLine.setAttribute('stroke', colors.axisColor);
    yAxisLine.setAttribute('stroke-width', '1');
    svg.appendChild(yAxisLine);

    // X axis line
    const xAxisLine = document.createElementNS(ns, 'line');
    xAxisLine.setAttribute('x1', String(margin.left));
    xAxisLine.setAttribute('x2', String(margin.left + width));
    xAxisLine.setAttribute('y1', String(margin.top + height));
    xAxisLine.setAttribute('y2', String(margin.top + height));
    xAxisLine.setAttribute('stroke', colors.axisColor);
    xAxisLine.setAttribute('stroke-width', '1');
    svg.appendChild(xAxisLine);

    container.appendChild(svg);
  }

  // Initial render
  render();

  // Debounced resize handler
  let resizeTimeout: ReturnType<typeof setTimeout>;
  function onResize(): void {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(render, 100);
  }

  const resizeObserver = new ResizeObserver(() => {
    onResize();
  });
  resizeObserver.observe(container);

  return {
    redraw: render,
    destroy(): void {
      resizeObserver.disconnect();
      clearTimeout(resizeTimeout);
    },
  };
}

function formatCompact(n: number): string {
  if (n >= 1000) {
    return n.toLocaleString('en-US');
  }
  return String(n);
}
