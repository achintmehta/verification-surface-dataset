export class TimeseriesChart {
  constructor(canvasId) {
    this.canvas = document.getElementById(canvasId);
    this.ctx = this.canvas.getContext('2d');
    this.data = [];
    
    this.resizeObserver = new ResizeObserver(() => {
      this.draw();
    });
    this.resizeObserver.observe(this.canvas.parentElement);
  }

  setData(data) {
    this.data = data;
    this.draw();
  }

  draw() {
    if (!this.data || this.data.length === 0) return;

    const parent = this.canvas.parentElement;
    const rect = parent.getBoundingClientRect();
    
    // Handle high DPI displays
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    
    this.ctx.scale(dpr, dpr);
    
    const width = rect.width;
    const height = rect.height;

    this.ctx.clearRect(0, 0, width, height);

    const style = getComputedStyle(document.documentElement);
    const axisColor = style.getPropertyValue('--chart-axis').trim();
    const gridColor = style.getPropertyValue('--chart-grid').trim();
    const lineColor = style.getPropertyValue('--chart-line').trim();
    const fillColor = style.getPropertyValue('--chart-fill').trim();
    const textColor = style.getPropertyValue('--text-color').trim();

    const padding = { top: 20, right: 20, bottom: 30, left: 50 };
    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;

    const maxRevenue = Math.max(...this.data.map(d => parseFloat(d.revenue)), 1);
    const minRevenue = 0; // Start Y axis at 0

    // Draw grid and Y axis labels
    this.ctx.font = '12px sans-serif';
    this.ctx.fillStyle = axisColor;
    this.ctx.textAlign = 'right';
    this.ctx.textBaseline = 'middle';

    const yTicks = 5;
    for (let i = 0; i <= yTicks; i++) {
      const yVal = minRevenue + (maxRevenue - minRevenue) * (i / yTicks);
      const yPos = padding.top + chartHeight - (chartHeight * (i / yTicks));

      // Grid line
      this.ctx.beginPath();
      this.ctx.moveTo(padding.left, yPos);
      this.ctx.lineTo(width - padding.right, yPos);
      this.ctx.strokeStyle = gridColor;
      this.ctx.lineWidth = 1;
      this.ctx.stroke();

      // Label
      this.ctx.fillText(Math.round(yVal).toString(), padding.left - 10, yPos);
    }

    // Draw X axis labels (show ~5 labels to avoid crowding)
    this.ctx.textAlign = 'center';
    this.ctx.textBaseline = 'top';
    const xTicks = 5;
    for (let i = 0; i <= xTicks; i++) {
      const dataIndex = Math.floor((this.data.length - 1) * (i / xTicks));
      const d = this.data[dataIndex];
      if (!d) continue;
      
      const xPos = padding.left + (chartWidth * (dataIndex / (this.data.length - 1)));
      
      // Format date (MM-DD)
      const dateObj = new Date(d.date);
      const dateStr = \`\${dateObj.getMonth() + 1}/\${dateObj.getDate()}\`;
      
      this.ctx.fillText(dateStr, xPos, height - padding.bottom + 10);
    }

    // Draw line and fill
    this.ctx.beginPath();
    this.ctx.moveTo(padding.left, padding.top + chartHeight);

    const points = this.data.map((d, i) => {
      const x = padding.left + (chartWidth * (i / (this.data.length - 1)));
      const y = padding.top + chartHeight - (chartHeight * (parseFloat(d.revenue) / maxRevenue));
      return { x, y };
    });

    points.forEach((p, i) => {
      if (i === 0) {
        this.ctx.lineTo(p.x, p.y);
      } else {
        this.ctx.lineTo(p.x, p.y);
      }
    });

    // Fill
    this.ctx.lineTo(points[points.length - 1].x, padding.top + chartHeight);
    this.ctx.fillStyle = fillColor;
    this.ctx.fill();

    // Line
    this.ctx.beginPath();
    points.forEach((p, i) => {
      if (i === 0) {
        this.ctx.moveTo(p.x, p.y);
      } else {
        this.ctx.lineTo(p.x, p.y);
      }
    });
    this.ctx.strokeStyle = lineColor;
    this.ctx.lineWidth = 2;
    this.ctx.stroke();
  }
}
