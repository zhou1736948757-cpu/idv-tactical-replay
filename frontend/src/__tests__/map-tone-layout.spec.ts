import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import type { VisualPresetId } from '@idv/replay-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  analyzeHistogram,
  buildToneLut,
  computePercentile,
  getEnhancedMap,
  gradeSurveyPixels,
  resolveMapToneMaterial,
  solveGammaForMedian,
  type MapToneOptions,
} from '@/lib/mapTone';

const read = (file: string) => readFileSync(resolve(__dirname, '..', file), 'utf8');

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('map tone and layout contracts', () => {
  it('lifts a dark median while preserving monotonic tonal order', () => {
    const histogram = new Uint32Array(256);
    histogram[5] = 2;
    histogram[26] = 70;
    histogram[82] = 28;
    const stats = analyzeHistogram(histogram);
    expect(stats).toEqual({ p1: 5, p50: 26, p99: 82, narrow: false });
    const lut = buildToneLut(stats, 'clarity');
    expect(Math.abs(lut[26]! / 255 - 0.47)).toBeLessThan(0.03);
    expect(lut.every((value, i) => i === 0 || value >= lut[i - 1]!)).toBe(true);
    expect(0.25 ** solveGammaForMedian(0.25)).toBeCloseTo(0.47);
    expect(computePercentile(new Uint8Array(256), 0.5)).toBe(0);
  });

  it('guards strictly below 48 gray levels and keeps the three presets distinct', () => {
    const histogram = new Uint32Array(256);
    histogram[5] = 2;
    histogram[26] = 70;
    histogram[52] = 28;
    const stats = analyzeHistogram(histogram);
    expect(stats.narrow).toBe(true);
    expect(buildToneLut(stats, 'original')[26]).toBe(26);
    expect(buildToneLut(stats, 'dossier')[26]).toBeGreaterThan(26);
    expect(Math.abs(buildToneLut(stats, 'clarity')[26]! / 255 - 0.47)).toBeLessThan(0.03);
    histogram[52] = 0;
    histogram[53] = 28;
    expect(analyzeHistogram(histogram).narrow).toBe(false);
  });

  it('lifts the highlight percentile without changing the median or clipping the white point', () => {
    const stats = { p1: 12, p50: 39, p99: 70, narrow: false };
    const base = buildToneLut(stats, 'clarity');
    const lifted = buildToneLut(stats, 'clarity', 55);
    expect(lifted[39]).toBe(base[39]);
    expect(lifted[55]).toBe(204);
    expect(lifted[255]).toBe(base[255]);
    expect(lifted.every((value, i) => i === 0 || value >= lifted[i - 1]!)).toBe(true);
  });

  it('keeps the five navigation hooks in the topbar and layout styles local at 12px or above', () => {
    const header = read('App.vue').match(/<header id="bar">([\s\S]*?)<\/header>/)?.[1];
    expect(header).toMatch(/<nav id="steps"[^>]*>[\s\S]*?<button[\s\S]*?:data-step=/);
    for (const file of ['manor.css', 'pil-views.css', 'dossier-views.css']) {
      const css = read('styles/' + file);
      expect(css).not.toMatch(/https?:\/\//i);
      for (const match of css.matchAll(/font-size:\s*([\d.]+)px/g)) expect(Number(match[1])).toBeGreaterThanOrEqual(12);
    }
  });

  it('maps 04/05 material profiles explicitly while keeping default 02 behavior untouched', () => {
    expect(resolveMapToneMaterial(0)).toBe('factory');
    expect(resolveMapToneMaterial(1)).toBe('hospital');
    expect(resolveMapToneMaterial(2)).toBe('survey');
    expect(resolveMapToneMaterial(7)).toBe('survey');

    const region = read('components/RegionView.vue');
    expect(region).not.toMatch(/saturate\(1\.75\)/);
    expect(region).not.toMatch(/globalCompositeOperation\s*=\s*['"]color['"]/);
    expect(region).toMatch(/kind="stage"\s+stage="04"/);

    const deduce = read('components/DeduceView.vue');
    const pilCss = read('styles/pil-views.css');
    expect(deduce).not.toContain('ded-map-patina');
    expect(deduce).not.toContain('ded-hospital-roof');
    expect(deduce).toMatch(/kind="stage"\s+stage="05"/);
    expect(pilCss).not.toContain('ded-map-patina');
    expect(pilCss).not.toContain('ded-hospital-roof');
  });

  it('bakes weathered slate-blue factory steel without red clipping and neutralizes hospital perimeters', () => {
    const w = 120;
    const h = 100;
    const factoryPixels = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        // Neutral terrain ramp across image so quantiles span shadows to highlights
        const base = Math.round(18 + ((x + y) / (w + h)) * 130);
        factoryPixels[o] = base;
        factoryPixels[o + 1] = Math.max(0, base - 4);
        factoryPixels[o + 2] = Math.max(0, base - 10);
        factoryPixels[o + 3] = 255;
      }
    }
    // Paint dark steel blue roof inside native factory UV [405/1231..543/1231, 256/1076..373/1076]
    const rx0 = Math.round((405 / 1231) * w) + 2;
    const rx1 = Math.round((543 / 1231) * w) - 2;
    const ry0 = Math.round((256 / 1076) * h) + 2;
    const ry1 = Math.round((373 / 1076) * h) - 2;
    for (let y = ry0; y < ry1; y++) {
      for (let x = rx0; x < rx1; x++) {
        const o = (y * w + x) * 4;
        factoryPixels[o] = 33;
        factoryPixels[o + 1] = 56;
        factoryPixels[o + 2] = 78;
      }
    }
    // Paint terracotta red tile roof
    for (let y = 65; y < 80; y++) {
      for (let x = 82; x < 95; x++) {
        const o = (y * w + x) * 4;
        factoryPixels[o] = 116;
        factoryPixels[o + 1] = 58;
        factoryPixels[o + 2] = 44;
      }
    }

    gradeSurveyPixels(factoryPixels, w, h, 'factory');

    const steelSpreads: number[] = [];
    let redZeroCount = 0;
    for (let y = ry0 + 2; y < ry1 - 2; y++) {
      for (let x = rx0 + 2; x < rx1 - 2; x++) {
        const o = (y * w + x) * 4;
        const r = factoryPixels[o]!;
        const g = factoryPixels[o + 1]!;
        const b = factoryPixels[o + 2]!;
        if (r === 0) redZeroCount++;
        steelSpreads.push(Math.max(r, g, b) - Math.min(r, g, b));
        expect(b).toBeGreaterThan(r);
      }
    }
    const steelSpread = median(steelSpreads);
    expect(steelSpread).toBeGreaterThanOrEqual(62);
    expect(steelSpread).toBeLessThanOrEqual(95);
    expect(redZeroCount).toBe(0);

    // Check terracotta red roof retains warm red dominance
    const redOffset = (72 * w + 88) * 4;
    expect(factoryPixels[redOffset]!).toBeGreaterThan(factoryPixels[redOffset + 1]! + 25);

    // Hospital perimeter neutralization: cold edge RGB(47, 60, 77) must not blow up blue
    const hospPixels = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        const isEdge = x <= 2 || x >= w - 3 || y <= 2 || y >= h - 3;
        if (isEdge) {
          hospPixels[o] = 47;
          hospPixels[o + 1] = 60;
          hospPixels[o + 2] = 77;
        } else {
          const v = Math.round(24 + ((x + y) / (w + h)) * 120);
          hospPixels[o] = v;
          hospPixels[o + 1] = v;
          hospPixels[o + 2] = v;
        }
        hospPixels[o + 3] = 255;
      }
    }
    gradeSurveyPixels(hospPixels, w, h, 'hospital');
    const edgeOffset = (Math.floor(h / 2) * w + (w - 1)) * 4;
    const edgeSpread = Math.max(hospPixels[edgeOffset]!, hospPixels[edgeOffset + 1]!, hospPixels[edgeOffset + 2]!)
      - Math.min(hospPixels[edgeOffset]!, hospPixels[edgeOffset + 1]!, hospPixels[edgeOffset + 2]!);
    expect(edgeSpread).toBeLessThanOrEqual(12);
    expect(hospPixels[edgeOffset + 2]! - hospPixels[edgeOffset]!).toBeLessThanOrEqual(4);
  });

  it('deduplicates concurrent loads, isolates material cache keys, and preserves original preset', async () => {
    let loadCount = 0;
    class MockImg {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      decoding = 'auto';
      naturalWidth = 4;
      naturalHeight = 4;
      width = 4;
      height = 4;
      private _src = '';
      get src() { return this._src; }
      set src(v: string) {
        this._src = v;
        loadCount++;
        setTimeout(() => this.onload?.(), 0);
      }
    }
    vi.stubGlobal('Image', MockImg);
    const url = `/assets/maps/__unit_cache_probe_${Date.now()}.jpg`;

    const orig = await getEnhancedMap(url, 'original', { material: 'factory' });
    expect(orig).toBeInstanceOf(MockImg);
    expect(loadCount).toBe(1);

    const [p1, p2] = await Promise.all([
      getEnhancedMap(url, 'clarity', { material: 'factory' }),
      getEnhancedMap(url, 'clarity', { material: 'factory' }),
    ]);
    expect(p1).toBe(p2);
    expect(loadCount).toBe(2);

    // Default (02) clarity key is distinct from factory clarity key
    await getEnhancedMap(url, 'clarity');
    expect(loadCount).toBe(3);

    // Repeat default call hits cache without reloading
    await getEnhancedMap(url, 'clarity');
    expect(loadCount).toBe(3);
  });

  it('keeps factory, hospital, default, original, and dossier pixel-identical (max |ΔRGB| == 0) to pre-fix baseline 3974560', async () => {
    const w = 80;
    const h = 80;
    const srcPixels = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        const base = Math.round(18 + ((x + y) / (w + h - 2)) * 130);
        let r = base;
        let g = Math.max(0, base - 3);
        let b = Math.max(0, base - 8);
        if (x <= 2 || x >= w - 3 || y <= 2 || y >= h - 3) {
          r = 47; g = 60; b = 77;
        } else if (x >= 26 && x <= 35 && y >= 19 && y <= 28) {
          r = 33; g = 56; b = 78;
        } else if (x >= 29 && x <= 49 && y >= 34 && y <= 51) {
          r = 88; g = 86; b = 82;
        } else if (x >= 56 && x <= 68 && y >= 50 && y <= 62) {
          r = 116; g = 58; b = 44;
        } else if (x >= 10 && x <= 22 && y >= 52 && y <= 66) {
          r = 44; g = 66; b = 36;
        }
        srcPixels[o] = r;
        srcPixels[o + 1] = g;
        srcPixels[o + 2] = b;
        srcPixels[o + 3] = 255;
      }
    }

    const canvasStore = new WeakMap<HTMLCanvasElement, Uint8ClampedArray>();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
      const canvas = this;
      return {
        drawImage() {
          canvasStore.set(canvas, new Uint8ClampedArray(srcPixels));
        },
        getImageData() {
          const data = canvasStore.get(canvas) ?? new Uint8ClampedArray(srcPixels);
          return { data, width: canvas.width, height: canvas.height };
        },
        putImageData(imgData: ImageData) {
          canvasStore.set(canvas, new Uint8ClampedArray(imgData.data));
        },
      } as unknown as CanvasRenderingContext2D;
    });

    class ProbeImg {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      decoding = 'async';
      naturalWidth = w;
      naturalHeight = h;
      width = w;
      height = h;
      private _src = '';
      get src() { return this._src; }
      set src(v: string) {
        this._src = v;
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal('Image', ProbeImg);

    const frozenBaseline: ReadonlyArray<{
      name: string;
      preset: VisualPresetId;
      options?: MapToneOptions;
      sha256: string;
      z64: string;
    }> = [
      {
        name: 'factory',
        preset: 'clarity',
        options: { material: 'factory' },
        sha256: 'b097b0418a4624fb2866ccbda33d5ab6f4a04db83237d1f259736580d1f65c00',
        z64: 'eNrt3PtTzWkcB/Dzg7Adlj3DUmuljS5SHerIRCiHbiaTlalhMA2ZM0pr0JamseR01SaapklZK9a6blqSJvckSeOWJuSSprXtYtEYY/E1nBkTn48zz8zz+fbNM828/4HXPN/nc3nOzFGpDarudEe42FtZ2FtZOFj3dLDu6fhNL6chvUd++4XzUMtRNupRNmqXYX1cbfu6ffel1q6f1q7f6OH9x4z4yt1e4+EwQOc4UOc4cKzT154jB41zHuzlYjXe1Xq8q7W3dsjE0UMnu9v46mx9dbZ6T7up44b7edkHTHAM9HYK9HaaPsk52Mdlhq9biF4botd+P21MqL/H7ABdWJDnnGCvOcFe80K8I0J9FoXpDXP9o+YHRc0PiomYsTxyZqwhdFV0+Kro8MQf5q5ZsSApNsIYtzA5PjI5PjI1YXF6omH96iU/r4nekBSzISlmo3FZTspy1CsqNjdtJfQKjM3L+BH1iopFvQJj8zPjoVdgbEFWAvQKjN2SnQi9AmO3bloNvQJji3LXol5RsahXYOyOvHXQKzB2Z34y9AqM3VWQCr0CY/dsyUC9omL3/5oJvQJjUS8JVqUxmolS2OKiLOglOVmVxmjpl/Yu6Wq/dLX/2/QJyDB5lcKW7MiGXpLP2OSdsrKgYyz90kxepbCHfs+BXpI7+967MKfElI5epbCHd+eiXv4CpdIYe/gkeRqyZ63bNjt5e3jqzglLc3vpU0xepbCol6QaqzRGtX/6tLitS/KPRBWULy2sCEgo6huY+d6rCPbI3jzoJWk95u+vUtiKPzZDL0mf7VCfP4jJqxT22IFC6CUZKsz3X6WwJ/78BXpJJijzXqWwp0u3od7Pd1w0j0W9AmPPlG2HXoGxZ8t/g16BsTVHd0GvwNja43tQLyG2cONPPKHF1p3cB720J8vppcWiXtrPmNNLi71UWQy9tHeW00uLvVJVAr20BYrfS4itrz4IvbTVmNNLi22oKUW9hK2H00uLRb20fZbTS4ttrC2DXtqhgtNLi71RVw69tBMUp5cW23SxAnppx0V+LyH29uVjqJdwNub00mLvXj0BvbSLAKeXFot6abceTi8ttvnaKeilXfE4vbTYloZK6KXdZ/m9hNjWxiropV3eOb0Qey/MjSUo9v6NatRL+FLB6YUny+hFsagXxQ6eomJJJzzLMHpRbFvTOehFT5bR2wlvUOxeiP339nnoRT9jdq/cD26MXhT78O4F6EXvLKNXbmzdyX2MXhT7qLkOetECxeiVG8vuRbGPWy6iXliNGb1yYy9VFjN6USzqRVsPo1du7JWqEnYvxD5tvQy9aJ9l98qKra8+yOhFse1/XYVedKhg9MqNbagpZfSi2Gd/10MvOkExeuXGsntR7PN/GlAvHBcZvXJjG2vLGL0o9sWDRuhFZ2NGr9zYT209n6rGH2FRL7oIMHq7OPb/h9ehF9162L1dGfvqv5vQi654jN4ujpWe3IJepX557wSs1H4H9YqKRb0CY6VnzdArMFZ63gK9AmOlF63QKzBWenkfegXGSq/bUK+oWNQrMFaSHkCvwFhJetT9fzLdETJvAHJzF5w=',
      },
      {
        name: 'hospital',
        preset: 'clarity',
        options: { material: 'hospital' },
        sha256: '9e29b3b545355b4c6323031b4ca0444580f6b0c977ac61baace420cc8b17595d',
        z64: 'eNrt3I9P1GUcB/Czslr2w0xDjSREAfn9o6AoKSp/TDOGo4746aF3ggR4J3fAcSdwwhGgjjFUGNMcYwpjmmPMIoqIMCOmMoZmmsbM7Idz9tu5atfqu26Lz4dvz/n9fO9LT26ff+C15/k+z/v97CAiNDDi5vA+4aHB3M84r/f9qvkzVD4P/DkLZqoWzlL5Pqjy81D5z57iP3vKojm3BMy9NfCh24I8pwZ5Tg1++PaQeXeEet0Z9shd4d7Twr2nRcy/O9LnnkcX3Bvle1+03/Rov+lPLJoREzDzqaBZsSEesSEez4TNiQuf+1yk55LH5i2N8loa5bX8ce8VMT4rn1y4arHvqsW+8U/7J8QFrH42MPH5YPWyMPWysOQVkekvRmsSYrQvxWYlxWUlxeWkLMnPWG7IXGnSxZt08cXZq625L5fmJ5Xrk22GVJshtaIgzW7KeK1IU2Neu9Wi3WrRbt+8vq4sG3o5xtbbcqCXY2xDRS7q5RWLejnG7rTnQy/H2F1VeujlGNtUbYBejrHNtQXQyzF29zYT6uUVi3o5xu6tK4ZejrEt9SXQyzG2tcEKvRxj9+0sRb28YtubbNDLMRb1kmBVwfUioxS2o7kCeklWVtyrFPbAbjv0kmxjca9S2Dder4Zekm9W3KsUtrOlFvVKP6DEvUphUS/JafyvXkWwXa3boJfk6hH3KoU9vK8OeknuWXGvUtju9nroJQkV4l6lsD0dDdBLkqDEvUph3z2wC/X+d+OiOBb1coztO9QEvRxj+zuboVcmbIo6IUWdkJ6cqElTr814Zd2aFF1mqi4zNWtderZ2jXuwA117oNf92Jz1mtxsd2CPvrkX9RJiG2uM5kK92cQwhfrGWuO4ocUOdrdAL+3KsmIFb814Ly0W9dJuY1bsBGRa7FBPK/TSfrOueQGZFnu8dz/0Ul09wgHlsvefZFrscF879BJiNWnqG/H+RRamtMRYZim0bS4iwY70d6Be6aHCefXcoPfvEbAVZeY2CizqJUlQzntWolfAVpZb2iiwJ48chF6SuOgMFRK9Aray3EKC/eToIeglycbOBCXRK2CrtlhJsJ8OdkIvSRFwxkXp3qot1urKUhLs2aEu1Cu99TizsUSvgK2xl5Ngzx07DL0kFc9ZBCTeR7RY1EvSZ52tR2LeoNrGAvb8ibegl6S8C9i8DVqJeZIWOzb8NvRSvVTkbdC67AV9gRZ7YeQd6CV8ltn4qk4KtrHWCLGjiYEsg2IvjvaiXsI3KNf6L+j7cGUZvSgW9aJYvxdULIO+QRn1OSZDblFBntm0saTQYC3eZC3e5CwCriYoRi+KvXTqPehFV5bRi75B7bDnU2EHuvaweyH269PvQy+6jdm9Lj24tTXZXC0CjF4U++2ZD6AX/WYZvXK/Lg52tzB6UezlswPQix5QjF65sexeFHvl3IeoF57GjF65sUM9rYxeFIt60auH0Ss39njvfnYvxF79/CPoRe9Zdq+s2OG+dkYviv1u7GPoRUMFo1du7Eh/B6MXxf5wYQh60QTF6JUby+5FsT9dPIZ6YVxk9MqNPXnkIKMXxf5y6QT0otmY0Ss3dqLWM9FpPA6LetEiwOid5NhrXw1DL9p62L2TGXv9mxHoRSseo3eSY3+9PAq97v9Nhduwv185hXp5xaJejrGOq6ehl2Os4/sz0Msx1vHjZ9DLMdbx83no5RjruDaGennFol6OsY7rX0Avx1jHb18if5/yf/p/MjeH1/kDGO5YJw==',
      },
      {
        name: 'default',
        preset: 'clarity',
        options: undefined,
        sha256: 'ce1e54e15d5e8db0d75391b4f5fea78d50e3fc445f0554a2ddad248a613ea92f',
        z64: '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',
      },
      {
        name: 'original',
        preset: 'original',
        options: { material: 'factory' },
        sha256: '790658891dd49fa4393150ded0fd514af844c9135f8ad5eaa4a66b30c702ebc7',
        z64: 'eNrt3OdSIkEQB/BHuKSoqCCIIgqCKKiggIgiBlRUxByJCghizjne3Svf9+t2b6qm1/WmrOoX+NXM9Px7tmqtPWPWz/os4aqi7Etl+dcq1bcq1Td1xffqyh81VWW16nJNtUpTrdLWVNTVVuo0VXqtWq9V19dVG3Q1DfraxnqN0aA1GrRNDXWmRl2zUd/SVG82Gcwmg6W5obWl0Wo22ixNNktTW6vJbm1ut7V0tJkddovDbnG2t3Z2WLsctm5nW7ezzdVpd3e193R39LocHrfT43Z6ezp9vV19nm6/19Xvc/f73IG+ngF/72C/JxjwBgPeoQFfaLBvOOgfGeofDQVGQ4Gx4YHwyOD4aHBibGgyHJoMhyLjw1MTI9ArMHZ6chR6BcbORMZQr6hY1CswNjoVhl6BsbPT49ArMDY2MwG9AmPnopPQKzB2fjaCekXFol6BsQuxKegVGLs4Nw29AmOX5megV2Ds8kIU9YqKXVmchV6BsaiXBKvrCkuUUtjVpRj0kqystFcp7NryHPSSbGNpr1LY9ZV56CU5s9JepbAbqwuol79BSXuVwqJekm78T68i2M21RegluXqkvUph4+tL0Etyz0p7lcImNpahlyRUSHuVwiY3V6CXJEFJe5XCpuKrqPf/jYvSWNQrMDadWINegbGZ5DryyUxc7FZqA3oFxm6nN1EvITYWjfAULTabiUMv7cpyemmxqJd2G3N6abG5rQT00p5ZTi8tNr+dhF7aBsXvJcTuZFPQS9uNOb202EIujXoJrx5OLy0W9dLes5xeWmwxn4Fe2lDB6aXF7u5sQS9tguL00mJLhW3opY2L/F5C7F4xi3oJszGnlxa7v5uDXtpBgNNLi0W9tFMPp5cWe1DKQy/tiMfppcUe7u1AL+08y+8lxB7tF6CXdnjn9EJsyWVmKgx7fFBEvYQvFZxeuLKMXhSLelGs2W9gqXd4lmH0otiTw13oRVeW0fsOb1DsXog9PSpBL7qN2b1yP7gxelHs2fEe9KJnltErNzabiTN6Uez5yT70og2K0Ss3lt2LYi9OD1Av7MaMXrmxua0EoxfFol706mH0yo3NbyfZvRB7eXYIveg9y+6VFbuTTTF6UezV+RH0oqGC0Ss3tpBLM3pR7PXFMfSiCYrRKzeW3Ytiby5PUC+Mi4xeubHFfIbRi2Jvr06hF83GjF65sW9NPW9147+wqBcdBBi9Hxx7d30GvejUw+79yNj7m3PoRUc8Ru8Hxz7cXkCvUl/e3wH7eHeJekXFol6BsU/3V9ArMPb54Rp6Bca+PN5Ar8DY16db6BUY+/P5DvWKikW9AmN/vdxDr8DY368Pn/+T+Swh6w8h6P7d',
      },
      {
        name: 'dossier',
        preset: 'dossier',
        options: { material: 'survey' },
        sha256: 'f3eb0f09b878fff3c290840701c317a6edd74adb935235272c43eec96295ea66',
        z64: 'eNrt3OdSWkEUB/BXSUzVZGxBBYNSREVApAgioIgoKKICFlDABlIs2DWmmFfN+DXneLPOnus1O878X+A3u/eUZQa7e8z+kpcIl67mV+qW1+rWBnVrg6btTXf7W63qXY/qfW/Hh/t0ftR1NerVjQZNk0HTZNR86uv+bNI29/e0DPTeZ1DXata1DenbLYYvFqPKYlRZ+1Q2U8ewqXNkQH2fQY3D3O0c6nZZvrotWrdFO2rt8dh6PcM6r13vtevHRvQ+h2HcYfQ7+/wuk99lCrj7g6MDE56BSe9gyGsOec1TPkt43Drtt0YCtkjANhMYng3aoxMj0UlHLOSMhZxzU875sCsedi9MjyYinvvMeBdnvdArMHYpipyvwNjlqA/1iopFvQJjk7Fx6BUYm5rzQ6/A2NR8AHoFxqbjQegVGLuy8IBXUCzuFRe7mpiAXoGxa4lJ6BUYu74Ygl6BsZmlKdQrKjazHIZegbGolwRrdPgkohQ2m5yGXpKTlfYqhd1IIV6SayztVQq7mY5AL8k3K+1VCptLz6Be/gIl7VUKi3pJqvE/vYpg8yuz0EvSeqS9SmHzq1HoJemz0l6lsIW1GPSSDBXSXqWwW+tziJdigpL2KoXdzuDe/3dclMaiXoGxO9l56BUYu5uNQ6/A2L2NBegVGLu3mcC9dNhUPMgVUmwxt4h4SU+W10uKRb2015jTS4st5REv7TfL6aXF7heWoJe2QPF7CbHlwjL00lZjTi8ttrKVRL2ErYfTS4tFvbR9ltNLi61up6CXdqjg9NJiqztpxEs6QfF6SbG13RXopR0X+b2E2IM93Es4G3N6abGHxVXopV0EOL20WNRLu/VwemmxR8U16KVd8Ti9tFjUS7vP8nsJsceldcRLurxzeiG25tIyBcPW9zOol/ClgtcLTpbRi2JRL4q1+lQseYJnGUYviq2Xs9CLniyj9wneoNi9EHtSQbzoNX6EV+YHN0Yvij2tbkAv+s2yemXGFnOL7F6IPatuQi9aoBi9cmPZvSj2vJZDvbAaM3rlxpbyrF4Ui3rR1sPolRu7X1h6hBdgLw7y0Iv2WXavrNhyYZnVi2EvDgvQiw4VjF65sZWtJKMXxV4ebUEvOkExeuXGsntR7NUx7oXjIqtXZmx1O8XoRbHX9W3oRWdjRq/c2Ie2noeq8V9Y1IsuAozeZ469qe9AL7r1sHufM/bbyS7ixVY8Ru8zx96e7kGvUr+8PwH29qyIekXFol6Bsd/PS9ArMPbHBeIVGPvzch96Bcb+uixDr8DYu6sK7hUUi3vFxd5dV6FXYOzvm9rL/8m8RMj8AQEVvoY=',
      },
    ];

    const nonce = Date.now();
    for (const item of frozenBaseline) {
      const res = await getEnhancedMap(`/assets/maps/__frozen_${item.name}_${nonce}.jpg`, item.preset, item.options);
      const actualRgba = res instanceof HTMLCanvasElement
        ? canvasStore.get(res)
        : srcPixels;
      expect(actualRgba).toBeDefined();
      const actualRgb = new Uint8Array(w * h * 3);
      for (let i = 0; i < w * h; i++) {
        actualRgb[i * 3] = actualRgba![i * 4]!;
        actualRgb[i * 3 + 1] = actualRgba![i * 4 + 1]!;
        actualRgb[i * 3 + 2] = actualRgba![i * 4 + 2]!;
      }
      const expectedRgb = inflateSync(Buffer.from(item.z64, 'base64'));
      expect(actualRgb.length).toBe(expectedRgb.length);
      let maxDelta = 0;
      for (let i = 0; i < actualRgb.length; i++) {
        const diff = Math.abs(actualRgb[i]! - expectedRgb[i]!);
        if (diff > maxDelta) maxDelta = diff;
      }
      expect(maxDelta, `${item.name} must have max |ΔRGB| == 0`).toBe(0);
      const actualSha = createHash('sha256').update(actualRgb).digest('hex');
      expect(actualSha, `${item.name} digest mismatch`).toBe(item.sha256);
    }
  });

  it('keeps survey Rec.709 luminance monotonic and D-008 compliant across warm street, woodland, and cool snow samples', () => {
    const rec709 = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const summarize = (buf: Uint8ClampedArray, w: number, h: number) => {
      const ys: number[] = [];
      const spreads: number[] = [];
      for (let i = 0; i < w * h; i++) {
        const o = i * 4;
        const r = buf[o]!;
        const g = buf[o + 1]!;
        const b = buf[o + 2]!;
        ys.push(rec709(r, g, b));
        spreads.push(Math.max(r, g, b) - Math.min(r, g, b));
      }
      ys.sort((a, b) => a - b);
      spreads.sort((a, b) => a - b);
      return {
        medianY: ys[Math.floor(ys.length / 2)]!,
        p95Y: ys[Math.floor(0.95 * (ys.length - 1))]!,
        medianSpread: spreads[Math.floor(spreads.length / 2)]!,
      };
    };

    const samples: ReadonlyArray<{
      name: string;
      ratios: readonly [number, number, number];
      assertHue: (r: number, g: number, b: number) => void;
    }> = [
      {
        name: 'warm-street',
        ratios: [1.15, 0.98, 0.78],
        assertHue: (r, _g, b) => expect(r - b).toBeGreaterThan(20),
      },
      {
        name: 'woodland',
        ratios: [0.92, 1.08, 0.78],
        assertHue: (_r, g, b) => expect(g - b).toBeGreaterThan(15),
      },
      {
        name: 'cool-snow',
        ratios: [0.80, 0.94, 1.18],
        assertHue: (r, _g, b) => {
          expect(b - r).toBeGreaterThan(15);
          expect(r).toBeGreaterThan(0);
        },
      },
    ];

    const w = 120;
    const h = 48;
    for (const sample of samples) {
      const pixels = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const o = (y * w + x) * 4;
          const base = 16 + (x / (w - 1)) * 180;
          pixels[o] = Math.min(255, Math.round(base * sample.ratios[0]));
          pixels[o + 1] = Math.min(255, Math.round(base * sample.ratios[1]));
          pixels[o + 2] = Math.min(255, Math.round(base * sample.ratios[2]));
          pixels[o + 3] = 255;
        }
      }

      gradeSurveyPixels(pixels, w, h, 'survey');

      const stats = summarize(pixels, w, h);
      expect(stats.medianY, `${sample.name} medianY`).toBeGreaterThanOrEqual(100);
      expect(stats.p95Y, `${sample.name} p95Y`).toBeGreaterThanOrEqual(190);

      // Verify monotonic Rec.709 luminance across interior horizontal ramp
      const midRow = Math.floor(h / 2);
      const rowRoundedY: number[] = [];
      for (let x = 10; x < w - 10; x++) {
        const o = (midRow * w + x) * 4;
        rowRoundedY.push(Math.round(rec709(pixels[o]!, pixels[o + 1]!, pixels[o + 2]!)));
      }
      for (let i = 1; i < rowRoundedY.length; i++) {
        expect(rowRoundedY[i]!, `${sample.name} step ${i}`).toBeGreaterThanOrEqual(rowRoundedY[i - 1]!);
      }
      expect(rowRoundedY[rowRoundedY.length - 1]!).toBeGreaterThan(rowRoundedY[0]! + 140);

      const midO = (midRow * w + Math.floor(w / 2)) * 4;
      sample.assertHue(pixels[midO]!, pixels[midO + 1]!, pixels[midO + 2]!);
    }

    // Composite warm-street / cool-roof / woodland scene (Chinatown-like raw chroma ~13) preserves D-008 & material separation
    const cw = 90;
    const ch = 60;
    const composite = new Uint8ClampedArray(cw * ch * 4);
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const o = (y * cw + x) * 4;
        const base = 24 + (x / (cw - 1)) * 120;
        let r = Math.round(base * 1.05);
        let g = Math.round(base * 1.01);
        let b = Math.round(base * 0.91);
        if (y < 20) {
          // Cool slate roof band
          r = Math.round(base * 0.89);
          g = Math.round(base * 0.97);
          b = Math.round(base * 1.11);
        } else if (y >= 40) {
          // Woodland foliage band
          r = Math.round(base * 0.93);
          g = Math.round(base * 1.06);
          b = Math.round(base * 0.87);
        }
        composite[o] = Math.min(255, r);
        composite[o + 1] = Math.min(255, g);
        composite[o + 2] = Math.min(255, b);
        composite[o + 3] = 255;
      }
    }
    gradeSurveyPixels(composite, cw, ch, 'survey');
    const compStats = summarize(composite, cw, ch);
    expect(compStats.medianY).toBeGreaterThanOrEqual(100);
    expect(compStats.p95Y).toBeGreaterThanOrEqual(190);
    expect(compStats.medianSpread).toBeGreaterThanOrEqual(40);
    expect(compStats.medianSpread).toBeLessThanOrEqual(52);

    const roofO = (10 * cw + 45) * 4;
    const streetO = (30 * cw + 45) * 4;
    const woodO = (50 * cw + 45) * 4;
    expect(composite[roofO + 2]!).toBeGreaterThan(composite[roofO]! + 10);
    expect(composite[streetO]!).toBeGreaterThan(composite[streetO + 2]! + 20);
    expect(composite[woodO + 1]!).toBeGreaterThan(composite[woodO + 2]! + 15);
  });
});
