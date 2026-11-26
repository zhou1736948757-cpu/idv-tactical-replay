/**
 * Orthographic 2D top-down <-> 2.5D oblique projection (Workflow/PLAN.md D2).
 *
 *   dx = x - centerX, dz = z - centerZ
 *   rx = dx*cos(yaw) - dz*sin(yaw)
 *   rz = dx*sin(yaw) + dz*cos(yaw)
 *   sx = W/2 + rx*zoom
 *   sy = H/2 + rz*zoom*sin(pitch) - y*yScale*zoom*cos(pitch)
 *   depth = rz*cos(pitch) + y*yScale*sin(pitch)
 *
 * At pitch = 90 this degenerates exactly into 2D top-down.
 */
import type {
  CameraState,
  ScreenPoint,
  UnderlayTransformOptions,
  Vec3,
  ViewportSize,
  WorldRect,
} from './types.js';

export const PITCH_MIN_DEG = 35;
export const PITCH_MAX_DEG = 90;
export const YSCALE_MIN = 1.0;
export const YSCALE_MAX = 3.0;
export const ZOOM_MIN = 1e-6;
/** 2.5D-only overlays (floor planes, drop lines) are shown below this pitch. */
export const OBLIQUE_PITCH_THRESHOLD_DEG = 89;

const DEG = Math.PI / 180;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function wrapDeg360(deg: number): number {
  if (!Number.isFinite(deg)) return 0;
  const w = deg % 360;
  const r = w < 0 ? w + 360 : w;
  return r >= 360 ? 0 : r;
}

/** Returns a sanitized copy obeying all camera constraints. */
export function normalizeCamera(camera: CameraState): CameraState {
  return {
    centerX: Number.isFinite(camera.centerX) ? camera.centerX : 0,
    centerZ: Number.isFinite(camera.centerZ) ? camera.centerZ : 0,
    zoom: Number.isFinite(camera.zoom) && camera.zoom > ZOOM_MIN ? camera.zoom : ZOOM_MIN,
    yawDeg: wrapDeg360(camera.yawDeg),
    pitchDeg: clamp(Number.isFinite(camera.pitchDeg) ? camera.pitchDeg : PITCH_MAX_DEG, PITCH_MIN_DEG, PITCH_MAX_DEG),
    yScale: clamp(Number.isFinite(camera.yScale) ? camera.yScale : YSCALE_MIN, YSCALE_MIN, YSCALE_MAX),
  };
}

export function createDefaultCamera(overrides: Partial<CameraState> = {}): CameraState {
  return normalizeCamera({
    centerX: 0,
    centerZ: 0,
    zoom: 1,
    yawDeg: 0,
    pitchDeg: 90,
    yScale: 1,
    ...overrides,
  });
}

export function isObliqueCamera(camera: CameraState): boolean {
  return normalizeCamera(camera).pitchDeg < OBLIQUE_PITCH_THRESHOLD_DEG;
}

interface Trig {
  cy: number;
  sy: number;
  cp: number;
  sp: number;
  cam: CameraState;
}

function trig(camera: CameraState): Trig {
  const cam = normalizeCamera(camera);
  const yaw = cam.yawDeg * DEG;
  const pitch = cam.pitchDeg * DEG;
  // Snap exact 2D (pitch 90) so cos is exactly 0 and sin exactly 1.
  const cp = cam.pitchDeg === 90 ? 0 : Math.cos(pitch);
  const sp = cam.pitchDeg === 90 ? 1 : Math.sin(pitch);
  return { cy: Math.cos(yaw), sy: Math.sin(yaw), cp, sp, cam };
}

/** Projects world [x, y, z] to CSS-pixel screen coordinates + painter depth. */
export function projectWorldToScreen(world: Vec3 | readonly number[], camera: CameraState, viewport: ViewportSize): ScreenPoint {
  const { cy, sy, cp, sp, cam } = trig(camera);
  const x = world[0] ?? 0;
  const y = world[1] ?? 0;
  const z = world[2] ?? 0;
  const dx = x - cam.centerX;
  const dz = z - cam.centerZ;
  const rx = dx * cy - dz * sy;
  const rz = dx * sy + dz * cy;
  const yy = y * cam.yScale;
  return {
    x: viewport.width / 2 + rx * cam.zoom,
    y: viewport.height / 2 + rz * cam.zoom * sp - yy * cam.zoom * cp,
    depth: rz * cp + yy * sp,
  };
}

/** Exact inverse of projectWorldToScreen restricted to the horizontal plane Y = yPlane. */
export function screenToWorldOnPlane(
  sx: number,
  sy: number,
  yPlane: number,
  camera: CameraState,
  viewport: ViewportSize,
): Vec3 {
  const { cy, sy: syaw, cp, sp, cam } = trig(camera);
  const rx = (sx - viewport.width / 2) / cam.zoom;
  // sp >= sin(35deg) > 0, never singular.
  const rz = (sy - viewport.height / 2 + yPlane * cam.yScale * cam.zoom * cp) / (cam.zoom * sp);
  const dx = rx * cy + rz * syaw;
  const dz = -rx * syaw + rz * cy;
  return [cam.centerX + dx, yPlane, cam.centerZ + dz];
}

export type AffineMatrix = [number, number, number, number, number, number];

/**
 * Image-space corner that each world corner maps to after the optional
 * calibration (rotation quadrants clockwise in image space, then flips).
 * Returns the world (x, z) for normalized image coords (u, v) in [0,1].
 */
function imageUvToWorld(u: number, v: number, rect: WorldRect, opts: UnderlayTransformOptions): [number, number] {
  const q = ((opts.rotationQuadrants ?? 0) % 4 + 4) % 4;
  // Rotate image coordinates by q * 90deg (clockwise in image space).
  let a = u;
  let b = v;
  for (let i = 0; i < q; i++) {
    const na = 1 - b;
    const nb = a;
    a = na;
    b = nb;
  }
  if (opts.flipX) a = 1 - a;
  if (opts.flipZ) b = 1 - b;
  return [rect.min_x + a * (rect.max_x - rect.min_x), rect.min_z + b * (rect.max_z - rect.min_z)];
}

/**
 * Computes [a, b, c, d, e, f] for ctx.transform(...) so that
 * ctx.drawImage(img, 0, 0, imgW, imgH) lands on the Y = 0 ground plane.
 * With default options image (0,0)->(min_x,0,min_z), (W,0)->(max_x,0,min_z), (0,H)->(min_x,0,max_z).
 */
export function computeUnderlayAffine(
  worldRect: WorldRect,
  imgWidth: number,
  imgHeight: number,
  camera: CameraState,
  viewport: ViewportSize,
  transformOpts: UnderlayTransformOptions = {},
): AffineMatrix {
  const w = imgWidth > 0 ? imgWidth : 1;
  const h = imgHeight > 0 ? imgHeight : 1;
  const [x00, z00] = imageUvToWorld(0, 0, worldRect, transformOpts);
  const [x10, z10] = imageUvToWorld(1, 0, worldRect, transformOpts);
  const [x01, z01] = imageUvToWorld(0, 1, worldRect, transformOpts);
  const p00 = projectWorldToScreen([x00, 0, z00], camera, viewport);
  const p10 = projectWorldToScreen([x10, 0, z10], camera, viewport);
  const p01 = projectWorldToScreen([x01, 0, z01], camera, viewport);
  return [
    (p10.x - p00.x) / w,
    (p10.y - p00.y) / w,
    (p01.x - p00.x) / h,
    (p01.y - p00.y) / h,
    p00.x,
    p00.y,
  ];
}

export interface FitBounds {
  min_x: number;
  max_x: number;
  min_z: number;
  max_z: number;
}

/**
 * Computes centerX / centerZ / zoom so the XZ bounds fit the viewport in 2D
 * top-down (yaw 0, pitch 90). Returns a full CameraState (yaw/pitch/yScale defaults).
 */
export function fitCameraToBounds(bounds: FitBounds, viewport: ViewportSize, paddingRatio = 0.08): CameraState {
  const spanX = Math.max(1e-6, Math.abs(bounds.max_x - bounds.min_x));
  const spanZ = Math.max(1e-6, Math.abs(bounds.max_z - bounds.min_z));
  const pad = clamp(paddingRatio, 0, 0.45);
  const availW = Math.max(1, viewport.width * (1 - 2 * pad));
  const availH = Math.max(1, viewport.height * (1 - 2 * pad));
  const zoom = Math.min(availW / spanX, availH / spanZ);
  return createDefaultCamera({
    centerX: (bounds.min_x + bounds.max_x) / 2,
    centerZ: (bounds.min_z + bounds.max_z) / 2,
    zoom,
  });
}
