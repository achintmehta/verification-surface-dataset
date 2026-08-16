// Hand-drawn SVG line chart. No chart library. The chart is given a host
// element; it measures that host and draws an SVG that fits exactly, and it
// re-renders whenever the host is resized (ResizeObserver).

const SVG_NS = 'http://www.w3.org/2000/svg';

function el(name, attrs = {}) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) {
    node.setAttribute(k, String(v));
  }
  return node;
}

function niceTicks(min, max, count) {
  // Produce ~count "nice" round tick values across [min, max].
  const span = max - min || 1;
  const rawStep = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  let step;
  if (norm < 1.5) step = 1;
  else if (norm < 3) step = 2;
  else if (norm < 7) step = 5;
  else step = 10;
  step *= mag;
  const start = Math.floor(min / step) * step;
  const ticks = [];
  for (let v = start; v <= max + step * 0.5; v += step) {
    if (v >= min - step * 0.5) ticks.push(v);
  }
  return ticks;
}

function formatTick(v) {
  if (v >= 1000) return (v / 1000).toFixed(v % 1000 === 0 ? 0 : 1) + 'k';
  return String(Math.round(v));
}

export function createChart(host) {
  let data = [];

  function draw() {
    const width = host.clientWidth;
    const height = host.clientHeight;
    if (!width || !height) return;

    host.replaceChildren();
    const svg = el('svg', {
      viewBox: `0 0 ${width} ${height}`,
      width,
      height,
      preserveAspectRatio: 'none',
    });

    if (!data || data.length === 0) {
      const t = el('text', {
        x: width / 2,
        y: height / 2,
        'text-anchor': 'middle',
        class: 'chart-axis-text',
      });
      t.textContent = 'No data';
      svg.appendChild(t);
      host.appendChild(svg);
      return;
    }

    // Plot margins leave room for axis labels.
    const m = { top: 12, right: 14, bottom: 26, left: 44 };
    const plotW = Math.max(1, width - m.left - m.right);
    const plotH = Math.max(1, height - m.top - m.bottom);

    const values = data.map((d) => d.visitors);
    const maxV = Math.max(...values);
    const minV = Math.min(...values);
    // Pad the domain a bit and floor at zero baseline for readability.
    const domainMin = Math.max(0, Math.floor(minV * 0.9));
    const domainMax = Math.ceil(maxV * 1.05);

    const xAt = (i) =>
      m.left + (data.length === 1 ? plotW / 2 : (i / (data.length - 1)) * plotW);
    const yAt = (v) =>
      m.top + plotH - ((v - domainMin) / (domainMax - domainMin || 1)) * plotH;

    // ---- Horizontal gridlines + y tick labels ----
    const yTicks = niceTicks(domainMin, domainMax, 4);
    for (const tv of yTicks) {
      const y = yAt(tv);
      svg.appendChild(
        el('line', {
          x1: m.left,
          y1: y,
          x2: m.left + plotW,
          y2: y,
          class: 'chart-grid-line',
        })
      );
      const label = el('text', {
        x: m.left - 8,
        y: y + 3.5,
        'text-anchor': 'end',
        class: 'chart-axis-text',
      });
      label.textContent = formatTick(tv);
      svg.appendChild(label);
    }

    // ---- Axes ----
    svg.appendChild(
      el('line', { x1: m.left, y1: m.top, x2: m.left, y2: m.top + plotH, class: 'chart-axis' })
    );
    svg.appendChild(
      el('line', {
        x1: m.left,
        y1: m.top + plotH,
        x2: m.left + plotW,
        y2: m.top + plotH,
        class: 'chart-axis',
      })
    );

    // ---- X tick labels (first, ~middle, last) ----
    const xTickIdx = [0, Math.floor((data.length - 1) / 2), data.length - 1];
    const seen = new Set();
    for (const i of xTickIdx) {
      if (seen.has(i)) continue;
      seen.add(i);
      const d = data[i];
      const label = el('text', {
        x: xAt(i),
        y: m.top + plotH + 16,
        'text-anchor': i === 0 ? 'start' : i === data.length - 1 ? 'end' : 'middle',
        class: 'chart-axis-text',
      });
      label.textContent = d.day.slice(5); // MM-DD
      svg.appendChild(label);
    }

    // ---- Area fill under the line ----
    let areaPath = `M ${xAt(0)} ${m.top + plotH}`;
    data.forEach((d, i) => {
      areaPath += ` L ${xAt(i)} ${yAt(d.visitors)}`;
    });
    areaPath += ` L ${xAt(data.length - 1)} ${m.top + plotH} Z`;
    svg.appendChild(el('path', { d: areaPath, class: 'chart-area' }));

    // ---- Series line ----
    let linePath = '';
    data.forEach((d, i) => {
      linePath += `${i === 0 ? 'M' : 'L'} ${xAt(i)} ${yAt(d.visitors)} `;
    });
    svg.appendChild(el('path', { d: linePath.trim(), class: 'chart-series' }));

    host.appendChild(svg);
  }

  // Re-render on container resize so the chart always fits and stays crisp.
  const ro = new ResizeObserver(() => draw());
  ro.observe(host);
  window.addEventListener('resize', draw);

  return {
    setData(d) {
      data = Array.isArray(d) ? d : [];
      draw();
    },
    redraw: draw,
    destroy() {
      ro.disconnect();
      window.removeEventListener('resize', draw);
    },
  };
}
