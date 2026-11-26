/**
 * Synchronized 2D / 2.5D Canvas 2D Overlay Renderer for Stage 2 (02 战术沙盘).
 * Projects all PIL tactical whiteboard entities (landmarks, carry/tide range bands,
 * explorer treasure rings, token/prop ranges & links, drawings, measurements,
 * animation waypoints, tokens, props, and text notes) onto <canvas data-test="tactical-overlay-canvas">
 * using TacticalReplayRenderer's live 2D/2.5D projection matrix.
 */
import { CANVAS_FONT_CJK } from '@/lib/typography';
import type { Canvas2DContextLike, ScreenPoint, TacticalReplayRenderer, ViewportSize } from '@idv/replay-renderer';
import {
  CARRY_BAND_COLORS,
  CARRY_BAND_OPACITY,
  TAC_ITEM_TYPES,
  TAC_ROLES,
  TAC_TREASURE_RULE,
  TIDE_BAND_COLORS,
  TIDE_BAND_OPACITY,
  WORLD_UNITS_PER_METER,
  animDuration,
  animPositionAt,
  animSegPath,
  buildNavFieldRgba,
  carryDropBudget,
  cipherOf,
  createCarryProfile,
  getTreasureRings,
  mapsZonesRelative,
  type AnimSegDurFn,
  type CarryChairEval,
  type Point2D,
  type TacticalBoardState,
  type TacticalShape,
  type TideChairEval,
} from '@/tactical';
import {
  groupMeasureLines,
  letterLabel,
  propColor,
  propDisplayName,
  resolvePropRangeCircles,
  resolveTokenRangeCircles,
  tokenCamp,
  tokenColor,
  tokenDisplayName,
  type BoardChairCandidate,
  type BoardGeoContext,
  type BoardProp,
  type BoardSelection,
  type BoardToken,
  type BoardToolId,
  type LandmarkVisibility,
  type RangeEvaluation,
  type RangeNavFieldOverlay,
  type RangeOverlayState,
} from '@/lib/board';

export interface OverlayRenderParams {
  geo: BoardGeoContext;
  board: TacticalBoardState;
  landmarks: LandmarkVisibility;
  cipherGroupIndex: number;
  activeTool: BoardToolId;
  selection: BoardSelection;
  landmarksChairs: readonly BoardChairCandidate[];
  rangeState: RangeOverlayState;
  rangeEval: RangeEvaluation | null;
  drawingPreview: TacticalShape | null;
  measurePending: Point2D | null;
  measureHover: Point2D | null;
  snapPoint: Point2D | null;
  animTime: number | null;
  animPlaying: boolean;
  hunterPortraits: ReadonlyMap<string, HTMLImageElement>;
  routePointA?: Point2D | null;
  routePointB?: Point2D | null;
  highlightedCipherId?: string | null;
}

interface NavFieldCanvasCache {
  canvas: HTMLCanvasElement;
  bandOf: Int8Array;
  scenario: 'carry' | 'tide';
  hiddenKey: string;
  opacity: number;
  gridW: number;
  gridH: number;
}

let navFieldCache: NavFieldCanvasCache | null = null;

function getNavFieldOffscreenCanvas(
  navField: RangeNavFieldOverlay,
  hiddenBands: readonly number[],
  opacity: number,
): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  const hiddenKey = [...hiddenBands].sort((a, b) => a - b).join(',');
  if (
    navFieldCache &&
    navFieldCache.bandOf === navField.bandOf &&
    navFieldCache.scenario === navField.scenario &&
    navFieldCache.hiddenKey === hiddenKey &&
    Math.abs(navFieldCache.opacity - opacity) < 1e-4 &&
    navFieldCache.gridW === navField.gridW &&
    navFieldCache.gridH === navField.gridH
  ) {
    return navFieldCache.canvas;
  }

  const canvas = navFieldCache?.canvas ?? document.createElement('canvas');
  if (canvas.width !== navField.gridW) canvas.width = navField.gridW;
  if (canvas.height !== navField.gridH) canvas.height = navField.gridH;
  const offCtx = canvas.getContext('2d');
  if (offCtx) {
    const rgba = buildNavFieldRgba(navField.bandOf, navField.scenario, hiddenBands, opacity);
    if (typeof offCtx.createImageData === 'function' && typeof offCtx.putImageData === 'function') {
      const imgData = offCtx.createImageData(navField.gridW, navField.gridH);
      if (imgData?.data && imgData.data.length === rgba.length) {
        imgData.data.set(rgba);
        offCtx.putImageData(imgData, 0, 0);
      }
    }
  }
  navFieldCache = {
    canvas,
    bandOf: navField.bandOf,
    scenario: navField.scenario,
    hiddenKey,
    opacity,
    gridW: navField.gridW,
    gridH: navField.gridH,
  };
  return canvas;
}



function projectGroundCircle(
  renderer: TacticalReplayRenderer,
  wx: number,
  y: number,
  wz: number,
  radiusWorld: number,
  segments = 48,
): ScreenPoint[] {
  const pts: ScreenPoint[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (Math.PI * 2 * i) / segments;
    pts.push(renderer.project([wx + Math.cos(a) * radiusWorld, y, wz + Math.sin(a) * radiusWorld]));
  }
  return pts;
}

function tracePoly(ctx: Canvas2DContextLike, pts: readonly { x: number; y: number }[], closed = true): void {
  if (!pts.length) return;
  ctx.beginPath();
  pts.forEach((p, idx) => (idx === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  if (closed) ctx.closePath();
}

function drawBadge(
  ctx: Canvas2DContextLike,
  x: number,
  y: number,
  text: string,
  textColor: string,
  fontSize = 11,
  borderColor = 'rgba(142, 122, 74, 0.75)',
  bgColor = 'rgba(11, 10, 9, 0.86)',
): void {
  ctx.save();
  ctx.font = `600 ${fontSize}px ${CANVAS_FONT_CJK}`;
  const metrics = ctx.measureText ? ctx.measureText(text) : { width: text.length * fontSize * 0.68 };
  const padX = 6;
  const padY = 3;
  const w = metrics.width + padX * 2;
  const h = fontSize + padY * 2;
  ctx.fillStyle = bgColor;
  ctx.fillRect(x - w / 2, y - h / 2, w, h);
  ctx.strokeStyle = borderColor;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.rect(x - w / 2, y - h / 2, w, h);
  ctx.stroke();
  ctx.fillStyle = textColor;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y + 0.5);
  ctx.restore();
}

function drawGroundAnnulus(
  ctx: Canvas2DContextLike,
  renderer: TacticalReplayRenderer,
  wx: number,
  y: number,
  wz: number,
  innerWorld: number,
  outerWorld: number,
  fillColor: string,
  fillAlpha: number,
  strokeColor: string,
  strokeAlpha: number,
  dashed = true,
  lineWidth = 1.6,
): void {
  const outerPts = projectGroundCircle(renderer, wx, y, wz, outerWorld, 48);
  const innerPts = innerWorld > 0.5 ? projectGroundCircle(renderer, wx, y, wz, innerWorld, 48) : null;

  ctx.save();
  if (fillAlpha > 0) {
    ctx.globalAlpha = fillAlpha;
    ctx.fillStyle = fillColor;
    ctx.beginPath();
    outerPts.forEach((p, idx) => (idx === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.closePath();
    if (innerPts) {
      // Reverse winding for even-odd / nonzero cutout compatibility
      for (let i = innerPts.length - 1; i >= 0; i--) {
        const p = innerPts[i]!;
        if (i === innerPts.length - 1) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      }
      ctx.closePath();
    }
    // CanvasRenderingContext2D supports 'evenodd'; stub ignores extra args safely
    (ctx.fill as (rule?: string) => void)('evenodd');
  }
  if (strokeAlpha > 0) {
    ctx.globalAlpha = strokeAlpha;
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = lineWidth;
    ctx.setLineDash(dashed ? [6, 4] : []);
    tracePoly(ctx, outerPts, true);
    ctx.stroke();
    if (innerPts) {
      tracePoly(ctx, innerPts, true);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function effectiveAnimDuration(
  entries: ReadonlyArray<{ anim?: BoardToken['anim'] }>,
  geo: BoardGeoContext,
): number {
  let maxEnd = 0;
  for (const e of entries) {
    if (!e.anim || (e.anim.points?.length ?? 0) < 2) continue;
    const { end } = animDuration(e.anim, geo.animGeom);
    if (end > maxEnd) maxEnd = end;
  }
  return maxEnd;
}

function resolveAnimatedPos(
  item: { x: number; y: number; anim?: BoardToken['anim'] },
  geo: BoardGeoContext,
  animTime: number | null,
  segDurFn?: AnimSegDurFn | null,
): Point2D {
  if (animTime === null || !item.anim || (item.anim.points?.length ?? 0) < 2) {
    return { x: item.x, y: item.y };
  }
  const pos = animPositionAt(item.anim, geo.animGeom, animTime, segDurFn);
  return pos ? { x: pos.x, y: pos.y } : { x: item.x, y: item.y };
}

function drawLandmarks(
  ctx: Canvas2DContextLike,
  renderer: TacticalReplayRenderer,
  params: OverlayRenderParams,
): void {
  const { geo, board, landmarks } = params;
  const map = geo.mapData;
  const [dw, dh] = map.mapSize;

  // 1. PIL Zone Grid (standalone or explicitly toggled)
  if (landmarks.zones) {
    const zones = mapsZonesRelative[geo.mapId] ?? [];
    ctx.save();
    zones.forEach((z, idx) => {
      const corners = [
        renderer.project(geo.relToWorld(z.x, z.y, 0)),
        renderer.project(geo.relToWorld(z.x + z.width, z.y, 0)),
        renderer.project(geo.relToWorld(z.x + z.width, z.y + z.height, 0)),
        renderer.project(geo.relToWorld(z.x, z.y + z.height, 0)),
      ];
      ctx.globalAlpha = 0.55;
      ctx.strokeStyle = 'rgba(201, 162, 95, 0.72)';
      ctx.lineWidth = 1.25;
      ctx.setLineDash([5, 4]);
      tracePoly(ctx, corners, true);
      ctx.stroke();

      const center = renderer.project(geo.relToWorld(z.x + z.width / 2, z.y + z.height / 2, 0));
      const zName = map.zoneNames[idx] ?? `区${idx + 1}`;
      ctx.globalAlpha = 0.75;
      ctx.font = `600 12px ${CANVAS_FONT_CJK}`;
      ctx.fillStyle = '#ddd3bd';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(zName, center.x, center.y);
    });
    ctx.restore();
  }

  // 2. Spawn Point Group
  if (landmarks.spawns && map.spawnPoints.length > 0) {
    const sIdx = ((board.spawnIndex % map.spawnPoints.length) + map.spawnPoints.length) % map.spawnPoints.length;
    const grp = map.spawnPoints[sIdx]!;
    const spawnR = Math.max(6, Math.min(18, (landmarks.sizes?.spawn ?? 6) * 1.5));
    const drawSpawnPin = (pt: [number, number], isHunter: boolean, label: string) => {
      const sp = renderer.project(geo.relToWorld(pt[0] / dw, pt[1] / dh, 0));
      ctx.save();
      ctx.fillStyle = isHunter ? '#8e2f3c' : '#1b2430';
      ctx.strokeStyle = isHunter ? '#c9a25f' : '#6f8fb8';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, spawnR, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.font = `700 12px ${CANVAS_FONT_CJK}`;
      ctx.fillStyle = isHunter ? '#ffd6dc' : '#dfe7f2';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, sp.x, sp.y);
      ctx.restore();
    };
    grp.survivor.forEach((pt, idx) => drawSpawnPin(pt, false, `求${idx + 1}`));
    drawSpawnPin(grp.hunter, true, '监');
  }

  // 2b. Lockers (柜子)
  if (landmarks.lockers && map.lockers.length > 0) {
    const lr = Math.max(4, Math.min(12, (landmarks.sizes?.locker ?? 3) * 1.8));
    for (const pt of map.lockers) {
      const sp = renderer.project(geo.relToWorld(pt[0] / dw, pt[1] / dh, 0));
      ctx.save();
      ctx.fillStyle = 'rgba(30, 24, 18, 0.9)';
      ctx.strokeStyle = '#d4a373';
      ctx.lineWidth = 1.5;
      ctx.fillRect(sp.x - lr, sp.y - lr, lr * 2, lr * 2);
      ctx.beginPath();
      ctx.rect(sp.x - lr, sp.y - lr, lr * 2, lr * 2);
      ctx.stroke();
      if (lr >= 5.5) {
        ctx.font = `700 10px ${CANVAS_FONT_CJK}`;
        ctx.fillStyle = '#f4d9b5';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('柜', sp.x, sp.y + 0.5);
      }
      ctx.restore();
    }
  }

  // 2c. Phone Booths (电话亭)
  if (landmarks.phoneBooths && map.phoneBooths?.length) {
    const pr = Math.max(5, Math.min(13, (landmarks.sizes?.phoneBooth ?? 3) * 2.0));
    for (const pt of map.phoneBooths) {
      const sp = renderer.project(geo.relToWorld(pt[0] / dw, pt[1] / dh, 0));
      ctx.save();
      ctx.fillStyle = 'rgba(18, 32, 42, 0.92)';
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(sp.x, sp.y - pr);
      ctx.lineTo(sp.x + pr, sp.y);
      ctx.lineTo(sp.x, sp.y + pr);
      ctx.lineTo(sp.x - pr, sp.y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.font = `700 10px ${CANVAS_FONT_CJK}`;
      ctx.fillStyle = '#bae6fd';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('电', sp.x, sp.y + 0.5);
      ctx.restore();
    }
  }

  // 2d. Basement Chest (地下室箱)
  if (landmarks.basementChest) {
    const bs = Object.values(map.basements);
    if (bs.length > 0) {
      const bIdx = ((board.boxBasementIndex % bs.length) + bs.length) % bs.length;
      const br = Math.max(5, Math.min(13, (landmarks.sizes?.box ?? 3) * 2.0));
      for (const pt of bs[bIdx]!.chest) {
        const px = pt[0];
        const pz = pt.length === 3 ? pt[2] : pt[1];
        const sp = renderer.project(geo.relToWorld(px / dw, pz / dh, 0));
        ctx.save();
        ctx.fillStyle = 'rgba(42, 26, 14, 0.92)';
        ctx.strokeStyle = '#f59e0b';
        ctx.lineWidth = 1.8;
        ctx.fillRect(sp.x - br, sp.y - br, br * 2, br * 2);
        ctx.beginPath();
        ctx.rect(sp.x - br, sp.y - br, br * 2, br * 2);
        ctx.stroke();
        ctx.font = `700 10px ${CANVAS_FONT_CJK}`;
        ctx.fillStyle = '#fde68a';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('箱', sp.x, sp.y + 0.5);
        ctx.restore();
      }
    }
  }

  // 3. Fixed Spawns (global toggle OR per-token showFixedSpawns / fixedSpawnScreen)
  const globalScreen = landmarks.fixedSpawnScreen ?? 'off';
  for (const [role, cfg] of Object.entries(map.fixedSpawns ?? {})) {
    const tok = (board.tokens as BoardToken[]).find((t) => t.role === role);
    const showPoints = landmarks.fixedSpawns || Boolean(tok?.showFixedSpawns);
    const showRange = Boolean(tok?.showFixedSpawnRange) || (role === 'madEyes' && globalScreen !== 'off');
    if (!showPoints && !showRange) continue;
    const items = Array.isArray(cfg.item) ? cfg.item : [cfg.item];
    const dev: 'pc' | 'ios' =
      tok?.showFixedSpawnRange && tok.fixedSpawnDevice
        ? tok.fixedSpawnDevice
        : globalScreen === 'ios'
          ? 'ios'
          : 'pc';
    for (const fsItem of items) {
      if (!fsItem) continue;
      for (const rawPt of fsItem.points) {
        const pt = Array.isArray(rawPt) ? rawPt : rawPt.p;
        const dir = !Array.isArray(rawPt) ? rawPt.d : undefined;
        const u = pt[0] / dw;
        const v = pt[1] / dh;
        const worldPos = geo.relToWorld(u, v, 0);
        if (showRange && fsItem.rangeM) {
          // Circular console rangeM coverage
          const rW = geo.metersToWorld(fsItem.rangeM);
          drawGroundAnnulus(
            ctx,
            renderer,
            worldPos[0],
            0,
            worldPos[2],
            0,
            rW,
            '#38bdf8',
            0.07,
            '#7dd3fc',
            0.65,
            true,
            1.2,
          );
          // Mad Eyes PC/iOS console screen viewport rectangle (sw x sh meters)
          if (fsItem.rangeScreenM) {
            const [sw, sh] = fsItem.rangeScreenM[dev];
            const hw = geo.metersToWorld(sw / 2);
            const hh = geo.metersToWorld(sh / 2);
            const rectCorners = [
              renderer.project([worldPos[0] - hw, 0, worldPos[2] - hh]),
              renderer.project([worldPos[0] + hw, 0, worldPos[2] - hh]),
              renderer.project([worldPos[0] + hw, 0, worldPos[2] + hh]),
              renderer.project([worldPos[0] - hw, 0, worldPos[2] + hh]),
            ];
            ctx.save();
            ctx.fillStyle = 'rgba(56, 189, 248, 0.14)';
            ctx.strokeStyle = 'rgba(125, 211, 252, 0.92)';
            ctx.lineWidth = 1.5;
            ctx.setLineDash([]);
            tracePoly(ctx, rectCorners, true);
            ctx.fill();
            ctx.stroke();
            ctx.restore();
          }
        }
        if (showPoints) {
          const sp = renderer.project(worldPos);
          ctx.save();
          ctx.fillStyle = 'rgba(16, 14, 12, 0.9)';
          ctx.strokeStyle = '#7dd3fc';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(sp.x, sp.y, 6, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          if (dir && landmarks.fixedSpawnDir !== false && (tok?.showSpawnDir ?? true)) {
            const dLen = Math.hypot(dir[0], dir[1]) || 1;
            const nx = dir[0] / dLen;
            const ny = dir[1] / dLen;
            const endWorld = geo.relToWorld(u + nx * 0.032, v + ny * 0.032, 0);
            const ep = renderer.project(endWorld);
            const sdx = ep.x - sp.x;
            const sdy = ep.y - sp.y;
            const sLen = Math.hypot(sdx, sdy) || 1;
            const ux = sdx / sLen;
            const uy = sdy / sLen;
            const px = -uy;
            const py = ux;
            ctx.strokeStyle = '#7dd3fc';
            ctx.fillStyle = '#7dd3fc';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(sp.x, sp.y);
            ctx.lineTo(ep.x, ep.y);
            ctx.stroke();
            // Orientation arrowhead
            const headLen = Math.min(7, sLen * 0.45);
            const headW = 3.5;
            ctx.beginPath();
            ctx.moveTo(ep.x, ep.y);
            ctx.lineTo(ep.x - ux * headLen + px * headW, ep.y - uy * headLen + py * headW);
            ctx.lineTo(ep.x - ux * headLen - px * headW, ep.y - uy * headLen - py * headW);
            ctx.closePath();
            ctx.fill();
          }
          const shortLbl = TAC_ITEM_TYPES[fsItem.icon]?.glyph ?? cfg.label.slice(0, 2);
          ctx.font = `700 11px ${CANVAS_FONT_CJK}`;
          ctx.fillStyle = '#bae6fd';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(shortLbl, sp.x, sp.y);
          ctx.restore();
        }
      }
    }
  }

  // 4. Highlighted Cipher Pulse (from 密码机速查 card)
  if (params.highlightedCipherId) {
    const hc = cipherOf(geo.mapId, params.highlightedCipherId);
    if (hc) {
      const sp = renderer.project(geo.relToWorld(hc.location[0] / dw, hc.location[1] / dh, 0));
      ctx.save();
      ctx.strokeStyle = '#fbbf24';
      ctx.lineWidth = 2.6;
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, 16, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(251, 191, 36, 0.55)';
      ctx.lineWidth = 1.6;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, 23, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
      drawBadge(ctx, sp.x, sp.y - 26, `电机 · ${hc.name}`, '#fde68a', 11, '#fbbf24');
    }
  }

  // 5. P0 Standalone Cipher Progress Overlay (残局压机/破译进度条)
  if (geo.isStandalone && landmarks.ciphers && board.cipherProgressEnabled && board.cipherProgress) {
    const grp = map.cipherCombinations[params.cipherGroupIndex] ?? [];
    for (const cid of grp) {
      const c = cipherOf(geo.mapId, cid);
      if (!c) continue;
      const pct = Math.max(0, Math.min(100, Math.round(board.cipherProgress[cid] ?? 0)));
      const sp = renderer.project(geo.relToWorld(c.location[0] / dw, c.location[1] / dh, 0));
      const isDone = pct >= 100;
      const isPrimed = pct >= 90 && pct < 100;
      const color = isDone ? '#34d399' : isPrimed ? '#fbbf24' : pct > 0 ? '#38bdf8' : '#9a8f7a';
      const label = isDone ? '100% 完' : isPrimed ? `${pct}% 压机` : `${pct}%`;

      // Progress ring around cipher icon
      ctx.save();
      ctx.strokeStyle = 'rgba(11, 10, 9, 0.78)';
      ctx.lineWidth = 4.5;
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, 13, 0, Math.PI * 2);
      ctx.stroke();
      if (pct > 0) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, 13, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * pct) / 100);
        ctx.stroke();
      }
      ctx.restore();
      if (pct > 0) {
        drawBadge(ctx, sp.x, sp.y - 22, label, color, 10, color);
      }
    }
  }
}

function drawRangeOverlay(
  ctx: Canvas2DContextLike,
  renderer: TacticalReplayRenderer,
  params: OverlayRenderParams,
): void {
  const { geo, rangeState, rangeEval } = params;
  const origin = rangeState.origin;
  if (!origin) return;

  const hidden = new Set(rangeState.hiddenBands);
  const wx = geo.relToWorld(origin.x, origin.y, 0);
  const originScreen = renderer.project(wx);

  if (rangeEval && rangeState.mode === 'chair') {
    const navField = rangeEval.navField;
    if (navField) {
      // Draw obstacle-respecting 5-band contour raster onto the Y=0 map quad
      const offCanvas = getNavFieldOffscreenCanvas(navField, rangeState.hiddenBands, rangeState.opacity);
      if (offCanvas) {
        const p00 = renderer.project(geo.relToWorld(0, 0, 0));
        const p10 = renderer.project(geo.relToWorld(1, 0, 0));
        const p01 = renderer.project(geo.relToWorld(0, 1, 0));
        const a = (p10.x - p00.x) / navField.gridW;
        const b = (p10.y - p00.y) / navField.gridW;
        const c = (p01.x - p00.x) / navField.gridH;
        const d = (p01.y - p00.y) / navField.gridH;
        ctx.save();
        ctx.transform(a, b, c, d, p00.x, p00.y);
        ctx.drawImage(offCanvas, 0, 0, navField.gridW, navField.gridH);
        ctx.restore();
      }
      if (!rangeState.hideRingLabel) {
        drawBadge(
          ctx,
          originScreen.x,
          originScreen.y - 22,
          `${origin.label} · ${rangeState.scenario === 'tide' ? '化险为夷绕障圈' : '牵气球绕障圈'}`,
          '#fde68a',
          10,
          '#c9a25f',
        );
      }
    } else {
      // Graceful radial fallback while nav-grid is loading or unavailable
      const bands = rangeEval.radialBands;
      for (let i = bands.length - 1; i >= 0; i--) {
        const b = bands[i]!;
        if (hidden.has(b.band) || b.maxRadiusM <= 0) continue;
        const innerW = geo.metersToWorld(b.minRadiusM);
        const outerW = geo.metersToWorld(b.maxRadiusM);
        drawGroundAnnulus(
          ctx,
          renderer,
          wx[0],
          0,
          wx[2],
          innerW,
          outerW,
          b.color,
          b.opacity * rangeState.opacity,
          b.color,
          Math.min(0.95, rangeState.opacity + 0.2),
          true,
          1.6,
        );
        if (!rangeState.hideRingLabel) {
          const edgePt = renderer.project([wx[0], 0, wx[2] - outerW]);
          drawBadge(
            ctx,
            edgePt.x,
            edgePt.y,
            `${b.maxRadiusM.toFixed(1)}m (${b.maxSeconds.toFixed(1)}s)`,
            b.color,
            10,
            b.color,
          );
        }
      }
    }
    if (!rangeState.hideRing) {
      ctx.save();
      ctx.strokeStyle = '#ff5252';
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.arc(originScreen.x, originScreen.y, 15, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  if (rangeState.mode === 'point') {
    // Draw start/target pin
    ctx.save();
    ctx.fillStyle = '#ff5252';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(originScreen.x, originScreen.y, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    if (!rangeState.hideRingLabel) {
      drawBadge(
        ctx,
        originScreen.x,
        originScreen.y - 16,
        rangeState.scenario === 'tide' ? '化险为夷起点' : '牵气球起点',
        '#ff8a8a',
        10,
        '#ff5252',
      );
    }

    if (rangeEval) {
      const colors = rangeEval.scenario === 'tide' ? TIDE_BAND_COLORS : CARRY_BAND_COLORS;
      const profile =
        rangeEval.scenario === 'carry'
          ? createCarryProfile({
              survivorId: rangeState.survivorId,
              baseSpeed: rangeState.carryBaseSpeed,
              initialProgress: rangeState.initialProgress,
              pickupSeconds: rangeState.pickupSeconds,
              buffs: rangeState.carryBuffs.map(({ key, level }) => ({ key, level })),
            })
          : null;

      rangeEval.chairRows.forEach((row, rowIdx) => {
        if (row.band < 0) return;
        const cPos = renderer.project(geo.relToWorld(row.x, row.y, 0));
        let label = `${row.travelSeconds.toFixed(1)}s`;
        if (rangeEval.scenario === 'tide') {
          const tr = row as TideChairEval;
          if (tr.inMargin) label = `${row.travelSeconds.toFixed(1)}s 余量`;
        } else {
          const cr = row as CarryChairEval;
          const risk = profile ? carryDropBudget(profile, cr.travelSeconds).risk : cr.risk;
          if (risk) label = `${row.travelSeconds.toFixed(1)}s ⚠`;
        }
        const col = colors[row.band] ?? '#a4afbb';
        ctx.save();
        ctx.strokeStyle = col;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(cPos.x, cPos.y, 8, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
        if (!rangeState.hideRingLabel) {
          drawBadge(ctx, cPos.x, cPos.y - 16, label, col, 10, col);
        }
        if (rangeState.detailMarkIndex === rowIdx) {
          ctx.save();
          ctx.strokeStyle = '#ff5252';
          ctx.lineWidth = 2.4;
          ctx.beginPath();
          ctx.arc(cPos.x, cPos.y, 16, 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
        }
      });
    }
  }
}

function drawTreasureOverlay(
  ctx: Canvas2DContextLike,
  renderer: TacticalReplayRenderer,
  params: OverlayRenderParams,
): void {
  const { geo, board, cipherGroupIndex, animTime } = params;
  const explorer = (board.tokens as BoardToken[]).find(
    (t) => t.role === 'explorer' && t.showTreasureRange,
  );
  if (!explorer) return;

  const pos = resolveAnimatedPos(explorer, geo, animTime);
  const rings = getTreasureRings(
    geo.mapData,
    { x: pos.x, y: pos.y, showTreasureRange: true },
    cipherGroupIndex,
    TAC_TREASURE_RULE,
  );

  // Draw 70m discovery circle around explorer
  const expW = geo.relToWorld(pos.x, pos.y, 0);
  const rangePts = projectGroundCircle(
    renderer,
    expW[0],
    0,
    expW[2],
    geo.metersToWorld(TAC_TREASURE_RULE.rangeM),
    56,
  );
  ctx.save();
  ctx.strokeStyle = 'rgba(201, 162, 95, 0.45)';
  ctx.lineWidth = 1.25;
  ctx.setLineDash([7, 5]);
  tracePoly(ctx, rangePts, true);
  ctx.stroke();
  ctx.restore();

  // Draw cipher rings (5.5m - 7.3m) and nearest exclusion ring
  for (const ring of rings) {
    const rw = geo.relToWorld(ring.x, ring.y, 0);
    const innerWorld = geo.metersToWorld(ring.innerRadius * geo.mapData.widthM);
    const outerWorld = geo.metersToWorld(ring.outerRadius * geo.mapData.widthM);
    const strokeCol = ring.excluded ? '#b04a58' : '#c9a25f';
    const fillCol = ring.excluded ? '#b04a58' : '#c9a25f';
    drawGroundAnnulus(
      ctx,
      renderer,
      rw[0],
      0,
      rw[2],
      innerWorld,
      outerWorld,
      fillCol,
      ring.excluded ? 0.22 : 0.28,
      strokeCol,
      0.9,
      true,
      1.8,
    );
    const sp = renderer.project(rw);
    const cName = cipherOf(geo.mapId, ring.cipherId)?.name ?? ring.cipherId;
    drawBadge(
      ctx,
      sp.x,
      sp.y - 16,
      ring.excluded ? `排除 · ${cName}` : `书页 · ${cName}`,
      ring.excluded ? '#f2a2ac' : '#f3d69a',
      10,
      strokeCol,
    );
  }
}

function drawTokenAndPropRangesAndLinks(
  ctx: Canvas2DContextLike,
  renderer: TacticalReplayRenderer,
  params: OverlayRenderParams,
): void {
  const { geo, board, animTime } = params;
  const tokens = board.tokens as BoardToken[];
  const items = board.items as BoardProp[];

  const tokenPosMap = new Map<number, Point2D>();
  for (const tk of tokens) {
    tokenPosMap.set(tk.tid, resolveAnimatedPos(tk, geo, animTime));
  }
  const propPosMap = new Map<number, Point2D>();
  for (const it of items) {
    propPosMap.set(it.iid, resolveAnimatedPos(it, geo, animTime));
  }

  // 1. Same-kind links (Priestess portals, Violinist notes, Sculptor statues, Warp)
  const seenSame = new Set<number>();
  for (const it of items) {
    const def = TAC_ITEM_TYPES[it.kind];
    if (!def || def.render !== 'link' || it.linkIid == null || it.linkShow === false) continue;
    if (seenSame.has(it.iid)) continue;
    const partner = items.find((o) => o.iid === it.linkIid);
    seenSame.add(it.iid);
    if (!partner || partner.linkShow === false || seenSame.has(partner.iid)) continue;
    seenSame.add(partner.iid);
    const pa = propPosMap.get(it.iid) ?? it;
    const pb = propPosMap.get(partner.iid) ?? partner;
    const sa = renderer.project(geo.relToWorld(pa.x, pa.y, 0));
    const sb = renderer.project(geo.relToWorld(pb.x, pb.y, 0));
    ctx.save();
    ctx.strokeStyle = def.linkColor ?? def.color ?? '#f8fafc';
    ctx.lineWidth = def.linkWidth ?? 2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(sa.x, sa.y);
    ctx.lineTo(sb.x, sb.y);
    ctx.stroke();
    ctx.restore();
  }

  // 2. Cross-kind links (Cowboy lasso, GameKeeper hook, WuChang umbrella, Naiad, BloodyQueen aquaMirror)
  for (const it of items) {
    const def = TAC_ITEM_TYPES[it.kind];
    if (!def || !def.linkToRole || it.linkTid == null || it.linkShow === false) continue;
    const tk = tokens.find((t) => t.tid === it.linkTid);
    if (!tk || tk.linkShow === false) continue;
    const pItem = propPosMap.get(it.iid) ?? it;
    const pTok = tokenPosMap.get(tk.tid) ?? tk;
    const sa = renderer.project(geo.relToWorld(pTok.x, pTok.y, 0));
    const sb = renderer.project(geo.relToWorld(pItem.x, pItem.y, 0));
    ctx.save();
    ctx.strokeStyle = it.kind === 'aquaMirror' ? '#7dd3fc' : def.linkColor ?? def.color ?? '#f8fafc';
    ctx.lineWidth = def.linkWidth ?? 2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(sa.x, sa.y);
    ctx.lineTo(sb.x, sb.y);
    ctx.stroke();
    if (it.kind === 'aquaMirror') {
      const mi = items.find((o) => o.kind === 'mirrorImage' && (o.aqIid == null || o.aqIid === it.iid));
      if (mi) {
        const pm = propPosMap.get(mi.iid) ?? mi;
        const sm = renderer.project(geo.relToWorld(pm.x, pm.y, 0));
        ctx.beginPath();
        ctx.moveTo(sb.x, sb.y);
        ctx.lineTo(sm.x, sm.y);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  // 2b. P2 Hitting-Point & Abyss Chain Polylines / Closed Zone Polygons (4–35m)
  const chainGroups = new Map<string, BoardProp[]>();
  for (const it of items) {
    if ((it.kind === 'contactPoint' || it.kind === 'surgingTides') && it.allowLink !== false && it.chainId != null && it.linkShow !== false) {
      const gk = `${it.kind}:${it.chainId}`;
      let arr = chainGroups.get(gk);
      if (!arr) {
        arr = [];
        chainGroups.set(gk, arr);
      }
      arr.push(it);
    }
  }
  for (const group of chainGroups.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => (a.chainOrder ?? a.iid) - (b.chainOrder ?? b.iid));
    const isClosed = Boolean(group[0]!.chainClosed && group.length >= 3);
    const isAbyss = group[0]!.kind === 'surgingTides';
    const strokeCol = isAbyss ? '#38bdf8' : '#f472b6';
    const fillCol = isAbyss ? 'rgba(56, 189, 248, 0.22)' : 'rgba(244, 114, 182, 0.2)';
    const screenPts = group.map((it) => {
      const p = propPosMap.get(it.iid) ?? it;
      return renderer.project(geo.relToWorld(p.x, p.y, 0));
    });
    ctx.save();
    if (isClosed) {
      ctx.fillStyle = fillCol;
      tracePoly(ctx, screenPts, true);
      ctx.fill();
    }
    ctx.strokeStyle = strokeCol;
    ctx.lineWidth = 2.4;
    ctx.setLineDash(isClosed ? [] : [6, 4]);
    tracePoly(ctx, screenPts, isClosed);
    ctx.stroke();
    ctx.restore();

    // Per-edge metric distance badges
    const edgeCount = isClosed ? group.length : group.length - 1;
    for (let i = 0; i < edgeCount; i++) {
      const a = group[i]!;
      const b = group[(i + 1) % group.length]!;
      const pa = propPosMap.get(a.iid) ?? a;
      const pb = propPosMap.get(b.iid) ?? b;
      const distM = geo.distMeters(pa, pb);
      const sa = screenPts[i]!;
      const sb = screenPts[(i + 1) % group.length]!;
      drawBadge(
        ctx,
        (sa.x + sb.x) / 2,
        (sa.y + sb.y) / 2,
        `${distM.toFixed(1)}m`,
        strokeCol,
        10,
        strokeCol,
      );
    }
  }

  // 3. Prop range circles / blast crosses
  for (const it of items) {
    const p = propPosMap.get(it.iid) ?? it;
    const w = geo.relToWorld(p.x, p.y, 0);
    const circles = resolvePropRangeCircles(it, geo.effectiveWidthM);
    for (const c of circles) {
      const rW = geo.metersToWorld(c.radiusM);
      const innerW = c.innerRadiusM ? geo.metersToWorld(c.innerRadiusM) : 0;
      drawGroundAnnulus(
        ctx,
        renderer,
        w[0],
        0,
        w[2],
        innerW,
        rW,
        c.color,
        c.fill ? 0.16 : 0,
        c.color,
        0.85,
        true,
        1.5,
      );
      if (c.crossWidthM && c.crossWidthM > 0) {
        const halfArm = rW;
        const halfThick = geo.metersToWorld(c.crossWidthM / 2);
        const angle = ((it.angle ?? 0) * Math.PI) / 180;
        const cosA = Math.cos(angle);
        const sinA = Math.sin(angle);
        const rot = (lx: number, lz: number): ScreenPoint =>
          renderer.project([w[0] + lx * cosA - lz * sinA, 0, w[2] + lx * sinA + lz * cosA]);
        const arm1 = [
          rot(-halfArm, -halfThick),
          rot(halfArm, -halfThick),
          rot(halfArm, halfThick),
          rot(-halfArm, halfThick),
        ];
        const arm2 = [
          rot(-halfThick, -halfArm),
          rot(halfThick, -halfArm),
          rot(halfThick, halfArm),
          rot(-halfThick, halfArm),
        ];
        ctx.save();
        ctx.strokeStyle = c.color;
        ctx.fillStyle = c.color;
        ctx.globalAlpha = 0.18;
        tracePoly(ctx, arm1, true);
        ctx.fill();
        tracePoly(ctx, arm2, true);
        ctx.fill();
        ctx.globalAlpha = 0.8;
        ctx.lineWidth = 1.25;
        tracePoly(ctx, arm1, true);
        ctx.stroke();
        tracePoly(ctx, arm2, true);
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  // 4. Token range & fear/tinnitus circles
  for (const tk of tokens) {
    const p = tokenPosMap.get(tk.tid) ?? tk;
    const w = geo.relToWorld(p.x, p.y, 0);
    const circles = resolveTokenRangeCircles(tk, geo.effectiveWidthM);
    for (const c of circles) {
      const rW = geo.metersToWorld(c.radiusM);
      const innerW = c.innerRadiusM ? geo.metersToWorld(c.innerRadiusM) : 0;
      drawGroundAnnulus(
        ctx,
        renderer,
        w[0],
        0,
        w[2],
        innerW,
        rW,
        c.color,
        c.fill ? 0.14 : 0.05,
        c.color,
        0.85,
        true,
        1.6,
      );
      const labelPos = renderer.project([w[0], 0, w[2] - rW]);
      drawBadge(ctx, labelPos.x, labelPos.y, `${c.label} ${c.radiusM.toFixed(1)}m`, c.color, 10, c.color);
    }
  }
}

function drawShape(
  ctx: Canvas2DContextLike,
  renderer: TacticalReplayRenderer,
  geo: BoardGeoContext,
  shape: TacticalShape,
  selected: boolean,
): void {
  ctx.save();
  ctx.strokeStyle = shape.color;
  ctx.fillStyle = shape.color;
  ctx.lineWidth = selected ? shape.width + 2 : shape.width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (shape.kind === 'freehand' && shape.points && shape.points.length >= 2) {
    const pts = shape.points.map((pt) => renderer.project(geo.relToWorld(pt.x, pt.y, 0)));
    ctx.setLineDash([]);
    tracePoly(ctx, pts, false);
    ctx.stroke();
    ctx.restore();
    return;
  }

  const p1 = renderer.project(geo.relToWorld(shape.x1, shape.y1, 0));
  const p2 = renderer.project(geo.relToWorld(shape.x2, shape.y2, 0));

  if (shape.kind === 'line') {
    ctx.setLineDash(shape.dashed ? [6, 4] : []);
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();
  } else if (shape.kind === 'arrow') {
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const px = -uy;
    const py = ux;
    const headLen = Math.min(Math.max(10, shape.width * 4), len * 0.45);
    const headW = Math.max(5, shape.width * 2.2);
    const bx = p2.x - ux * headLen;
    const by = p2.y - uy * headLen;

    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(bx, by);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(p2.x, p2.y);
    ctx.lineTo(bx + px * headW, by + py * headW);
    ctx.lineTo(bx - px * headW, by - py * headW);
    ctx.closePath();
    ctx.fill();
  } else if (shape.kind === 'circle') {
    const cx = (shape.x1 + shape.x2) / 2;
    const cy = (shape.y1 + shape.y2) / 2;
    const rx = Math.abs(shape.x2 - shape.x1) / 2;
    const ry = Math.abs(shape.y2 - shape.y1) / 2;
    const pts: ScreenPoint[] = [];
    for (let i = 0; i < 48; i++) {
      const a = (Math.PI * 2 * i) / 48;
      pts.push(renderer.project(geo.relToWorld(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry, 0)));
    }
    ctx.setLineDash([Math.max(5, shape.width * 2.5), Math.max(4, shape.width * 1.8)]);
    tracePoly(ctx, pts, true);
    ctx.stroke();
  } else if (shape.kind === 'rect') {
    const corners = [
      renderer.project(geo.relToWorld(shape.x1, shape.y1, 0)),
      renderer.project(geo.relToWorld(shape.x2, shape.y1, 0)),
      renderer.project(geo.relToWorld(shape.x2, shape.y2, 0)),
      renderer.project(geo.relToWorld(shape.x1, shape.y2, 0)),
    ];
    ctx.setLineDash([Math.max(5, shape.width * 2.5), Math.max(4, shape.width * 1.8)]);
    tracePoly(ctx, corners, true);
    ctx.stroke();
  }

  ctx.restore();
}

function polylineMidpoint(pts: readonly ScreenPoint[]): { x: number; y: number } {
  if (pts.length === 0) return { x: 0, y: 0 };
  if (pts.length === 1) return { x: pts[0]!.x, y: pts[0]!.y };
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    total += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
  }
  const half = total / 2;
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    if (seg > 0 && acc + seg >= half) {
      const r = (half - acc) / seg;
      return { x: a.x + (b.x - a.x) * r, y: a.y + (b.y - a.y) * r };
    }
    acc += seg;
  }
  const last = pts[pts.length - 1]!;
  return { x: last.x, y: last.y };
}

function drawMeasurements(
  ctx: Canvas2DContextLike,
  renderer: TacticalReplayRenderer,
  params: OverlayRenderParams,
): void {
  const { geo, board, landmarks, selection, measurePending, measureHover, snapPoint, routePointA, routePointB } = params;
  const groups = groupMeasureLines(board.measures, geo);
  const selectedMeasureId = selection?.type === 'measure' ? selection.id : null;

  for (const g of groups) {
    const isChain = g.segs.length > 1 || g.id !== null;
    const chainSelected = g.segs.some((m) => m.id === selectedMeasureId);

    g.segs.forEach((m, segIdx) => {
      const p1 = renderer.project(geo.relToWorld(m.x1, m.y1, 0));
      const p2 = renderer.project(geo.relToWorld(m.x2, m.y2, 0));
      const isRouted = Boolean(m.path && m.path.length >= 2);
      const color = m.color ?? (isRouted ? '#20d6a0' : isChain ? '#f97316' : '#eab308');
      const w = m.width ?? (isRouted ? 2.6 : 2);
      const segSelected = m.id === selectedMeasureId || chainSelected;

      let mid: { x: number; y: number };
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      if (isRouted && m.path) {
        const poly = m.path.map((pt) => renderer.project(geo.relToWorld(pt.x, pt.y, 0)));
        // Subtle dark halo for crisp contrast over map walls/corridors
        ctx.strokeStyle = 'rgba(11, 10, 9, 0.72)';
        ctx.lineWidth = (segSelected ? w + 1.5 : w) + 2.2;
        ctx.setLineDash([]);
        tracePoly(ctx, poly, false);
        ctx.stroke();

        ctx.strokeStyle = color;
        ctx.lineWidth = segSelected ? w + 1.5 : w;
        ctx.setLineDash([]);
        tracePoly(ctx, poly, false);
        ctx.stroke();
        mid = polylineMidpoint(poly);
      } else {
        ctx.strokeStyle = color;
        ctx.lineWidth = segSelected ? w + 1.5 : w;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
        mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
      }
      ctx.restore();

      const simSeg = g.sim.segs[segIdx];
      if (simSeg) {
        const lbl = isChain
          ? `${simSeg.dist.toFixed(1)}m`
          : `${simSeg.dist.toFixed(1)}m · ${simSeg.t.toFixed(1)}s`;
        drawBadge(ctx, mid.x, mid.y - 10, lbl, color, 10, color);
      }

      if (!landmarks.hideEndpoints) {
        const drawEnd = (pt: ScreenPoint, letter: string) => {
          ctx.save();
          ctx.fillStyle = color;
          ctx.strokeStyle = '#0b0a09';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, 4.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          ctx.font = `700 12px ${CANVAS_FONT_CJK}`;
          ctx.fillStyle = '#ddd3bd';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'bottom';
          ctx.fillText(letter, pt.x, pt.y - 6);
          ctx.restore();
        };
        if (segIdx === 0) drawEnd(p1, letterLabel(0));
        drawEnd(p2, letterLabel(segIdx + 1));
      }
    });

    if (isChain && g.segs.length > 0) {
      const midSeg = g.segs[Math.floor(g.segs.length / 2)]!;
      const pa = renderer.project(geo.relToWorld(midSeg.x1, midSeg.y1, 0));
      const pb = renderer.project(geo.relToWorld(midSeg.x2, midSeg.y2, 0));
      const totalLbl = `总 ${g.sim.dist.toFixed(1)}m · ${g.sim.total.toFixed(1)}s`;
      drawBadge(ctx, (pa.x + pb.x) / 2, (pa.y + pb.y) / 2 + 12, totalLbl, '#f3d69a', 11, '#c9a25f');
    }
  }

  // 2-Point Route Planner A / B pins
  const drawRoutePin = (pt: Point2D | null | undefined, label: string, color: string) => {
    if (!pt) return;
    const sp = renderer.project(geo.relToWorld(pt.x, pt.y, 0));
    ctx.save();
    ctx.fillStyle = '#0b0a09';
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    drawBadge(ctx, sp.x, sp.y - 16, label, color, 10, color);
  };
  drawRoutePin(routePointA, '起点 A', '#20d6a0');
  drawRoutePin(routePointB, '终点 B', '#38bdf8');

  // Pending measurement preview
  if (measurePending) {
    const p1 = renderer.project(geo.relToWorld(measurePending.x, measurePending.y, 0));
    ctx.save();
    ctx.strokeStyle = '#eab308';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(p1.x, p1.y, 6, 0, Math.PI * 2);
    ctx.stroke();
    if (measureHover) {
      const p2 = renderer.project(geo.relToWorld(measureHover.x, measureHover.y, 0));
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
      const dM = geo.distMeters(measurePending, measureHover);
      drawBadge(ctx, (p1.x + p2.x) / 2, (p1.y + p2.y) / 2 - 12, `${dM.toFixed(1)}m`, '#eab308', 10, '#eab308');
    }
    ctx.restore();
  }

  // Landmark / endpoint snap ripple (double concentric brass ring)
  if (snapPoint) {
    const sp = renderer.project(geo.relToWorld(snapPoint.x, snapPoint.y, 0));
    ctx.save();
    ctx.strokeStyle = '#f3d69a';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, 9, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(201, 162, 95, 0.55)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, 15, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#f3d69a';
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

function drawAnimationPaths(
  ctx: Canvas2DContextLike,
  renderer: TacticalReplayRenderer,
  params: OverlayRenderParams,
): void {
  const { geo, board, landmarks, activeTool, selection } = params;
  const showAll = activeTool === 'anim';
  if (landmarks.hideAnimPath && landmarks.hideAnimDots) return;

  const drawObjAnim = (anim: BoardToken['anim'], isSelected: boolean) => {
    if (!anim || !anim.points?.length) return;
    if (!showAll && !isSelected) return;

    if (!landmarks.hideAnimPath && anim.points.length >= 2) {
      const pathPts: ScreenPoint[] = [];
      for (let i = 0; i + 1 < anim.points.length; i++) {
        const seg = animSegPath(anim, i);
        seg.forEach((pt, j) => {
          if (i > 0 && j === 0) return;
          pathPts.push(renderer.project(geo.relToWorld(pt.x, pt.y, 0)));
        });
      }
      ctx.save();
      ctx.strokeStyle = isSelected ? '#f472b6' : 'rgba(244, 114, 182, 0.55)';
      ctx.lineWidth = isSelected ? 2.5 : 1.8;
      ctx.setLineDash([7, 5]);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      tracePoly(ctx, pathPts, false);
      ctx.stroke();
      ctx.restore();
    }

    if (!landmarks.hideAnimDots && isSelected) {
      anim.points.forEach((pt, idx) => {
        const sp = renderer.project(geo.relToWorld(pt.x, pt.y, 0));
        ctx.save();
        ctx.fillStyle = '#0b0a09';
        ctx.strokeStyle = '#f472b6';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, 9, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.font = `700 12px ${CANVAS_FONT_CJK}`;
        ctx.fillStyle = '#fbcfe8';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(idx + 1), sp.x, sp.y);
        ctx.restore();
      });
    }
  };

  for (const tk of board.tokens) {
    drawObjAnim(tk.anim, selection?.type === 'token' && selection.tid === tk.tid);
  }
  for (const it of board.items) {
    drawObjAnim(it.anim, selection?.type === 'prop' && selection.iid === it.iid);
  }
}

function drawPropsAndTokens(
  ctx: Canvas2DContextLike,
  renderer: TacticalReplayRenderer,
  params: OverlayRenderParams,
): void {
  const { geo, board, landmarks, selection, animTime, hunterPortraits } = params;
  const items = board.items as BoardProp[];
  const tokens = board.tokens as BoardToken[];
  const globalGlow = Boolean(landmarks.selGlow);

  // Props
  for (const it of items) {
    const pos = resolveAnimatedPos(it, geo, animTime);
    const sp = renderer.project(geo.relToWorld(pos.x, pos.y, 0));
    const isSelected = selection?.type === 'prop' && selection.iid === it.iid;
    const def = TAC_ITEM_TYPES[it.kind];
    const color = propColor(it);
    const glyph = def?.glyph ?? '物';
    const r = it.hideIcon ? 4 : 11;

    ctx.save();
    if (isSelected || it.glow || globalGlow) {
      ctx.strokeStyle = isSelected ? '#fde047' : '#c9a25f';
      ctx.lineWidth = isSelected ? 2.6 : 2;
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, r + 4, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = '#14110e';
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    if (!it.hideIcon) {
      ctx.font = `700 12px ${CANVAS_FONT_CJK}`;
      ctx.fillStyle = color;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(glyph.slice(0, 2), sp.x, sp.y);
      drawBadge(ctx, sp.x, sp.y + r + 10, propDisplayName(it), '#ddd3bd', 9, color);
    }
    ctx.restore();
  }

  // Tokens (Hunter: crimson + gold double ring; Survivor: slate-blue ring)
  for (const tk of tokens) {
    const pos = resolveAnimatedPos(tk, geo, animTime);
    const sp = renderer.project(geo.relToWorld(pos.x, pos.y, 0));
    const isSelected = selection?.type === 'token' && selection.tid === tk.tid;
    const camp = tokenCamp(tk);
    const def = TAC_ROLES[tk.role];
    const color = tokenColor(tk);
    const r = tk.hideIcon ? 5 : camp === 'hunter' ? 15 : 13;

    ctx.save();
    if (isSelected || tk.glow || globalGlow) {
      ctx.strokeStyle = isSelected ? '#fde047' : '#c9a25f';
      ctx.lineWidth = isSelected ? 3 : 2.5;
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, r + 5, 0, Math.PI * 2);
      ctx.stroke();
    }

    if (camp === 'hunter') {
      ctx.fillStyle = '#1c0f12';
      ctx.strokeStyle = '#8e2f3c';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      ctx.strokeStyle = '#8e7a4a';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, r + 2.5, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      ctx.fillStyle = '#121720';
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    if (!tk.hideIcon) {
      const portraitUrl = def?.portraitUrl ?? null;
      const img = portraitUrl ? hunterPortraits.get(portraitUrl) : undefined;
      const canClip = typeof (ctx as unknown as { clip?: unknown }).clip === 'function';
      if (img && img.naturalWidth > 0 && canClip) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, r - 1.5, 0, Math.PI * 2);
        ctx.closePath();
        (ctx as unknown as { clip: () => void }).clip();
        ctx.drawImage(img, sp.x - (r - 1.5), sp.y - (r - 1.5), (r - 1.5) * 2, (r - 1.5) * 2);
        ctx.restore();
      } else {
        const glyph = def?.glyph ?? tokenDisplayName(tk).slice(0, 2);
        ctx.font = `700 ${camp === 'hunter' ? 11 : 10}px ${CANVAS_FONT_CJK}`;
        ctx.fillStyle = camp === 'hunter' ? '#f5d2d8' : '#dfe7f2';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(glyph, sp.x, sp.y);
      }
      drawBadge(
        ctx,
        sp.x,
        sp.y + r + 11,
        tokenDisplayName(tk),
        camp === 'hunter' ? '#f5d2d8' : '#dfe7f2',
        10,
        camp === 'hunter' ? '#8e2f3c' : '#6f8fb8',
      );
    }
    ctx.restore();
  }
}

function drawTextNotes(
  ctx: Canvas2DContextLike,
  renderer: TacticalReplayRenderer,
  params: OverlayRenderParams,
): void {
  const { geo, board, selection } = params;
  for (const note of board.texts) {
    const sp = renderer.project(geo.relToWorld(note.x, note.y, 0));
    const selected = selection?.type === 'text' && selection.id === note.id;
    drawBadge(
      ctx,
      sp.x,
      sp.y,
      note.text || '文字',
      note.color || '#ddd3bd',
      note.fontSize || 14,
      selected ? '#c9a25f' : 'rgba(92, 78, 58, 0.7)',
      'rgba(11, 10, 9, 0.88)',
    );
  }
}

export function renderTacticalOverlay(
  ctx: Canvas2DContextLike,
  viewport: ViewportSize,
  renderer: TacticalReplayRenderer,
  params: OverlayRenderParams,
): void {
  const dpr = viewport.dpr ?? 1;
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, viewport.width, viewport.height);

  drawLandmarks(ctx, renderer, params);
  drawRangeOverlay(ctx, renderer, params);
  drawTreasureOverlay(ctx, renderer, params);
  drawTokenAndPropRangesAndLinks(ctx, renderer, params);

  const selShapeId = params.selection?.type === 'shape' ? params.selection.id : null;
  for (const s of params.board.shapes) {
    drawShape(ctx, renderer, params.geo, s, s.id === selShapeId);
  }
  if (params.drawingPreview) {
    drawShape(ctx, renderer, params.geo, params.drawingPreview, false);
  }

  drawMeasurements(ctx, renderer, params);
  drawAnimationPaths(ctx, renderer, params);
  drawPropsAndTokens(ctx, renderer, params);
  drawTextNotes(ctx, renderer, params);

  ctx.restore();
}

export { effectiveAnimDuration };
