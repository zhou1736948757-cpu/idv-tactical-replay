/**
 * Pure TypeScript PIL-Style Third-Person 3D Roaming & Free-Fly Camera Controller.
 *
 * Manages camera mode (`overview` | `roaming`), avatar pose `(x, y, z, facingYaw)`,
 * over-shoulder camera orbit `(cameraYaw, cameraPitch, cameraDistance)`, Identity V
 * speed presets + custom speed (`1–40 m/s`), overview fly speed (`1–100 m/s`),
 * `Shift` sprint boost, keyboard WASD/Arrow + virtual D-pad input, collision overlay
 * toggle, live distance/timer/floor telemetry, and navmesh step/teleport integration.
 */
import type { FloorId } from '@idv/replay-renderer';
import {
  ROAM_SPEED_PRESETS,
  UNITS_PER_METER,
  findRoamSpeedPreset,
  type RoamSpeedPresetId,
} from './calibration3d';
import { classifyFloorBand, type NavMesh3D, type Vec3Point } from './nav3d';

export type CameraMode3D = 'overview' | 'roaming';
export type DpadDirection = 'forward' | 'backward' | 'left' | 'right';

export interface RoamingStepSummary {
  movedUnits: number;
  movedMeters: number;
  blocked: boolean;
  slid: boolean;
}

export interface RoamingStateSnapshot {
  cameraMode: CameraMode3D;
  avatarPos: Vec3Point;
  facingYaw: number;
  cameraYaw: number;
  cameraPitch: number;
  cameraDistance: number;
  speedPresetId: RoamSpeedPresetId | 'custom';
  speedMps: number;
  overviewFlySpeedMps: number;
  shiftHeld: boolean;
  sprintToggle: boolean;
  showCollision: boolean;
  teleportArmed: boolean;
  distanceM: number;
  elapsedS: number;
  floor: FloorId;
  statusMsg: string;
}

export const ROAM_SPEED_MIN_MPS = 1;
export const ROAM_SPEED_MAX_MPS = 40;
export const OVERVIEW_SPEED_MIN_MPS = 1;
export const OVERVIEW_SPEED_MAX_MPS = 100;
export const SPRINT_BOOST_MULTIPLIER = 3.0;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function wrapAngleRad(rad: number): number {
  const twoPi = Math.PI * 2;
  const w = ((rad % twoPi) + twoPi) % twoPi;
  return w > Math.PI ? w - twoPi : w;
}

export class RoamingController {
  cameraMode: CameraMode3D = 'overview';
  avatarPos: Vec3Point = { x: 0, y: 0, z: 0 };
  /** World-space horizontal yaw where `0` faces `(0, 0, -1)` and `+PI/2` faces `(+1, 0, 0)`. */
  facingYaw = 0;
  cameraYaw = 0;
  cameraPitch = 0.42;
  cameraDistance = 78;

  speedPresetId: RoamSpeedPresetId | 'custom' = 'survivor';
  speedMps = 3.8;
  overviewFlySpeedMps = 26;
  shiftHeld = false;
  sprintToggle = false;

  showCollision = false;
  teleportArmed = false;

  distanceM = 0;
  elapsedS = 0;
  floor: FloorId = '1F';
  statusMsg = '俯瞰自由视角 · 双击地面或点击「模拟跑图」进入第三人称';

  private readonly keys = {
    forward: false,
    backward: false,
    left: false,
    right: false,
    up: false,
    down: false,
  };

  private readonly dpad = {
    forward: false,
    backward: false,
    left: false,
    right: false,
  };

  private readonly analog = {
    forward: 0,
    strafe: 0,
  };

  constructor(initial?: Partial<Pick<RoamingController, 'speedPresetId' | 'cameraMode'>>) {
    if (initial?.speedPresetId && initial.speedPresetId !== 'custom') {
      this.setSpeedPreset(initial.speedPresetId);
    }
    if (initial?.cameraMode) {
      this.cameraMode = initial.cameraMode;
    }
  }

  setCameraMode(mode: CameraMode3D, nav?: NavMesh3D | null): boolean {
    if (mode === 'roaming' && nav && nav.triangleCount > 0) {
      const snapped = nav.findNearestWalkable(
        this.avatarPos.x,
        this.avatarPos.z,
        this.avatarPos.y,
        420,
      );
      if (snapped) {
        this.avatarPos = { x: snapped.x, y: snapped.y, z: snapped.z };
        this.floor = snapped.floor;
      }
    }
    this.cameraMode = mode;
    if (mode === 'overview') {
      this.teleportArmed = false;
      this.clearDpad();
      this.clearAnalogStick();
      this.statusMsg = '俯瞰自由视角 · 拖动旋转，滚轮缩放，WASD 平移';
    } else {
      const preset = this.speedPresetId !== 'custom' ? findRoamSpeedPreset(this.speedPresetId) : null;
      this.statusMsg = `${preset ? preset.shortLabel : '自定义'} · ${this.speedMps.toFixed(2)} m/s 漫游就绪`;
    }
    return true;
  }

  setSpeedPreset(presetId: RoamSpeedPresetId): void {
    const preset = findRoamSpeedPreset(presetId) ?? ROAM_SPEED_PRESETS[1];
    this.speedPresetId = preset.id;
    this.speedMps = preset.speedMps;
    this.statusMsg = `移速档位：${preset.label}`;
  }

  setCustomSpeed(speedMps: number): void {
    if (!Number.isFinite(speedMps)) return;
    const clamped = clamp(speedMps, ROAM_SPEED_MIN_MPS, ROAM_SPEED_MAX_MPS);
    this.speedMps = Math.round(clamped * 100) / 100;
    const matched = ROAM_SPEED_PRESETS.find((p) => Math.abs(p.speedMps - this.speedMps) < 0.005);
    this.speedPresetId = matched ? matched.id : 'custom';
    this.statusMsg = matched
      ? `移速档位：${matched.label}`
      : `自定义移速 · ${this.speedMps.toFixed(2)} m/s`;
  }

  setOverviewFlySpeed(speedMps: number): void {
    if (!Number.isFinite(speedMps)) return;
    this.overviewFlySpeedMps = clamp(speedMps, OVERVIEW_SPEED_MIN_MPS, OVERVIEW_SPEED_MAX_MPS);
  }

  setKey(keyOrCode: string, pressed: boolean): boolean {
    const k = keyOrCode.toLowerCase();
    if (k === 'shift' || k === 'shiftleft' || k === 'shiftright') {
      this.shiftHeld = pressed;
      return true;
    }
    if (k === 'w' || k === 'keyw' || k === 'arrowup') {
      this.keys.forward = pressed;
      return true;
    }
    if (k === 's' || k === 'keys' || k === 'arrowdown') {
      this.keys.backward = pressed;
      return true;
    }
    if (k === 'a' || k === 'keya' || k === 'arrowleft') {
      this.keys.left = pressed;
      return true;
    }
    if (k === 'd' || k === 'keyd' || k === 'arrowright') {
      this.keys.right = pressed;
      return true;
    }
    if (k === 'e' || k === 'keye') {
      this.keys.up = pressed;
      return true;
    }
    if (k === 'q' || k === 'keyq') {
      this.keys.down = pressed;
      return true;
    }
    return false;
  }

  setDpad(dir: DpadDirection, pressed: boolean): void {
    this.dpad[dir] = pressed;
  }

  clearDpad(): void {
    this.dpad.forward = false;
    this.dpad.backward = false;
    this.dpad.left = false;
    this.dpad.right = false;
  }

  /**
   * Sets continuous 360° analog thumbstick input `(forward, strafe)` in `[-1, 1]`.
   * Values outside the unit circle are radially clamped while preserving direction.
   */
  setAnalogStick(forward: number, strafe: number): void {
    const fwd = Number.isFinite(forward) ? forward : 0;
    const str = Number.isFinite(strafe) ? strafe : 0;
    const mag = Math.hypot(str, fwd);
    if (mag <= 1e-6) {
      this.analog.forward = 0;
      this.analog.strafe = 0;
      return;
    }
    const scale = mag > 1 ? 1 / mag : 1;
    this.analog.forward = fwd * scale;
    this.analog.strafe = str * scale;
  }

  clearAnalogStick(): void {
    this.analog.forward = 0;
    this.analog.strafe = 0;
  }

  toggleSprint(force?: boolean): boolean {
    this.sprintToggle = typeof force === 'boolean' ? force : !this.sprintToggle;
    this.statusMsg = this.sprintToggle ? '已开启 ×3 疾跑倍速' : '已关闭 ×3 疾跑倍速';
    return this.sprintToggle;
  }

  clearKeys(): void {
    this.keys.forward = false;
    this.keys.backward = false;
    this.keys.left = false;
    this.keys.right = false;
    this.keys.up = false;
    this.keys.down = false;
    this.shiftHeld = false;
    this.clearDpad();
    this.clearAnalogStick();
  }

  orbitCamera(deltaYawRad: number, deltaPitchRad: number): void {
    this.cameraYaw = wrapAngleRad(this.cameraYaw + deltaYawRad);
    this.cameraPitch = clamp(this.cameraPitch + deltaPitchRad, 0.08, 1.36);
  }

  zoomCamera(deltaUnits: number): void {
    this.cameraDistance = clamp(this.cameraDistance + deltaUnits, 26, 260);
  }

  /**
   * Returns normalized horizontal input `(strafe, forward)` in `[-1, 1]` plus vertical `elev` in `[-1, 1]`.
   */
  getInputVector(): { strafe: number; forward: number; elev: number; active: boolean } {
    const keyFwd =
      (this.keys.forward || this.dpad.forward ? 1 : 0) -
      (this.keys.backward || this.dpad.backward ? 1 : 0);
    const keyStrafe =
      (this.keys.right || this.dpad.right ? 1 : 0) -
      (this.keys.left || this.dpad.left ? 1 : 0);
    const fwdRaw = keyFwd + this.analog.forward;
    const strafeRaw = keyStrafe + this.analog.strafe;
    const elev = (this.keys.up ? 1 : 0) - (this.keys.down ? 1 : 0);

    const len = Math.hypot(strafeRaw, fwdRaw);
    if (len <= 1e-6) {
      return { strafe: 0, forward: 0, elev, active: elev !== 0 };
    }
    const scale = len > 1 ? 1 / len : 1;
    return {
      strafe: strafeRaw * scale,
      forward: fwdRaw * scale,
      elev,
      active: true,
    };
  }

  effectiveSpeedMps(): number {
    const base = this.cameraMode === 'roaming' ? this.speedMps : this.overviewFlySpeedMps;
    return this.shiftHeld || this.sprintToggle ? base * SPRINT_BOOST_MULTIPLIER : base;
  }

  resetTelemetry(): void {
    this.distanceM = 0;
    this.elapsedS = 0;
    this.statusMsg = '测距与计时已归零';
  }

  teleportTo(x: number, z: number, refY?: number, nav?: NavMesh3D | null): boolean {
    if (nav && nav.triangleCount > 0) {
      const snapped = nav.findNearestWalkable(x, z, refY, 320);
      if (!snapped) {
        this.statusMsg = '所选位置附近无可行走地面';
        return false;
      }
      this.avatarPos = { x: snapped.x, y: snapped.y, z: snapped.z };
      this.floor = snapped.floor;
      this.statusMsg =
        snapped.distanceXZ > 2
          ? '已将漫游人物放到同层附近可行走位置'
          : `已传送至 ${snapped.floor} 通行面`;
      return true;
    }

    const nextY = refY ?? this.avatarPos.y;
    this.avatarPos = { x, y: nextY, z };
    this.floor = classifyFloorBand(nextY, 0);
    this.statusMsg = `已传送至 (${x.toFixed(0)}, ${z.toFixed(0)})`;
    return true;
  }

  /**
   * Advances the roaming avatar for `dtSeconds` using `cameraYaw` + active speed + `nav`.
   */
  step(dtSeconds: number, nav?: NavMesh3D | null): RoamingStepSummary {
    if (!(dtSeconds > 0) || !Number.isFinite(dtSeconds) || this.cameraMode !== 'roaming') {
      return { movedUnits: 0, movedMeters: 0, blocked: false, slid: false };
    }

    const dt = dtSeconds;
    const input = this.getInputVector();
    const horzMag = Math.hypot(input.strafe, input.forward);
    if (horzMag <= 1e-6) {
      return { movedUnits: 0, movedMeters: 0, blocked: false, slid: false };
    }

    // Forward at cameraYaw = 0 is (0, 0, -1); right is (+1, 0, 0)
    const sinY = Math.sin(this.cameraYaw);
    const cosY = Math.cos(this.cameraYaw);
    const fwdX = sinY;
    const fwdZ = -cosY;
    const rightX = cosY;
    const rightZ = sinY;

    const dirX = fwdX * input.forward + rightX * input.strafe;
    const dirZ = fwdZ * input.forward + rightZ * input.strafe;
    const dirLen = Math.hypot(dirX, dirZ) || 1;
    const ux = dirX / dirLen;
    const uz = dirZ / dirLen;

    const stepUnits = this.effectiveSpeedMps() * UNITS_PER_METER * dt * Math.min(1, horzMag);
    const dx = ux * stepUnits;
    const dz = uz * stepUnits;

    this.facingYaw = Math.atan2(ux, -uz);

    if (nav && nav.triangleCount > 0) {
      const res = nav.resolveHorizontalStep(this.avatarPos, dx, dz);
      this.avatarPos = { x: res.x, y: res.y, z: res.z };
      this.floor = res.floor;
      const movedMeters = res.movedXZ / UNITS_PER_METER;
      this.distanceM += movedMeters;
      this.elapsedS += dt;
      if (res.slid) {
        this.statusMsg = '正在沿接触面切线滑动';
      } else if (res.blocked && res.movedXZ < 1e-3) {
        this.statusMsg = '前方通行边界阻挡';
      } else {
        this.statusMsg = `${this.floor} · ${this.effectiveSpeedMps().toFixed(2)} m/s 漫游中`;
      }
      return {
        movedUnits: res.movedXZ,
        movedMeters,
        blocked: res.blocked,
        slid: res.slid,
      };
    }

    // Unconstrained flat-plane fallback (e.g. pure unit test without navmesh)
    this.avatarPos = {
      x: this.avatarPos.x + dx,
      y: this.avatarPos.y,
      z: this.avatarPos.z + dz,
    };
    const movedUnits = Math.hypot(dx, dz);
    const movedMeters = movedUnits / UNITS_PER_METER;
    this.distanceM += movedMeters;
    this.elapsedS += dt;
    this.floor = classifyFloorBand(this.avatarPos.y, 0);
    return {
      movedUnits,
      movedMeters,
      blocked: false,
      slid: false,
    };
  }

  /** Computes the third-person over-shoulder camera eye & look-at points in 3D world units. */
  computeThirdPersonCamera(avatarEyeHeight = 15): {
    eye: Vec3Point;
    target: Vec3Point;
  } {
    const target: Vec3Point = {
      x: this.avatarPos.x,
      y: this.avatarPos.y + avatarEyeHeight,
      z: this.avatarPos.z,
    };
    const horizDist = this.cameraDistance * Math.cos(this.cameraPitch);
    const vertDist = this.cameraDistance * Math.sin(this.cameraPitch);
    const sinY = Math.sin(this.cameraYaw);
    const cosY = Math.cos(this.cameraYaw);
    return {
      eye: {
        x: target.x - sinY * horizDist,
        y: target.y + vertDist,
        z: target.z + cosY * horizDist,
      },
      target,
    };
  }

  snapshot(): RoamingStateSnapshot {
    return {
      cameraMode: this.cameraMode,
      avatarPos: { ...this.avatarPos },
      facingYaw: this.facingYaw,
      cameraYaw: this.cameraYaw,
      cameraPitch: this.cameraPitch,
      cameraDistance: this.cameraDistance,
      speedPresetId: this.speedPresetId,
      speedMps: this.speedMps,
      overviewFlySpeedMps: this.overviewFlySpeedMps,
      shiftHeld: this.shiftHeld,
      sprintToggle: this.sprintToggle,
      showCollision: this.showCollision,
      teleportArmed: this.teleportArmed,
      distanceM: this.distanceM,
      elapsedS: this.elapsedS,
      floor: this.floor,
      statusMsg: this.statusMsg,
    };
  }
}
