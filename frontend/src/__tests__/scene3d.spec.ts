import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import * as THREE from 'three';
import type { PilMapId } from '@/tactical/types';
import {
  MAP_3D_CALIBRATION,
  NavMesh3D,
  ROAM_SPEED_PRESETS,
  RoamingController,
  SPRINT_BOOST_MULTIPLIER,
  UNITS_PER_METER,
  buildNavMeshFromGlbBinary,
  buildNavMeshFromObject3D,
  classifyFloorBand,
  hasNightVariant,
  normalizedToWorld3D,
  replayWorldTo3D,
  resolveScene3DId,
  world3DToNormalized,
} from '@/tactical/scene3d';
import Tactical3DCanvas from '@/components/tactical/Tactical3DCanvas.vue';
import TacticalBoardCanvas from '@/components/TacticalBoardCanvas.vue';
import { installCanvasStub } from './canvas-stub';
import { makeReplay } from './fixtures';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAPS_3D_DIR = path.resolve(__dirname, '../../public/assets/maps-3d');

describe('scene3d / calibration3d', () => {
  const ALL_MAP_IDS: readonly PilMapId[] = [0, 1, 2, 3, 4, 5, 6, 7, 8];

  it('round-trips normalizedToWorld3D <-> world3DToNormalized across all 9 maps (< 1e-6 error)', () => {
    const sampleUVs: Array<[number, number]> = [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
      [0.5, 0.5],
      [0.23, 0.77],
      [0.81, 0.19],
    ];

    for (const mapId of ALL_MAP_IDS) {
      const cal = MAP_3D_CALIBRATION[mapId];
      const [p0, p1, p2, p3, p4, p5] = cal.worldToPixel;
      const [wPx, hPx] = cal.size;

      for (const [u, v] of sampleUVs) {
        const world = normalizedToWorld3D(mapId, u, v);
        const back = world3DToNormalized(mapId, world.x, world.z);
        expect(Math.abs(back.u - u)).toBeLessThan(1e-6);
        expect(Math.abs(back.v - v)).toBeLessThan(1e-6);

        // Verify exact agreement with board-calibration.json's worldToPixel matrix
        const px = p0 * world.x + p2 * world.z + p4;
        const py = p1 * world.x + p3 * world.z + p5;
        expect(Math.abs(px - u * wPx)).toBeLessThan(1e-6);
        expect(Math.abs(py - v * hPx)).toBeLessThan(1e-6);
      }
    }
  });

  it('normalizes replay world coordinates via worldRect and preserves vertical ry offset', () => {
    const rect = { min_x: -100, max_x: 300, min_z: -50, max_z: 150 };
    const mid = replayWorldTo3D(2, 100, -33.5, 50, rect);
    const expectedXZ = normalizedToWorld3D(2, 0.5, 0.5);
    expect(mid.x).toBeCloseTo(expectedXZ.x, 8);
    expect(mid.z).toBeCloseTo(expectedXZ.z, 8);
    expect(mid.y).toBeCloseTo(-33.5, 8);
  });

  it('exposes all 8 canonical Identity V ROAM_SPEED_PRESETS and h55_demo2 night variant', () => {
    expect(UNITS_PER_METER).toBeCloseTo(45 / 3.8, 10);
    expect(ROAM_SPEED_PRESETS).toHaveLength(8);
    expect(ROAM_SPEED_PRESETS.map((p) => [p.id, p.speedMps])).toEqual([
      ['wildling', 3.65],
      ['survivor', 3.8],
      ['hunter1', 4.56],
      ['hunter2', 4.64],
      ['hunter3', 4.73],
      ['hullabaloo', 5.1],
      ['witch', 6.08],
      ['yithian', 7.59],
    ]);

    expect(hasNightVariant(2)).toBe(true);
    expect(hasNightVariant(0)).toBe(false);
    expect(resolveScene3DId(2, false)).toBe('h55_demo');
    expect(resolveScene3DId(2, true)).toBe('h55_demo2');
    expect(resolveScene3DId(7, true)).toBe('h55_chinatown');
  });
});

describe('scene3d / nav3d', () => {
  it('parses real ordnance_factory1.nav.glb, snaps walkable spawns, and stays inside floor bounds', () => {
    const navPath = path.join(MAPS_3D_DIR, 'ordnance_factory1.nav.glb');
    const raw = fs.readFileSync(navPath);
    const nav = buildNavMeshFromGlbBinary(raw);

    expect(nav.triangleCount).toBeGreaterThan(3000);

    // Calibrated map center on Arms Factory must snap cleanly onto 1F walkable ground
    const center = normalizedToWorld3D(0, 0.5, 0.5);
    const walkable = nav.findNearestWalkable(center.x, center.z);
    expect(walkable).not.toBeNull();
    expect(walkable!.floor).toBe('1F');
    expect(walkable!.normal[1]).toBeGreaterThan(0.25);

    const floorHit = nav.sampleFloor(walkable!.x, walkable!.z, walkable!.y);
    expect(floorHit).not.toBeNull();
    expect(floorHit!.y).toBeCloseTo(walkable!.y, 3);

    // Advancing across real navmesh stays strictly on valid walkable floor and never falls into void
    let pos = { x: walkable!.x, y: walkable!.y, z: walkable!.z };
    for (let i = 0; i < 40; i++) {
      const step = nav.resolveHorizontalStep(pos, 18, -12);
      pos = { x: step.x, y: step.y, z: step.z };
      const check = nav.sampleFloor(pos.x, pos.z, pos.y, 40, 80);
      expect(check).not.toBeNull();
    }

    // Marching past the outer map boundary must block/slide cleanly without leaving navmesh
    let edgePos = { x: nav.bounds.minX + 40, y: nav.medianFloorY, z: center.z };
    const edgeStart = nav.findNearestWalkable(edgePos.x, edgePos.z, nav.medianFloorY, 400);
    expect(edgeStart).not.toBeNull();
    edgePos = { x: edgeStart!.x, y: edgeStart!.y, z: edgeStart!.z };

    let sawBlock = false;
    for (let i = 0; i < 60; i++) {
      const res = nav.resolveHorizontalStep(edgePos, -30, 0);
      edgePos = { x: res.x, y: res.y, z: res.z };
      if (res.blocked) sawBlock = true;
      expect(nav.sampleFloor(edgePos.x, edgePos.z, edgePos.y, 45, 90)).not.toBeNull();
    }
    expect(sawBlock).toBe(true);
  });

  it('slides smoothly along axis-aligned and diagonal walls and classifies multi-story floors', () => {
    // Build a 100x100 walkable square [0..100] x [0..100] at y=0 via Three.js Group to test Object3D builder too
    const geom = new THREE.PlaneGeometry(100, 100, 2, 2);
    geom.rotateX(-Math.PI / 2);
    geom.translate(50, 0, 50);
    const mesh = new THREE.Mesh(geom);
    const group = new THREE.Group();
    group.add(mesh);

    const nav = buildNavMeshFromObject3D(group, 32);
    expect(nav.triangleCount).toBe(8);

    // Interior step advances exact full displacement
    const interior = nav.resolveHorizontalStep({ x: 50, y: 0, z: 50 }, 6, 8);
    expect(interior.blocked).toBe(false);
    expect(interior.slid).toBe(false);
    expect(interior.movedXZ).toBeCloseTo(10, 5);

    // Diagonal step against north wall (z = 0) slides smoothly eastward (+X) instead of sticking
    const wallSlide = nav.resolveHorizontalStep({ x: 50, y: 0, z: 0.2 }, 6, -6);
    expect(wallSlide.blocked).toBe(true);
    expect(wallSlide.slid).toBe(true);
    expect(wallSlide.x).toBeCloseTo(56, 3);
    expect(wallSlide.z).toBeGreaterThanOrEqual(0);

    // Multi-story floor band classification
    expect(classifyFloorBand(-85, 0)).toBe('B1');
    expect(classifyFloorBand(0, 0)).toBe('1F');
    expect(classifyFloorBand(58, 0)).toBe('2F');

    // Multi-story sampleFloor disambiguates B1 vs 1F vs 2F using refY
    const tris = new Float32Array([
      // B1 at y = -80
      0, -80, 0, 40, -80, 0, 0, -80, 40,
      // 1F at y = 0
      0, 0, 0, 40, 0, 0, 0, 0, 40,
      // 2F at y = 60
      0, 60, 0, 40, 60, 0, 0, 60, 40,
    ]);
    const multiNav = new NavMesh3D(tris, 32);
    expect(multiNav.sampleFloor(10, 10, -78)?.floor).toBe('B1');
    expect(multiNav.sampleFloor(10, 10, 2)?.floor).toBe('1F');
    expect(multiNav.sampleFloor(10, 10, 58)?.floor).toBe('2F');
  });
});

describe('scene3d / roaming3d', () => {
  it('advances WASD forward at exact speedMps * UNITS_PER_METER * dt, switches presets, and resets telemetry', () => {
    const geom = new THREE.PlaneGeometry(2000, 2000, 4, 4);
    geom.rotateX(-Math.PI / 2);
    const nav = buildNavMeshFromObject3D(new THREE.Mesh(geom), 64);

    const ctrl = new RoamingController({ cameraMode: 'roaming', speedPresetId: 'survivor' });
    expect(ctrl.speedMps).toBeCloseTo(3.8, 6);

    ctrl.setKey('KeyW', true);
    const dt = 0.5;
    const step1 = ctrl.step(dt, nav);
    const expectedUnits = 3.8 * UNITS_PER_METER * dt;

    expect(step1.movedUnits).toBeCloseTo(expectedUnits, 5);
    expect(ctrl.avatarPos.z).toBeCloseTo(-expectedUnits, 5);
    expect(ctrl.distanceM).toBeCloseTo(3.8 * dt, 5);
    expect(ctrl.elapsedS).toBeCloseTo(dt, 6);

    // Switch preset to Dream Witch main body (6.08 m/s) + Shift boost
    ctrl.setSpeedPreset('witch');
    expect(ctrl.speedMps).toBeCloseTo(6.08, 6);
    ctrl.setKey('ShiftLeft', true);
    const step2 = ctrl.step(0.25, nav);
    expect(step2.movedMeters).toBeCloseTo(6.08 * SPRINT_BOOST_MULTIPLIER * 0.25, 4);
    expect(ctrl.elapsedS).toBeCloseTo(0.75, 6);

    // Reset telemetry cleanly zeroes distanceM and elapsedS while keeping position
    const keptZ = ctrl.avatarPos.z;
    ctrl.resetTelemetry();
    expect(ctrl.distanceM).toBe(0);
    expect(ctrl.elapsedS).toBe(0);
    expect(ctrl.avatarPos.z).toBeCloseTo(keptZ, 5);
  });

  it('supports continuous 360° setAnalogStick movement, proportional tilt speed, radial clamping, and toggleSprint()', () => {
    const geom = new THREE.PlaneGeometry(4000, 4000, 4, 4);
    geom.rotateX(-Math.PI / 2);
    const nav = buildNavMeshFromObject3D(new THREE.Mesh(geom), 64);

    const ctrl = new RoamingController({ cameraMode: 'roaming', speedPresetId: 'survivor' });

    // 1. Arbitrary 360° angle (e.g. 53.13° right-forward: forward = 0.6, strafe = 0.8)
    ctrl.setAnalogStick(0.6, 0.8);
    const stepFull = ctrl.step(1.0, nav);
    const baseUnitsPerSec = 3.8 * UNITS_PER_METER;
    expect(stepFull.movedMeters).toBeCloseTo(3.8, 5);
    expect(ctrl.avatarPos.x).toBeCloseTo(0.8 * baseUnitsPerSec, 4);
    expect(ctrl.avatarPos.z).toBeCloseTo(-0.6 * baseUnitsPerSec, 4);
    expect(ctrl.facingYaw).toBeCloseTo(Math.atan2(0.8, 0.6), 5);

    // 2. Half-tilt analog input (magnitude = 0.5 at 225° backward-left) scales speed by 0.5x
    ctrl.teleportTo(0, 0, 0, nav);
    const diagHalf = -0.5 * Math.SQRT1_2;
    ctrl.setAnalogStick(diagHalf, diagHalf);
    const stepHalf = ctrl.step(1.0, nav);
    expect(stepHalf.movedMeters).toBeCloseTo(3.8 * 0.5, 5);
    expect(ctrl.avatarPos.x).toBeCloseTo(diagHalf * baseUnitsPerSec, 4);
    expect(ctrl.avatarPos.z).toBeCloseTo(-diagHalf * baseUnitsPerSec, 4);

    // 3. Out-of-bounds stick values clamp cleanly to unit circle; NaN zeroes safely without error
    ctrl.teleportTo(0, 0, 0, nav);
    ctrl.setAnalogStick(3, 4);
    const stepClamped = ctrl.step(0.5, nav);
    expect(stepClamped.movedMeters).toBeCloseTo(3.8 * 0.5, 5);

    ctrl.setAnalogStick(Number.NaN, Number.POSITIVE_INFINITY);
    expect(ctrl.getInputVector().active).toBe(false);
    expect(ctrl.step(0.5, nav).movedMeters).toBe(0);

    // 4. toggleSprint() latches x3 boost independently of Shift and does not double-stack to x9
    expect(ctrl.sprintToggle).toBe(false);
    expect(ctrl.toggleSprint()).toBe(true);
    expect(ctrl.sprintToggle).toBe(true);
    expect(ctrl.snapshot().sprintToggle).toBe(true);
    expect(ctrl.effectiveSpeedMps()).toBeCloseTo(3.8 * SPRINT_BOOST_MULTIPLIER, 6);

    ctrl.teleportTo(0, 0, 0, nav);
    ctrl.cameraYaw = Math.PI / 2; // facing +X
    ctrl.setAnalogStick(1, 0);
    const stepSprint = ctrl.step(0.5, nav);
    expect(stepSprint.movedMeters).toBeCloseTo(3.8 * SPRINT_BOOST_MULTIPLIER * 0.5, 4);
    expect(ctrl.avatarPos.x).toBeCloseTo(3.8 * SPRINT_BOOST_MULTIPLIER * 0.5 * UNITS_PER_METER, 4);

    // Holding Shift while sprintToggle is already active stays at x3 (not x9)
    ctrl.setKey('ShiftLeft', true);
    expect(ctrl.effectiveSpeedMps()).toBeCloseTo(3.8 * SPRINT_BOOST_MULTIPLIER, 6);
    ctrl.setKey('ShiftLeft', false);

    expect(ctrl.toggleSprint()).toBe(false);
    expect(ctrl.sprintToggle).toBe(false);
    expect(ctrl.effectiveSpeedMps()).toBeCloseTo(3.8, 6);

    // clearKeys() zeroes analog stick without throwing
    ctrl.clearKeys();
    expect(ctrl.getInputVector().active).toBe(false);
  });
});

describe('Tactical3DCanvas & TacticalBoardCanvas mobile controls and hygiene', () => {
  it('mounts cleanly without WebGL, exposes resetView/setCameraMode, and renders Manor roaming HUD + mobile controls', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 404 })),
    );

    const wrapper = mount(Tactical3DCanvas, {
      props: {
        mapId: 2,
        isStandalone: true,
        floor: 'ALL',
      },
    });

    expect(wrapper.find('[data-test="btn-3d-overview"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="btn-3d-roam"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="btn-3d-quality"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="btn-3d-night"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="btn-3d-reset"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="btn-roam-collision"]').exists()).toBe(true);

    // Toggle quality tier ('高清' <-> '流畅') cleanly without errors
    const qualityBtn = wrapper.find('[data-test="btn-3d-quality"]');
    const initialTierText = qualityBtn.text();
    expect(['流畅', '高清']).toContain(initialTierText);
    await qualityBtn.trigger('click');
    expect(qualityBtn.text()).toBe(initialTierText === '流畅' ? '高清' : '流畅');

    // Exposed methods match locked contract for SandboxView.vue
    const vm = wrapper.vm as unknown as {
      resetView: () => void;
      setCameraMode: (mode: 'overview' | 'roaming') => void;
    };
    expect(typeof vm.resetView).toBe('function');
    expect(typeof vm.setCameraMode).toBe('function');

    vm.setCameraMode('roaming');
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-test="roam-hud"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="roam-speed-preset"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="roam-speed-slider"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="roam-distance"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="roam-timer"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="roam-floor"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="btn-roam-sprint"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="btn-roam-reset-stats"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="btn-roam-next-spawn"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="roam-joystick"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="roam-dpad"]').exists()).toBe(true);

    // Toggle x3 sprint button cleanly
    const sprintBtn = wrapper.find('[data-test="btn-roam-sprint"]');
    expect(sprintBtn.attributes('aria-pressed')).toBe('false');
    await sprintBtn.trigger('click');
    expect(sprintBtn.attributes('aria-pressed')).toBe('true');

    // Exercise virtual joystick pointer lifecycle and multi-touch pinch-zoom on .canvas-3d-surface with zero errors
    const joystick = wrapper.find('[data-test="roam-joystick"]');
    await joystick.trigger('pointerdown', { pointerId: 11, clientX: 60, clientY: 780 });
    await joystick.trigger('pointermove', { pointerId: 11, clientX: 80, clientY: 750 });
    await joystick.trigger('pointerup', { pointerId: 11, clientX: 80, clientY: 750 });

    const surface = wrapper.find('.canvas-3d-surface');
    await surface.trigger('pointerdown', { pointerId: 1, clientX: 200, clientY: 200 });
    await surface.trigger('pointerdown', { pointerId: 2, clientX: 300, clientY: 200 });
    await surface.trigger('pointermove', { pointerId: 2, clientX: 360, clientY: 200 });
    await surface.trigger('pointerup', { pointerId: 2, clientX: 360, clientY: 200 });
    await surface.trigger('pointermove', { pointerId: 1, clientX: 215, clientY: 205 });
    await surface.trigger('pointerup', { pointerId: 1, clientX: 215, clientY: 205 });

    expect(window.__idv3dState?.mapId).toBe(2);
    expect(window.__idv3dState?.cameraMode).toBe('roaming');

    wrapper.unmount();
    vi.unstubAllGlobals();
  });

  it('supports 2-finger pinch-to-zoom and 2-finger pan on TacticalBoardCanvas while keeping CSS >= 12px and 0 external URLs', async () => {
    installCanvasStub();
    const board = mount(TacticalBoardCanvas, {
      props: {
        payload: makeReplay(),
        t: 0,
        pitch: 90,
        yaw: 0,
        yScale: 1,
        layers: {},
        underlay: { enabled: true, opacity: 0.55, rotationQuadrants: 0, flipX: false, flipZ: false },
      },
    });
    const r = (board.vm as unknown as { renderer: { getCamera: () => { zoom: number; centerX: number } } }).renderer;
    const z0 = r.getCamera().zoom;
    const cx0 = r.getCamera().centerX;

    const canvas = board.find('[data-test="board-canvas"]');
    // Spread two fingers apart (100px -> 200px) while shifting midpoint right (+40px)
    await canvas.trigger('pointerdown', { button: 0, pointerId: 1, clientX: 300, clientY: 280 });
    await canvas.trigger('pointerdown', { button: 0, pointerId: 2, clientX: 400, clientY: 280 });
    await canvas.trigger('pointermove', { button: 0, pointerId: 1, clientX: 290, clientY: 280 });
    await canvas.trigger('pointermove', { button: 0, pointerId: 2, clientX: 490, clientY: 280 });
    await canvas.trigger('pointerup', { button: 0, pointerId: 2, clientX: 490, clientY: 280 });
    await canvas.trigger('pointerup', { button: 0, pointerId: 1, clientX: 290, clientY: 280 });

    expect(r.getCamera().zoom).toBeGreaterThan(z0 * 1.5);
    expect(r.getCamera().centerX).not.toBeCloseTo(cx0, 2);
    expect(board.emitted('pick')).toBeUndefined();
    board.unmount();

    // Hygiene check: 0 external URLs & >= 12px font size in owned Vue components
    const src3d = fs.readFileSync(
      path.resolve(__dirname, '../components/tactical/Tactical3DCanvas.vue'),
      'utf8',
    );
    const src2d = fs.readFileSync(
      path.resolve(__dirname, '../components/TacticalBoardCanvas.vue'),
      'utf8',
    );
    expect(src3d).not.toMatch(/https?:\/\//i);
    expect(src2d).not.toMatch(/https?:\/\//i);
    for (const src of [src3d, src2d]) {
      const styleMatch = src.match(/<style[\s\S]*?<\/style>/gi) ?? [];
      for (const block of styleMatch) {
        for (const m of block.matchAll(/font-size:\s*([\d.]+)px/g)) {
          expect(Number(m[1])).toBeGreaterThanOrEqual(12);
        }
        for (const m of block.matchAll(/font:\s*(?:\d+\s+)?([\d.]+)px\//g)) {
          expect(Number(m[1])).toBeGreaterThanOrEqual(12);
        }
      }
    }
  });
});
