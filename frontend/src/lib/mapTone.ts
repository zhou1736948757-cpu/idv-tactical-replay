import { ref } from 'vue';
import { withBaseUrl } from './assetUrl';
import type { VisualPresetId } from '@idv/replay-renderer';

export type MapToneMaterial = 'default' | 'survey' | 'factory' | 'hospital';
export interface MapToneOptions {
  material?: MapToneMaterial;
}

type MapImage = HTMLCanvasElement | HTMLImageElement;
export const MAP_TONE_CACHE_LIMIT = 8;
const cache = new Map<string, MapImage>();
const pending = new Map<string, Promise<MapImage>>();
const target = 0.47;
const clamp = (x: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));

function isCrossOriginUrl(url: string): boolean {
  if (!/^(?:https?:)?\/\//i.test(url)) return false;
  if (typeof window !== 'undefined' && window.location?.origin) {
    try {
      return new URL(url, window.location.href).origin !== window.location.origin;
    } catch {
      return true;
    }
  }
  return true;
}

function putCachedMap(key: string, value: MapImage): void {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > MAP_TONE_CACHE_LIMIT) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    const evicted = cache.get(oldestKey);
    cache.delete(oldestKey);
    if (evicted && typeof HTMLCanvasElement !== 'undefined' && evicted instanceof HTMLCanvasElement) {
      evicted.width = 0;
      evicted.height = 0;
    }
  }
}

export function resolveMapToneMaterial(mapId: number): Exclude<MapToneMaterial, 'default'> {
  if (mapId === 0) return 'factory';
  if (mapId === 1) return 'hospital';
  return 'survey';
}

export function computePercentile(histogram: ArrayLike<number>, fraction: number): number {
  const counts = Array.from(histogram);
  const total = counts.reduce((sum, count) => sum + count, 0);
  if (!total) return 0;
  const rank = Math.max(1, Math.ceil(total * clamp(fraction)));
  let sum = 0;
  return counts.findIndex((count) => (sum += count) >= rank);
}

export function analyzeHistogram(histogram: ArrayLike<number>) {
  const p1 = computePercentile(histogram, 0.01);
  const p50 = computePercentile(histogram, 0.5);
  const p99 = computePercentile(histogram, 0.99);
  return { p1, p50, p99, narrow: p99 - p1 < 48 };
}

const smooth = (x: number) => x * x * (3 - 2 * x);
const stretched = (value: number, low: number, high: number) => clamp((value - low) / Math.max(1, high - low));

export function solveGammaForMedian(median: number, desired = target): number {
  const x = Math.min(0.999, Math.max(0.001, median));
  return Math.log(Math.min(0.999, Math.max(0.001, desired))) / Math.log(x);
}

export function buildToneLut(
  stats: ReturnType<typeof analyzeHistogram>,
  preset: VisualPresetId,
  highlightPercentile = stats.p99,
): Uint8ClampedArray {
  const { p1, p50, p99, narrow } = stats;
  // Pad the range so large flat areas at either percentile retain a usable midpoint.
  const low = Math.min(p1, p50 - 8);
  const high = Math.max(p99, p50 + 8);
  const median = stretched(p50, low, high);
  const gammaTarget = ((target - 0.06) / 0.86 - 0.22 * smooth(median)) / 0.78;
  const gamma = solveGammaForMedian(median, gammaTarget);
  const rawGamma = solveGammaForMedian(p50 / 255);
  const clarity = (value: number) => {
    const x = stretched(value, low, high);
    const curve = 0.06 + 0.86 * (0.78 * x ** gamma + 0.22 * smooth(x));
    return narrow ? 0.75 * curve + 0.25 * (value / 255) ** rawGamma : curve;
  };
  // Lift upper midtones without moving the median or raising the white point.
  const shoulder = clarity(highlightPercentile);
  const lift = Math.max(0, 0.8 - shoulder);
  return Uint8ClampedArray.from({ length: 256 }, (_, value) => {
    if (preset === 'original') return value;
    if (preset === 'dossier') return 255 * (value / 255) ** 0.9;
    const base = clarity(value);
    if (highlightPercentile - p50 < 8 || shoulder <= target || lift === 0) return 255 * base;
    const weight = base <= shoulder
      ? clamp((base - target) / (shoulder - target))
      : clamp((0.92 - base) / (0.92 - shoulder));
    return 255 * (base + lift * weight);
  });
}

const SURVEY_PERCENTILES = [0, 0.05, 0.25, 0.5, 0.75, 0.95, 0.99, 1] as const;
const SURVEY_KNOTS = [12, 33, 64, 105, 147, 202, 224, 241] as const;
const SURVEY_GENERIC_KNOTS = [12, 33, 64, 108, 144, 198, 210, 220] as const;
const ROOF_LIGHT_X = [0, 15, 30, 52, 75, 120] as const;
const ROOF_LIGHT_Y = [21, 48, 92, 140, 162, 203] as const;
const ROOF_SPAN_X = [0, 12, 30, 45, 62] as const;
const ROOF_SPAN_Y = [3, 30, 67, 78, 81] as const;
const SLATE_RED = -0.505;
const SLATE_BLUE = 0.495;
const SLATE_GREEN = -(0.2126 * SLATE_RED + 0.0722 * SLATE_BLUE) / 0.7152;
const HOSPITAL_STONE_POLY: ReadonlyArray<readonly [number, number]> = [
  [0.329, 0.493],
  [0.405, 0.403],
  [0.506, 0.403],
  [0.566, 0.486],
  [0.646, 0.493],
  [0.646, 0.58],
  [0.567, 0.59],
  [0.503, 0.674],
  [0.405, 0.674],
  [0.329, 0.598],
];

function interpKnots(value: number, xs: ArrayLike<number>, ys: ArrayLike<number>): number {
  const n = xs.length;
  if (value <= xs[0]!) return ys[0]!;
  if (value >= xs[n - 1]!) return ys[n - 1]!;
  for (let i = 1; i < n; i++) {
    const x1 = xs[i]!;
    if (value <= x1) {
      const x0 = xs[i - 1]!;
      const dx = x1 - x0;
      if (dx <= 1e-6) return ys[i]!;
      const t = (value - x0) / dx;
      return ys[i - 1]! + t * (ys[i]! - ys[i - 1]!);
    }
  }
  return ys[n - 1]!;
}

function gaussianBlur2D(src: Float32Array, width: number, height: number, sigma: number): Float32Array {
  if (!(sigma > 0.05) || width < 2 || height < 2) return Float32Array.from(src);
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel = new Float32Array(radius * 2 + 1);
  let sum = 0;
  const inv2s2 = 1 / (2 * sigma * sigma);
  for (let k = -radius; k <= radius; k++) {
    const w = Math.exp(-(k * k) * inv2s2);
    kernel[k + radius] = w;
    sum += w;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] = kernel[i]! / sum;

  const tmp = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        const sx = x + k < 0 ? 0 : x + k >= width ? width - 1 : x + k;
        acc += src[row + sx]! * kernel[k + radius]!;
      }
      tmp[row + x] = acc;
    }
  }

  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        const sy = y + k < 0 ? 0 : y + k >= height ? height - 1 : y + k;
        acc += tmp[sy * width + x]! * kernel[k + radius]!;
      }
      out[row + x] = acc;
    }
  }
  return out;
}

function computeFineQuantiles(yValues: Float32Array): Float64Array {
  const bins = 1024;
  const scale = (bins - 1) / 255;
  const hist = new Uint32Array(bins);
  let minY = 255;
  let maxY = 0;
  for (let i = 0; i < yValues.length; i++) {
    const v = yValues[i]!;
    if (v < minY) minY = v;
    if (v > maxY) maxY = v;
    const b = Math.min(bins - 1, Math.max(0, Math.round(v * scale)));
    hist[b] = hist[b]! + 1;
  }
  const total = yValues.length;
  const out = new Float64Array(SURVEY_PERCENTILES.length);
  out[0] = minY;
  out[SURVEY_PERCENTILES.length - 1] = maxY;
  for (let k = 1; k < SURVEY_PERCENTILES.length - 1; k++) {
    const targetRank = SURVEY_PERCENTILES[k]! * Math.max(0, total - 1);
    let acc = 0;
    let found = maxY;
    for (let b = 0; b < bins; b++) {
      const c = hist[b]!;
      if (acc + c > targetRank) {
        const frac = c > 0 ? (targetRank - acc) / c : 0;
        found = ((b + frac - 0.5) / scale);
        break;
      }
      acc += c;
    }
    out[k] = clamp(found, minY, maxY);
  }
  return out;
}

function buildHospitalStoneMask(width: number, height: number): {
  x0: number;
  y0: number;
  w: number;
  h: number;
  mask: Float32Array;
} | null {
  if (width < 16 || height < 16) return null;
  const poly = HOSPITAL_STONE_POLY.map(([u, v]) => [u * width, v * height] as const);
  const sigma = 4 * Math.min(width / 1195, height / 1107);
  const pad = Math.ceil(sigma * 3) + 2;
  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;
  for (const [px, py] of poly) {
    if (px < minX) minX = px;
    if (py < minY) minY = py;
    if (px > maxX) maxX = px;
    if (py > maxY) maxY = py;
  }
  const x0 = Math.max(0, Math.floor(minX) - pad);
  const y0 = Math.max(0, Math.floor(minY) - pad);
  const x1 = Math.min(width, Math.ceil(maxX) + pad);
  const y1 = Math.min(height, Math.ceil(maxY) + pad);
  const w = x1 - x0;
  const h = y1 - y0;
  if (w < 4 || h < 4) return null;

  const rawMask = new Float32Array(w * h);
  const n = poly.length;
  for (let row = 0; row < h; row++) {
    const py = y0 + row + 0.5;
    const xs: number[] = [];
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const [xi, yi] = poly[i]!;
      const [xj, yj] = poly[j]!;
      if ((yi > py) !== (yj > py)) {
        xs.push(xi + ((py - yi) * (xj - xi)) / (yj - yi));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const start = Math.max(0, Math.floor(xs[k]! - x0));
      const end = Math.min(w - 1, Math.ceil(xs[k + 1]! - x0));
      const base = row * w;
      for (let col = start; col <= end; col++) rawMask[base + col] = 1;
    }
  }
  return { x0, y0, w, h, mask: gaussianBlur2D(rawMask, w, h, sigma) };
}

function buildFactoryRoofLayer(
  data: Uint8ClampedArray,
  yValues: Float32Array,
  width: number,
  height: number,
): {
  x0: number;
  y0: number;
  w: number;
  h: number;
  cov: Float32Array;
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;
} | null {
  const x0 = Math.round((405 / 1231) * width);
  const x1 = Math.round((543 / 1231) * width);
  const y0 = Math.round((256 / 1076) * height);
  const y1 = Math.round((373 / 1076) * height);
  const rw = x1 - x0;
  const rh = y1 - y0;
  if (rw < 8 || rh < 8) return null;

  const light = new Float32Array(rw * rh);
  for (let v = 0; v < rh; v++) {
    const srcRow = (y0 + v) * width + x0;
    const dstRow = v * rw;
    for (let u = 0; u < rw; u++) {
      light[dstRow + u] = yValues[srcRow + u]!;
    }
  }
  const sigma = 3 * Math.min(rw / 138, rh / 117);
  const roundedLight = new Float32Array(rw * rh);
  for (let i = 0; i < light.length; i++) roundedLight[i] = Math.round(light[i]!);
  const base = gaussianBlur2D(roundedLight, rw, rh, sigma);

  const cov = new Float32Array(rw * rh);
  const outR = new Float32Array(rw * rh);
  const outG = new Float32Array(rw * rh);
  const outB = new Float32Array(rw * rh);
  const su = 138 / rw;
  const sv = 117 / rh;
  const pitch = 17.0;

  for (let v = 0; v < rh; v++) {
    const srcRow = (y0 + v) * width + x0;
    const dstRow = v * rw;
    const nv = v * sv;
    for (let u = 0; u < rw; u++) {
      const idx = dstRow + u;
      const offset = (srcRow + u) * 4;
      const r = data[offset]!;
      const b = data[offset + 2]!;
      const edge = Math.min(u, v, rw - 1 - u, rh - 1 - v);
      const blue = b - r;
      cov[idx] = clamp(edge / 3) * clamp((blue + 2) / 7);

      const l = light[idx]!;
      let diffuse = interpKnots(l, ROOF_LIGHT_X, ROOF_LIGHT_Y) + 1.45 * (l - base[idx]!);
      const nu = u * su;
      const hCoord = nv + 0.013 * nu;
      const ridge = (((hCoord + 4) % pitch) + pitch) % pitch;
      const d1 = (ridge - 2.5) / 1.3;
      const d2 = (ridge - 5) / 1.45;
      let seam = 11 * Math.exp(-(d1 * d1)) - 19 * Math.exp(-(d2 * d2));
      const lapRaw = nu + 41 * Math.floor((hCoord + 4) / pitch) + 0.09 * nv;
      const lap = ((lapRaw % 83) + 83) % 83;
      const d3 = (lap - 2) / 1.3;
      seam -= 7 * Math.exp(-(d3 * d3));
      diffuse += seam * clamp(l / 37, 0.35, 1);

      const span = interpKnots(blue, ROOF_SPAN_X, ROOF_SPAN_Y);
      outR[idx] = diffuse + span * SLATE_RED;
      outG[idx] = diffuse + span * SLATE_GREEN;
      outB[idx] = diffuse + span * SLATE_BLUE;
    }
  }
  return { x0, y0, w: rw, h: rh, cov, r: outR, g: outG, b: outB };
}

export function gradeSurveyPixels(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  material: Exclude<MapToneMaterial, 'default'>,
): void {
  const total = width * height;
  if (!total) return;
  const yValues = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    const o = i * 4;
    yValues[i] = 0.2126 * data[o]! + 0.7152 * data[o + 1]! + 0.0722 * data[o + 2]!;
  }
  const quantiles = computeFineQuantiles(yValues);
  const flatImage = quantiles[quantiles.length - 1]! - quantiles[0]! < 1;
  const factory = material === 'factory';
  const hospital = material === 'hospital';
  if (!factory && !hospital) {
    const edgeScale = Math.min(width, height) / 1000;
    const edgeStart = 18 * edgeScale;
    const edgeSpan = Math.max(1, 24 * edgeScale);
    for (let py = 0; py < height; py++) {
      const row = py * width;
      for (let px = 0; px < width; px++) {
        const idx = row + px;
        const o = idx * 4;
        const r = data[o]!;
        const g = data[o + 1]!;
        const b = data[o + 2]!;
        const yVal = yValues[idx]!;
        const lum = clamp(
          flatImage ? clamp(yVal, 12, 220) : interpKnots(yVal, quantiles, SURVEY_GENERIC_KNOTS),
          0,
          255,
        );

        const chrR = r - yVal;
        const chrG = g - yVal;
        const chrB = b - yVal;

        const foliage = clamp((g - r + 4) / 9) * clamp((g - b) / 9);
        const cold = clamp((b - r) / 14) * clamp((b - g) / 6);
        const edge = Math.min(px, py, width - 1 - px, height - 1 - py);
        const interior = clamp((edge - edgeStart) / edgeSpan);

        let cR = chrR * 1.84 + 9.5;
        let cG = chrG * 1.84 + 1 + 1.5 * foliage;
        let cB = chrB * 1.84 - 9.5 - 7.5 * foliage;

        const steelGain = 2.45 * interior;
        const sR = chrR * steelGain - 2;
        const sG = chrG * steelGain - 6 * cold;
        const sB = chrB * steelGain + 6;
        cR = cR * (1 - cold) + sR * cold;
        cG = cG * (1 - cold) + sG * cold;
        cB = cB * (1 - cold) + sB * cold;

        const margin = (1 - interior) * clamp((b - r + 6) / 12);
        if (margin > 0) {
          cR = cR * (1 - margin) + 5 * margin;
          cG = cG * (1 - margin) + 2 * margin;
          cB = cB * (1 - margin) - 2 * margin;
        }

        const leaf = clamp((g - b - 5) / 7) * clamp((g - r + 6) / 6);
        cR -= 1.5 * leaf;
        cB -= 5.5 * leaf;

        // D-016 / D-023: remove Rec.709 luminance offset from chroma delta and scale within RGB gamut.
        const dY = 0.2126 * cR + 0.7152 * cG + 0.0722 * cB;
        cR -= dY;
        cG -= dY;
        cB -= dY;

        let gamutScale = 1;
        if (cR > 1e-6 && lum + cR > 255) gamutScale = Math.min(gamutScale, (255 - lum) / cR);
        else if (cR < -1e-6 && lum + cR < 0) gamutScale = Math.min(gamutScale, -lum / cR);
        if (cG > 1e-6 && lum + cG > 255) gamutScale = Math.min(gamutScale, (255 - lum) / cG);
        else if (cG < -1e-6 && lum + cG < 0) gamutScale = Math.min(gamutScale, -lum / cG);
        if (cB > 1e-6 && lum + cB > 255) gamutScale = Math.min(gamutScale, (255 - lum) / cB);
        else if (cB < -1e-6 && lum + cB < 0) gamutScale = Math.min(gamutScale, -lum / cB);
        if (gamutScale < 1) {
          gamutScale = clamp(gamutScale, 0, 1);
          cR *= gamutScale;
          cG *= gamutScale;
          cB *= gamutScale;
        }

        data[o] = clamp(Math.round(lum + cR), 0, 255);
        data[o + 1] = clamp(Math.round(lum + cG), 0, 255);
        data[o + 2] = clamp(Math.round(lum + cB), 0, 255);
      }
    }
    return;
  }
  const roof = factory ? buildFactoryRoofLayer(data, yValues, width, height) : null;
  const stone = hospital ? buildHospitalStoneMask(width, height) : null;
  const edgeScale = hospital ? Math.min(width, height) / 1107 : Math.min(width, height) / 1000;

  for (let py = 0; py < height; py++) {
    const row = py * width;
    for (let px = 0; px < width; px++) {
      const idx = row + px;
      const o = idx * 4;
      const r = data[o]!;
      const g = data[o + 1]!;
      const b = data[o + 2]!;
      const yVal = yValues[idx]!;
      let lum = flatImage ? clamp(yVal, 12, 241) : interpKnots(yVal, quantiles, SURVEY_KNOTS);
      const chrR = r - yVal;
      const chrG = g - yVal;
      const chrB = b - yVal;

      const foliage = clamp((g - r + 4) / 9) * clamp((g - b) / 9);
      let cold = clamp((b - r) / 14) * clamp((b - g) / 6);

      let roofIdx = -1;
      let roofCov = 0;
      if (roof && px >= roof.x0 && px < roof.x0 + roof.w && py >= roof.y0 && py < roof.y0 + roof.h) {
        roofIdx = (py - roof.y0) * roof.w + (px - roof.x0);
        roofCov = roof.cov[roofIdx]!;
        cold *= 1 - roofCov;
      }

      let interior = 1;
      if (!factory) {
        const edge = Math.min(px, py, width - 1 - px, height - 1 - py);
        interior = hospital
          ? clamp((edge - 25 * edgeScale) / Math.max(1, 28 * edgeScale))
          : clamp((edge - 18 * edgeScale) / Math.max(1, 24 * edgeScale));
      }

      lum = lum * (1 - 0.17 * foliage - 0.36 * cold) + (factory ? 12 : 5);
      let cR = chrR * 2.04 + 8;
      let cG = chrG * 2.04 + 1 + 2 * foliage;
      let cB = chrB * 2.04 - 8 - 9 * foliage;

      if (factory) {
        const tileBoost = 0.236 * clamp((r - g - 8) / 14);
        cR += chrR * tileBoost;
        cG += chrG * tileBoost;
        cB += chrB * tileBoost;
      } else {
        cR += 3;
        cB -= 3;
      }

      const steelGain = (factory ? 4.04 : hospital ? 3.98 : 2.5) * interior;
      const sR = chrR * steelGain - 2;
      const sG = chrG * steelGain - (factory ? 20 : hospital ? 7 : 6) * cold;
      const sB = chrB * steelGain + 6;
      cR = cR * (1 - cold) + sR * cold;
      cG = cG * (1 - cold) + sG * cold;
      cB = cB * (1 - cold) + sB * cold;

      if (factory) {
        lum = Math.max(25, lum - 34 * cold);
        lum -= cold * clamp(lum + cB - 178, 0, 24);
        const leaf = clamp((g - b - 5) / 7) * clamp((g - r + 6) / 6);
        lum -= 16 * leaf;
        cR -= 3 * leaf;
        cB -= 10 * leaf;
      } else {
        if (stone && px >= stone.x0 && px < stone.x0 + stone.w && py >= stone.y0 && py < stone.y0 + stone.h) {
          const st = stone.mask[(py - stone.y0) * stone.w + (px - stone.x0)]!;
          if (st > 0) {
            lum *= 1 - 0.14 * st;
            const keep = 1 - 0.75 * st;
            cR *= keep;
            cG *= keep;
            cB *= keep;
          }
        }
        const margin = (1 - interior) * clamp((b - r + 6) / 12);
        if (margin > 0) {
          cR = cR * (1 - margin) + 5 * margin;
          cG = cG * (1 - margin) + 2 * margin;
          cB = cB * (1 - margin) - 2 * margin;
        }
        if (!hospital) {
          const leaf = clamp((g - b - 5) / 7) * clamp((g - r + 6) / 6);
          lum -= 10 * leaf;
          cR -= 2 * leaf;
          cB -= 7 * leaf;
        }
      }

      lum += 8 * clamp((lum - 140) / 48);

      let outR = lum + cR;
      let outG = lum + cG;
      let outB = lum + cB;
      if (roof && roofIdx >= 0 && roofCov > 0) {
        outR += roofCov * (roof.r[roofIdx]! - outR);
        outG += roofCov * (roof.g[roofIdx]! - outG);
        outB += roofCov * (roof.b[roofIdx]! - outB);
      }

      data[o] = clamp(Math.floor(outR), 0, 255);
      data[o + 1] = clamp(Math.floor(outG), 0, 255);
      data[o + 2] = clamp(Math.floor(outB), 0, 255);
    }
  }
}

function enhance(img: HTMLImageElement, preset: VisualPresetId, material: MapToneMaterial): MapImage {
  if (preset === 'original') return img;
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth || img.width;
  canvas.height = img.naturalHeight || img.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return img;
  const { width, height } = canvas;
  ctx.drawImage(img, 0, 0);
  const pixels = ctx.getImageData(0, 0, width, height);

  if (preset === 'clarity' && material !== 'default') {
    gradeSurveyPixels(pixels.data, width, height, material);
    ctx.putImageData(pixels, 0, 0);
    return canvas;
  }

  const gray = new Uint8Array(width * height);
  const histogram = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) {
    const offset = i * 4;
    const value = Math.round(0.2126 * pixels.data[offset]! + 0.7152 * pixels.data[offset + 1]! + 0.0722 * pixels.data[offset + 2]!);
    gray[i] = value;
    histogram[value] = histogram[value]! + 1;
  }
  const stats = analyzeHistogram(histogram);
  const lut = buildToneLut(stats, preset, computePercentile(histogram, 0.95));
  const narrow = preset === 'clarity' && stats.narrow;
  const sepia = [201, 162, 95];
  const warmth = [5, 2, -3];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const value = gray[i]!;
      let adjusted = lut[value]!;
      if (preset === 'clarity' && y > 0 && y < height - 1 && x > 0 && x < width - 1) {
        let sum = 0;
        for (let row = i - width; row <= i + width; row += width) {
          sum += gray[row - 1]! + gray[row]! + gray[row + 1]!;
        }
        const mean = lut[Math.round(sum / 9)]!;
        const denoised = narrow ? adjusted * 0.78 + mean * 0.22 : adjusted;
        adjusted = denoised + (denoised - mean) * 0.35;
      }
      for (let c = 0; c < 3; c++) {
        const offset = i * 4 + c;
        const chroma = pixels.data[offset]! - value;
        pixels.data[offset] = preset === 'dossier'
          ? 0.85 * (adjusted + chroma) + 0.15 * sepia[c]!
          : adjusted + chroma * 1.08 + (narrow ? adjusted / 255 * warmth[c]! : 0);
      }
    }
  }
  ctx.putImageData(pixels, 0, 0);
  return canvas;
}

export function getEnhancedMap(
  url: string,
  preset: VisualPresetId,
  options?: MapToneOptions,
): Promise<MapImage> {
  const material: MapToneMaterial = options?.material ?? 'default';
  const key = material === 'default' || preset !== 'clarity'
    ? `${url}::${preset}`
    : `${url}::${preset}::${material}`;
  const cached = cache.get(key);
  if (cached) return Promise.resolve(cached);
  const existing = pending.get(key);
  if (existing) return existing;
  const load = new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Map image unavailable: ${url}`));
    img.src = withBaseUrl(url);
  }).then((img) => {
    let result: MapImage = img;
    try {
      result = enhance(img, preset, material);
    } catch {
      // Security-restricted or unavailable pixel access leaves the original drawable.
    }
    cache.set(key, result);
    return result;
  }).finally(() => pending.delete(key));
  pending.set(key, load);
  return load;
}

const storageKey = 'idv.flow.v1.visualPreset';
function readPreset(): VisualPresetId {
  try {
    const value = localStorage.getItem(storageKey);
    if (value === 'original' || value === 'dossier') return value;
  } catch {
    // Storage can be disabled.
  }
  return 'clarity';
}

const visualPreset = ref<VisualPresetId>(readPreset());
export function useMapPreset() {
  function setPreset(preset: VisualPresetId) {
    visualPreset.value = preset;
    try { localStorage.setItem(storageKey, preset); } catch { /* session-only */ }
  }
  return { visualPreset, setPreset };
}
