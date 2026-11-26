/**
 * Compile-only check (tsconfig.dom-compat.json, lib DOM enabled ONLY here, never for src/):
 * a real browser CanvasRenderingContext2D must be assignable to Canvas2DContextLike
 * without casts, so T-003 can pass canvas.getContext('2d') straight to the renderer.
 */
import { TacticalReplayRenderer, type Canvas2DContextLike, type CanvasImageSourceLike } from '../../src/index';

declare const domCtx: CanvasRenderingContext2D;
declare const domImg: HTMLImageElement;

export const ctx: Canvas2DContextLike = domCtx;
export const img: CanvasImageSourceLike = domImg;
export const renderer = new TacticalReplayRenderer(domCtx, { width: 800, height: 600, dpr: 2 });
renderer.setUnderlay({ enabled: true, image: domImg, worldRect: { min_x: 0, max_x: 1, min_z: 0, max_z: 1 } });
