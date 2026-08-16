/** Hand-drawn SVG time-series line chart. */

import type { TimeseriesPoint } from "./api";

const SVG_NS = "http://www.w3.org/2000/svg";

function el(tag: string, attrs: Record<string, string | number> = {}): SVGElement {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    e.setAttribute(k, String(v));
  }
  return e;
}

function getCSSVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function niceStep(range: number, targetTicks: number): number {
  if (range <= 0 || targetTicks <= 0) return 1;
  const rough = range / targetTicks;
  if (rough <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const residual = rough / mag;
  let nice: number;
  if (residual <= 1.5) nice = 1;
  else if (residual <= 3) nice = 2;
  else if (residual <= 7) nice = 5;
  else nice = 10;
  return nice * mag;
}

export function drawChart(
  container: HTMLElement,
  data: TimeseriesPoint[]
): void {
  // Clear old content
  container.innerHTML = "";

  if (data.length === 0) {
    container.textContent = "No data available.";
    return;
  }

  const rect = container.getBoundingClientRect();
  const width = Math.floor(rect.width);
  const height = Math.max(200, Math.min(400, Math.floor(width * 0.45)));

  // Margins
  const marginTop = 16;
  const marginRight = 20;
  const marginBottom = 48;
  const marginLeft = 52;

  const plotW = width - marginLeft - marginRight;
  const plotH = height - marginTop - marginBottom;

  if (plotW < 40 || plotH < 40) {
    container.textContent = "Container too small";
    return;
  }

  // Data bounds
  const values = data.map((d) => d.visitors);
  const minVal = 0;
  const rawMax = Math.max(...values);
  const step = niceStep(rawMax - minVal, 5);
  const maxVal = Math.ceil(rawMax / step) * step;

  // Scales
  const xScale = (i: number) => marginLeft + (i / (data.length - 1)) * plotW;
  const yScale = (v: number) => marginTop + plotH - ((v - minVal) / (maxVal - minVal)) * plotH;

  // Theme colors
  const gridColor = getCSSVar("--chart-grid");
  const axisColor = getCSSVar("--chart-axis");
  const lineColor = getCSSVar("--chart-line");
  const fillColor = getCSSVar("--chart-fill");
  const dotColor = getCSSVar("--chart-dot");

  // Build SVG
  const svg = el("svg", {
    width,
    height,
    viewBox: `0 0 ${width} ${height}`,
    "aria-label": "Daily visitors line chart",
    role: "img",
  }) as SVGSVGElement;
  svg.style.display = "block";
  svg.style.width = "100%";
  svg.style.height = "auto";

  // Y-axis gridlines and labels
  for (let v = minVal; v <= maxVal; v += step) {
    const y = yScale(v);
    // Gridline
    svg.appendChild(
      el("line", {
        x1: marginLeft,
        y1: y,
        x2: width - marginRight,
        y2: y,
        stroke: gridColor,
        "stroke-width": 1,
        "stroke-dasharray": "3,3",
      })
    );
    // Label
    const label = el("text", {
      x: marginLeft - 8,
      y: y + 4,
      "text-anchor": "end",
      fill: axisColor,
      "font-size": 11,
    });
    label.textContent = v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v);
    svg.appendChild(label);
  }

  // X-axis labels — show every Nth date to avoid overlap
  const labelEvery = data.length <= 10 ? 1 : data.length <= 20 ? 3 : 5;
  data.forEach((d, i) => {
    if (i % labelEvery === 0 || i === data.length - 1) {
      const x = xScale(i);
      // Tick
      svg.appendChild(
        el("line", {
          x1: x,
          y1: marginTop + plotH,
          x2: x,
          y2: marginTop + plotH + 6,
          stroke: axisColor,
          "stroke-width": 1,
        })
      );
      const label = el("text", {
        x,
        y: marginTop + plotH + 22,
        "text-anchor": "middle",
        fill: axisColor,
        "font-size": 10,
      });
      // Format date as MM/DD
      const parts = d.date.split("-");
      label.textContent = `${parts[1]}/${parts[2]}`;
      svg.appendChild(label);
    }
  });

  // Axes
  // Y axis
  svg.appendChild(
    el("line", {
      x1: marginLeft,
      y1: marginTop,
      x2: marginLeft,
      y2: marginTop + plotH,
      stroke: axisColor,
      "stroke-width": 1,
    })
  );
  // X axis
  svg.appendChild(
    el("line", {
      x1: marginLeft,
      y1: marginTop + plotH,
      x2: width - marginRight,
      y2: marginTop + plotH,
      stroke: axisColor,
      "stroke-width": 1,
    })
  );

  // Area fill
  const areaPoints = data.map((d, i) => `${xScale(i)},${yScale(d.visitors)}`);
  areaPoints.push(`${xScale(data.length - 1)},${yScale(minVal)}`);
  areaPoints.push(`${xScale(0)},${yScale(minVal)}`);
  svg.appendChild(
    el("polygon", {
      points: areaPoints.join(" "),
      fill: fillColor,
    })
  );

  // Line
  const linePoints = data.map((d, i) => `${xScale(i)},${yScale(d.visitors)}`).join(" ");
  svg.appendChild(
    el("polyline", {
      points: linePoints,
      fill: "none",
      stroke: lineColor,
      "stroke-width": 2,
      "stroke-linejoin": "round",
      "stroke-linecap": "round",
    })
  );

  // Dots (only if not too many)
  if (data.length <= 31) {
    data.forEach((d, i) => {
      svg.appendChild(
        el("circle", {
          cx: xScale(i),
          cy: yScale(d.visitors),
          r: 3,
          fill: dotColor,
          stroke: getCSSVar("--bg-card"),
          "stroke-width": 1.5,
        })
      );
    });
  }

  container.appendChild(svg);
}
