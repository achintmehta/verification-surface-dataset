export class TimeseriesChart {
  constructor(canvasId) {
    this.canvas = document.getElementById(canvasId);
    this.ctx = this.canvas.getContext('2d');
    this.data = [];
    
    this.resizeObserver = new ResizeObserver(() => this.draw());
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
    
    this.canvas.style.width = \`\${rect.width}px\`;
    this.canvas.style.height = \`\${rect.height}px\`;

    const width = rect.width;
    const height = rect.height;

    this.ctx.clearRect(0, 0, width, height);

    const style = getComputedStyle(document.documentElement);
    const lineColor = style.getPropertyValue('--chart-line').trim();
    const gridColor = style.getPropertyValue('--chart-grid').trim();
    const textColor = style.getPropertyValue('--chart-text').trim();

    const padding = { top: 20, right: 20, bottom: 30, left: 50 };
    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;

    const revenues = this.data.map(d => parseFloat(d.revenue));
    const maxRev = Math.max(...revenues);
    const minRev = 0; // Start y-axis at 0

    // Draw grid and Y-axis labels
    this.ctx.fillStyle = textColor;
    this.ctx.strokeStyle = gridColor;
    this.ctx.lineWidth = 1;
    this.ctx.font = '12px sans-serif';
    this.ctx.textAlign = 'right';
    this.ctx.textBaseline = 'middle';

    const yTicks = 5;
    for (let i = 0; i <= yTicks; i++) {
      const val = minRev + (maxRev - minRev) * (i / yTicks);
      const y = padding.top + chartHeight - (chartHeight * (i / yTicks));
      
      this.ctx.beginPath();
      this.ctx.moveTo(padding.left, y);
      this.ctx.lineTo(width - padding.right, y);
      this.ctx.stroke();

      this.ctx.fillText(Math.round(val).toLocaleString(), padding.left - 10, y);
    }

    // Draw X-axis labels (ticks)
    this.ctx.textAlign = 'center';
    this.ctx.textBaseline = 'top';
    const xTicks = 5;
    for (let i = 0; i <= xTicks; i++) {
      const index = Math.floor((this.data.length - 1) * (i / xTicks));
      const d = this.data[index];
      if (!d) continue;
      
      const x = padding.left + (chartWidth * (index / (this.data.length - 1)));
      const dateStr = new Date(d.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      
      this.ctx.fillText(dateStr, x, padding.top + chartHeight + 10);
    }

    // Draw line
    this.ctx.strokeStyle = lineColor;
    this.ctx.lineWidth = 2;
    this.ctx.beginPath();
    
    this.data.forEach((d, i) => {
      const x = padding.left + (chartWidth * (i / (this.data.length - 1)));
      const y = padding.top + chartHeight - (chartHeight * (parseFloat(d.revenue) / maxRev));
      
      if (i === 0) {
        this.ctx.moveTo(x, y);
      } else {
        this.ctx.lineTo(x, y);
      }
    });
    
    this.ctx.stroke();
  }
}
