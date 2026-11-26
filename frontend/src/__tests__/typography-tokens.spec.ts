import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import * as typography from '../lib/typography';

const read = (path: string) => readFileSync(new URL(path, import.meta.url));
const theme = read('../styles/dossier-theme.css').toString();

function luminance(token: string): number {
  const hex = theme.match(new RegExp(`--${token}: #([0-9a-f]{6});`))?.[1];
  if (!hex) throw new Error(`Missing hex color token --${token}`);

  const linear = [0, 2, 4].map((index) => {
    const srgb = parseInt(hex.slice(index, index + 2), 16) / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  });
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

function contrast(first: string, second: string): number {
  const values = [luminance(first), luminance(second)];
  return (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05);
}

describe('dossier typography and surfaces', () => {
  it('meets WCAG AA on slate and exceeds 11:1 for ink on both paper tones', () => {
    for (const foreground of ['text', 'muted', 'dim']) {
      expect(contrast(foreground, 'surface-1'), foreground).toBeGreaterThanOrEqual(4.5);
    }
    for (const background of ['paper', 'paper-2']) {
      expect(contrast('ink', background), background).toBeGreaterThan(11);
      for (const foreground of ['ink-muted', 'ink-red', 'ink-blue']) {
        expect(contrast(foreground, background), foreground).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('keeps Phase 3 and Phase 6 styles local and sizes at or above 12px', () => {
    const fonts = read('../styles/fonts.css').toString();
    const views = read('../styles/dossier-views.css').toString();
    for (const requiredImport of [
      "@fontsource/noto-serif-sc/600.css",
      "@fontsource/noto-serif-sc/900.css",
      "@fontsource/cormorant-garamond/500-italic.css",
      "@fontsource/cormorant-garamond/600-italic.css",
      "@fontsource/cormorant-garamond/700.css",
      "@fontsource/cormorant-garamond/700-italic.css",
    ]) {
      expect(fonts).toContain(requiredImport);
    }
    expect(theme).toMatch(/select\.sel\s*\{[\s\S]*appearance:\s*none;/);
    expect(views).toMatch(/#bar \.identity i\s*\{[\s\S]*color:\s*#ff665e;/i);
    expect(views).not.toContain('#ffca8e');

    for (const path of [
      '../styles/fonts.css',
      '../styles/dossier-theme.css',
      '../styles/dossier-views.css',
      '../components/NoticeDialog.vue',
      '../components/HunterPop.vue',
      '../components/tactical/ManorOrnaments.vue',
      '../components/tactical/ManorMapFrame.vue',
      '../../index.html',
    ]) {
      const source = read(path).toString();
      expect(source, path).not.toMatch(/https?:\/\//i);
      for (const match of source.matchAll(/(?:font-size|--f-[\w-]+)\s*:\s*(\d+(?:\.\d+)?)px\b/g)) {
        expect(Number(match[1]), path).toBeGreaterThanOrEqual(12);
      }
    }
    expect(theme).not.toMatch(/SimSun|STSong|Microsoft YaHei/i);
    expect(views).not.toMatch(/SimSun|STSong|Microsoft YaHei/i);
  });

  it('exposes bundled Canvas stacks, preloads true italic Cormorant Garamond, and handles unavailable font storage', async () => {
    expect(typography.CANVAS_FONT_CJK).toBe('"Noto Serif SC", serif');
    expect(typography.CANVAS_FONT_LATIN).toContain('"Cinzel"');
    expect(typography.registerCustomDisplayFont).toBeTypeOf('function');
    expect(typography.saveCustomDisplayFont).toBeTypeOf('function');
    expect(typography.clearCustomDisplayFont).toBeTypeOf('function');
    const loadSpy = vi.fn().mockResolvedValue([]);
    Object.defineProperty(document, 'fonts', {
      value: { load: loadSpy, ready: Promise.resolve(), add: vi.fn(), delete: vi.fn() },
      configurable: true,
    });
    vi.stubGlobal('indexedDB', undefined);
    try {
      await expect(typography.whenFontsReady()).resolves.toBeUndefined();
      expect(loadSpy).toHaveBeenCalledWith(
        expect.stringContaining('600 italic 16px "Cormorant Garamond"'),
        expect.any(String),
      );
      await expect(typography.loadStoredCustomFont()).resolves.toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    ['manor-header-crest', 2172, 724, 6],
    ['parchment-etching-gate', 1774, 887, 6],
    ['analytics-header-sketch', 2172, 724, 6],
    ['parchment-tile', 1254, 1254, 2],
    ['desk-fountain-pen', 1774, 887, 6],
    ['desk-pocket-watch', 1254, 1254, 6],
    ['desk-vintage-postcard', 1536, 1024, 6],
  ])('ships %s with the expected PNG header', (name, width, height, colorType) => {
    const png = read(`../../public/assets/dossier/${name}.png`);
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(png.toString('ascii', 12, 16)).toBe('IHDR');
    expect(png.readUInt32BE(16)).toBe(width);
    expect(png.readUInt32BE(20)).toBe(height);
    expect(png[25]).toBe(colorType);
  });
});
