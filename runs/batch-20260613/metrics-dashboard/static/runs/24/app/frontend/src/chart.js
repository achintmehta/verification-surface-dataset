/**
 * Hand-drawn SVG time-series line chart.
 * Redraws to fit its container on every call.
 */

export function drawTimeseriesChart(data) {
  const svg = document.getElementById('timeseries-chart');
  if (!svg || !data || data.length === 0) return;

  const wrapper = document.getElementById('timeseries-wrapper');
  const containerWidth = wrapper.clientWidth;
  if (containerWidth <= 0) return;

  // Read theme-aware CSS custom properties
  const styles = getComputedStyle(document.documentElement);
  const colors = {
    grid: styles.getPropertyValue('--chart-grid').trim(),
    axis: styles.getPropertyValue('--chart-axis').trim(),
    line: styles.getPropertyValue('--chart-line').trim(),
    fill: styles.getPropertyValue('--chart-fill').trim(),
    dot: styles.getPropertyValue('--chart-dot').trim(),
    text: styles.getPropertyValue('--text-secondary').trim(),
  };

  // Dimensions
  const width = containerWidth;
  const height = 300;
  const margin = { top: 20, right: 20, bottom: 50, left: 55 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;

  // Data ranges
  const visitors = data.map((d) => d.visitors);
  const minV = Math.floor(Math.min(...visitors) * 0.9);
  const maxV = Math.ceil(Math.max(...visitors) * 1.1);

  // Scale helpers
  const xScale = (i) => margin.left + (i / (data.length - 1)) * plotW;
  const yScale = (v) => margin.top + plotH - ((v - minV) / (maxV - minV)) * plotH;

  // Build SVG content
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.innerHTML = '';

  const ns = 'http://www.w3.org/2000/svg';

  // Helper to create SVG elements
  function el(tag, attrs) {
    const e = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) {
      e.setAttribute(k, v);
    }
    return e;
  }

  // ── Gridlines (horizontal) ──
  const yTickCount = 5;
  const yStep = (maxV - minV) / yTickCount;
  for (let i = 0; i <= yTickCount; i++) {
    const val = minV + i * yStep;
    const y = yScale(val);
    svg.appendChild(
      el('line', {
        x1: margin.left,
        y1: y,
        x2: width - margin.right,
        y2: y,
        stroke: colors.grid,
        'stroke-width': 1,
        'stroke-dasharray': i === 0 ? 'none' : '4,4',
      })
    );
    // Y-axis label
    const label = el('text', {
      x: margin.left - 8,
      y: y + 4,
      fill: colors.text,
      'font-size': '11',
      'text-anchor': 'end',
      'font-family': 'sans-serif',
    });
    label.textContent = Math.round(val).toLocaleString();
    svg.appendChild(label);
  }

  // ── X-axis labels ──
  // Show ~6 labels evenly across the data
  const xLabelCount = Math.min(data.length, 6);
  const xLabelStep = Math.floor((data.length - 1) / (xLabelCount - 1));
  for (let i = 0; i < data.length; i += xLabelStep) {
    const x = xScale(i);
    const dateStr = data[i].date;
    const d = new Date(dateStr + 'T00:00:00');
    const labelText = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

    // Tick mark
    svg.appendChild(
      el('line', {
        x1: x,
        y1: margin.top + plotH,
        x2: x,
        y2: margin.top + plotH + 6,
        stroke: colors.axis,
        'stroke-width': 1,
      })
    );

    const label = el('text', {
      x: x,
      y: margin.top + plotH + 22,
      fill: colors.text,
      'font-size': '11',
      'text-anchor': 'middle',
      'font-family': 'sans-serif',
    });
    label.textContent = labelText;
    svg.appendChild(label);
  }

  // ── Axes ──
  // X axis line
  svg.appendChild(
    el('line', {
      x1: margin.left,
      y1: margin.top + plotH,
      x2: width - margin.right,
      y2: margin.top + plotH,
      stroke: colors.axis,
      'stroke-width': 1,
    })
  );
  // Y axis line
  svg.appendChild(
    el('line', {
      x1: margin.left,
      y1: margin.top,
      x2: margin.left,
      y2: margin.top + plotH,
      stroke: colors.axis,
      'stroke-width': 1,
    })
  );

  // ── Area fill ──
  let areaPath = `M ${xScale(0)} ${yScale(data[0].visitors)}`;
  for (let i = 1; i < data.length; i++) {
    areaPath += ` L ${xScale(i)} ${yScale(data[i].visitors)}`;
  }
  areaPath += ` L ${xScale(data.length - 1)} ${margin.top + plotH}`;
  areaPath += ` L ${xScale(0)} ${margin.top + plotH} Z`;

  svg.appendChild(
    el('path', {
      d: areaPath,
      fill: colors.fill,
      stroke: 'none',
    })
  );

  // ── Line ──
  let linePath = `M ${xScale(0)} ${yScale(data[0].visitors)}`;
  for (let i = 1; i < data.length; i++) {
    linePath += ` L ${xScale(i)} ${yScale(data[i].visitors)}`;
  }

  svg.appendChild(
    el('path', {
      d: linePath,
      fill: 'none',
      stroke: colors.line,
      'stroke-width': 2.5,
      'stroke-linejoin': 'round',
      'stroke-linecap': 'round',
    })
  );

  // ── Data dots ──
  for (let i = 0; i < data.length; i++) {
    svg.appendChild(
      el('circle', {
        cx: xScale(i),
        cy: yScale(data[i].visitors),
        r: 3,
        fill: colors.dot,
        stroke: '#fff',
        'stroke-width': 1,
      })
    );
  }

  // Y-axis title
  const yTitle = el('text', {
    x: 14,
    y: margin.top + plotH / 2,
    fill: colors.text,
    'font-size': '12',
    'text-anchor': 'middle',
    'font-family': 'sans-serif',
    transform: `rotate(-90, 14, ${margin.top + plotH / 2})`,
  });
  yTitle.textContent = 'Visitors';
  svg.appendChild(yTitle);
}
