import { vi } from 'vitest';

/** Minimal recording CanvasRenderingContext2D stand-in for jsdom. */
export function installCanvasStub() {
  const calls: Record<string, number> = {};
  const ctx: Record<string, unknown> = {
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    globalAlpha: 1,
    font: '10px serif',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    lineCap: 'butt',
    lineJoin: 'miter',
    measureText: (s: string) => ({ width: s.length * 6 }),
  };
  for (const m of [
    'save', 'restore', 'setTransform', 'transform', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'arc', 'rect',
    'fill', 'stroke', 'fillRect', 'clearRect', 'fillText', 'setLineDash', 'drawImage',
  ]) {
    ctx[m] = () => {
      calls[m] = (calls[m] ?? 0) + 1;
    };
  }
  const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((type: string) =>
    type === '2d' ? (ctx as unknown as CanvasRenderingContext2D) : null) as unknown as HTMLCanvasElement['getContext']);
  return { ctx, calls, spy };
}

/** window.Image replacement that resolves load/error asynchronously. */
export function installImageStub(mode: 'load' | 'error', size = { w: 1024, h: 891 }) {
  const created: Array<{ src: string }> = [];
  class FakeImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    decoding = 'auto';
    naturalWidth = 0;
    naturalHeight = 0;
    width = 0;
    height = 0;
    private _src = '';
    get src() {
      return this._src;
    }
    set src(v: string) {
      this._src = v;
      created.push(this);
      setTimeout(() => {
        if (mode === 'load') {
          this.naturalWidth = this.width = size.w;
          this.naturalHeight = this.height = size.h;
          this.onload?.();
        } else {
          this.onerror?.();
        }
      }, 0);
    }
  }
  const w = window as unknown as { Image: unknown };
  const original = w.Image;
  vi.stubGlobal('Image', FakeImage);
  w.Image = FakeImage;
  return {
    created,
    restore: () => {
      w.Image = original;
    },
  };
}
