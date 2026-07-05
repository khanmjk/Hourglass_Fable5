/* Live theory-vs-measured chart. The soul of the bench: if the twin is
   honest, the solid curve hugs the dashed one. */
export class BenchChart {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.samples = []; // {tau, p}
    this.theoryFn = (t) => t;
    this.resize();
  }
  resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth || 272, h = this.canvas.clientHeight || 130;
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = w; this.h = h;
  }
  reset(theoryFn) {
    this.samples = [];
    if (theoryFn) this.theoryFn = theoryFn;
    this.draw();
  }
  push(tau, p) {
    const last = this.samples[this.samples.length - 1];
    if (last && tau - last.tau < 0.004) return;
    this.samples.push({ tau: Math.min(tau, 1.2), p: Math.max(0, Math.min(1, p)) });
    if (this.samples.length > 600) this.samples.splice(0, 200);
  }
  meanErrorPct() {
    if (this.samples.length < 4) return null;
    let s = 0, n = 0;
    for (const { tau, p } of this.samples) {
      if (tau > 1) continue;
      s += Math.abs(p - this.theoryFn(tau)); n++;
    }
    return n ? (s / n) * 100 : null;
  }
  draw() {
    const { ctx, w, h } = this;
    const L = 26, B = 16, T = 6, R = 6;
    const px = (tau) => L + (w - L - R) * Math.min(tau, 1);
    const py = (p) => h - B - (h - B - T) * p;
    ctx.clearRect(0, 0, w, h);
    // frame + gridlines
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.lineWidth = 1;
    ctx.strokeRect(L, T, w - L - R, h - T - B);
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    for (const f of [0.25, 0.5, 0.75]) {
      ctx.beginPath(); ctx.moveTo(px(f), T); ctx.lineTo(px(f), h - B); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(L, py(f)); ctx.lineTo(w - R, py(f)); ctx.stroke();
    }
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.font = '9px system-ui';
    ctx.fillText('0', L - 8, h - B + 10);
    ctx.fillText('t/T →', w - 34, h - B + 12);
    ctx.save();
    ctx.translate(8, h / 2 + 14); ctx.rotate(-Math.PI / 2);
    ctx.fillText('progress', 0, 0);
    ctx.restore();
    // theory (dashed)
    ctx.strokeStyle = 'rgba(240,201,135,0.55)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    for (let i = 0; i <= 60; i++) {
      const t = i / 60;
      const y = py(Math.max(0, Math.min(1, this.theoryFn(t))));
      i === 0 ? ctx.moveTo(px(t), y) : ctx.lineTo(px(t), y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    // measured (solid)
    if (this.samples.length > 1) {
      ctx.strokeStyle = '#7fd08f';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      this.samples.forEach((s, i) => {
        i === 0 ? ctx.moveTo(px(s.tau), py(s.p)) : ctx.lineTo(px(s.tau), py(s.p));
      });
      ctx.stroke();
    }
  }
}
