import type { Canvas2DContextLike, CanvasTextMetricsLike } from '../../src/types';

export interface RecordedCall {
  op: string;
  args: unknown[];
  state: {
    fillStyle: string;
    strokeStyle: string;
    globalAlpha: number;
    lineWidth: number;
    lineDash: number[];
    lineJoin: string;
    lineCap: string;
    textAlign: string;
    textBaseline: string;
    transform: number[];
    font: string;
    filter?: string;
    composite?: string;
  };
}

/** Records every Canvas 2D call for deterministic pure-Node assertions. */
export class MockCanvas2DContext implements Canvas2DContextLike {
  fillStyle: string | object = '#000';
  strokeStyle: string | object = '#000';
  lineWidth = 1;
  globalAlpha = 1;
  font = '10px sans-serif';
  textAlign = 'start';
  textBaseline = 'alphabetic';
  lineCap = 'butt';
  lineJoin = 'miter';
  declare filter?: string;
  declare globalCompositeOperation?: string;
  calls: RecordedCall[] = [];
  private matrix = [1, 0, 0, 1, 0, 0];
  private lineDash: number[] = [];
  private stack: Array<Record<string, unknown>> = [];

  protected rec(op: string, args: unknown[]): void {
    this.calls.push({
      op,
      args,
      state: {
        fillStyle: String(this.fillStyle),
        strokeStyle: String(this.strokeStyle),
        globalAlpha: this.globalAlpha,
        lineWidth: this.lineWidth,
        lineDash: [...this.lineDash],
        lineJoin: this.lineJoin,
        lineCap: this.lineCap,
        textAlign: this.textAlign,
        textBaseline: this.textBaseline,
        transform: [...this.matrix],
        font: this.font,
        filter: this.filter,
        composite: this.globalCompositeOperation,
      },
    });
  }

  save(): void {
    this.stack.push({
      matrix: [...this.matrix],
      fillStyle: this.fillStyle,
      strokeStyle: this.strokeStyle,
      lineWidth: this.lineWidth,
      globalAlpha: this.globalAlpha,
      font: this.font,
      lineJoin: this.lineJoin,
      lineCap: this.lineCap,
      textAlign: this.textAlign,
      textBaseline: this.textBaseline,
      lineDash: [...this.lineDash],
    });
    this.rec('save', []);
  }
  restore(): void {
    const s = this.stack.pop();
    if (s) {
      this.matrix = s.matrix as number[];
      this.fillStyle = s.fillStyle as string;
      this.strokeStyle = s.strokeStyle as string;
      this.lineWidth = s.lineWidth as number;
      this.globalAlpha = s.globalAlpha as number;
      this.font = s.font as string;
      this.lineJoin = s.lineJoin as string;
      this.lineCap = s.lineCap as string;
      this.textAlign = s.textAlign as string;
      this.textBaseline = s.textBaseline as string;
      this.lineDash = s.lineDash as number[];
    }
    this.rec('restore', []);
  }
  setTransform(...a: number[]): void {
    this.matrix = [...a];
    this.rec('setTransform', a);
  }
  transform(...args: number[]): void {
    const [a, b, c, d, e, f] = this.matrix;
    const [u, v, w, x, y, z] = args;
    this.matrix = [a * u + c * v, b * u + d * v, a * w + c * x, b * w + d * x, a * y + c * z + e, b * y + d * z + f];
    this.rec('transform', args);
  }
  beginPath(): void { this.rec('beginPath', []); }
  closePath(): void { this.rec('closePath', []); }
  moveTo(x: number, y: number): void { this.rec('moveTo', [x, y]); }
  lineTo(x: number, y: number): void { this.rec('lineTo', [x, y]); }
  arc(...a: unknown[]): void { this.rec('arc', a); }
  rect(...a: number[]): void { this.rec('rect', a); }
  fill(): void { this.rec('fill', []); }
  stroke(): void { this.rec('stroke', []); }
  fillRect(...a: number[]): void { this.rec('fillRect', a); }
  clearRect(...a: number[]): void { this.rec('clearRect', a); }
  fillText(...a: unknown[]): void { this.rec('fillText', a); }
  setLineDash(seg: number[]): void { this.lineDash = [...seg]; this.rec('setLineDash', [[...seg]]); }
  drawImage(...a: unknown[]): void { this.rec('drawImage', a); }
  measureText(text: string): CanvasTextMetricsLike {
    return { width: text.length * 6 };
  }

  ops(op: string): RecordedCall[] {
    return this.calls.filter((c) => c.op === op);
  }
  texts(): string[] {
    return this.ops('fillText').map((c) => String(c.args[0]));
  }
  reset(): void {
    this.calls = [];
  }
}
