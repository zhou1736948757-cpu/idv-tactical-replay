<script setup lang="ts">
/**
 * Offline Three.js 3D Tactical Viewer & PIL-Style Third-Person 3D Roaming Engine.
 *
 * Loads Tier-2 mobile-optimized `<scene>.glb` + `<scene>.nav.glb` from `/assets/maps-3d/`
 * (100% offline, zero external URLs), synchronizes 10Hz replay player beacons & trails or
 * standalone whiteboard tokens, and provides Overview Free-Fly + Third-Person Roaming modes.
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';
import {
  extractPlayerTrail,
  sampleCipherAtTime,
  samplePlayerAtTime,
  type FloorId,
  type Replay2DPayload,
  type WorldRect,
} from '@idv/replay-renderer';
import {
  CARRY_BAND_COLORS,
  CARRY_DEFAULTS,
  MAPS_DATA,
  TIDE_BAND_COLORS,
  animPositionAt,
  createCarryProfile,
  createTideProfile,
  type PilMapId,
  type Point2D,
  type TacticalBoardState,
} from '@/tactical';
import {
  computeReplayLink,
  projectReplayPoint,
  type ReplayLinkResult,
} from '@/tactical/replay-link';
import type { LandmarkVisibility, RangeOverlayState } from '@/lib/board';
import { withBaseUrl } from '@/lib/assetUrl';
import {
  ROAM_SPEED_PRESETS,
  RoamingController,
  SCENE_3D_LABELS_ZH,
  UNITS_PER_METER,
  buildNavMeshFromGlbBinary,
  collectChairs3D,
  computeCarryField3D,
  computeHardestChairExtrema3D,
  computeTideField3D,
  findPath3D,
  hasNightVariant,
  normalizedToWorld3D,
  replayWorldTo3D,
  resolveScene3DId,
  scene3DAssetUrls,
  world3DToNormalized,
  type CameraMode3D,
  type DpadDirection,
  type HardestChairSpot3D,
  type NavMesh3D,
  type Path3DResult,
  type RoamSpeedPresetId,
  type Scene3DId,
  type SurfaceField3DResult,
  type Vec3Point,
} from '@/tactical/scene3d';

// Wire three-mesh-bvh acceleration onto Three.js prototypes once
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

export type QualityTier3D = 'mobile' | 'desktop';

export interface Idv3DWindowState {
  ready: boolean;
  loading: boolean;
  error: string | null;
  mapId: PilMapId;
  sceneId: Scene3DId;
  cameraMode: CameraMode3D;
  calls: number;
  triangles: number;
  avatarPos: { x: number; y: number; z: number };
  distanceM: number;
  elapsedS: number;
  speedMps: number;
  floor: FloorId;
  navTriangles: number;
  playerCount: number;
}

declare global {
  interface Window {
    __idv3dState?: Idv3DWindowState;
  }
}

const props = withDefaults(
  defineProps<{
    mapId: PilMapId;
    payload?: Replay2DPayload | null;
    t?: number;
    isStandalone?: boolean;
    hudExpanded?: boolean;
    floor?: 'ALL' | 'B1' | '1F' | '2F';
    board?: TacticalBoardState | null;
    cipherGroupIndex?: number;
    animTime?: number | null;
    animPlaying?: boolean;
    routePointA?: Point2D | null;
    routePointB?: Point2D | null;
    rangeState?: RangeOverlayState | null;
    selectedUid?: string | number | null;
    followUid?: string | number | null;
    landmarks?: LandmarkVisibility | null;
  }>(),
  {
    payload: null,
    t: 0,
    isStandalone: true,
    hudExpanded: false,
    floor: 'ALL',
    board: undefined,
    cipherGroupIndex: 0,
    animTime: 0,
    animPlaying: false,
    routePointA: null,
    routePointB: null,
    rangeState: null,
    selectedUid: null,
    followUid: null,
    landmarks: undefined,
  },
);

const emit = defineEmits<{
  (
    e: 'handoff-to-2d',
    payload: {
      pointA?: Point2D | null;
      pointB?: Point2D | null;
      rangeOrigin?: {
        x: number;
        y: number;
        label: string;
        scenario: 'carry' | 'tide';
        mode: 'chair' | 'point';
      } | null;
      floor?: 'ALL' | FloorId;
    },
  ): void;
}>();

// ---------------------------------------------------------------------------
// Mobile / Low-Memory Detection & Module-Level Binary + NavMesh LRU Cache
// ---------------------------------------------------------------------------
function detectInitialQualityTier(): QualityTier3D {
  if (typeof window === 'undefined') return 'desktop';
  const coarse = Boolean(window.matchMedia?.('(pointer: coarse)').matches);
  return coarse || window.innerWidth < 960 ? 'mobile' : 'desktop';
}

function resolveSceneCacheMax(tier?: QualityTier3D): number {
  if (tier === 'mobile') return 1;
  const nav =
    typeof navigator !== 'undefined'
      ? (navigator as Navigator & { deviceMemory?: number })
      : undefined;
  if (typeof nav?.deviceMemory === 'number' && nav.deviceMemory <= 4) return 1;
  if (typeof window !== 'undefined') {
    const coarse = Boolean(window.matchMedia?.('(pointer: coarse)').matches);
    if (coarse || window.innerWidth < 960) return 1;
  }
  return 4;
}

interface CachedSceneBundle {
  glbBuffer: ArrayBuffer;
  navMesh: NavMesh3D;
}
let SCENE_CACHE_MAX = resolveSceneCacheMax();
const sceneBundleCache = new Map<Scene3DId, CachedSceneBundle>();
const pendingSceneLoads = new Map<Scene3DId, Promise<CachedSceneBundle>>();

function trimSceneBundleCache(maxEntries: number): void {
  while (sceneBundleCache.size > maxEntries) {
    const oldestKey = sceneBundleCache.keys().next().value;
    if (oldestKey === undefined) break;
    sceneBundleCache.delete(oldestKey);
  }
}

async function fetchSceneBundle(sceneId: Scene3DId, maxEntries: number): Promise<CachedSceneBundle> {
  SCENE_CACHE_MAX = maxEntries;
  const hit = sceneBundleCache.get(sceneId);
  if (hit) {
    sceneBundleCache.delete(sceneId);
    sceneBundleCache.set(sceneId, hit);
    trimSceneBundleCache(SCENE_CACHE_MAX);
    return hit;
  }
  const inflight = pendingSceneLoads.get(sceneId);
  if (inflight) return inflight;

  const { glbUrl, navGlbUrl } = scene3DAssetUrls(sceneId);
  const job = (async () => {
    const [glbRes, navRes] = await Promise.all([fetch(glbUrl), fetch(navGlbUrl)]);
    if (!glbRes.ok) {
      throw new Error(`3D 地图资源加载失败 (${glbRes.status}: ${glbUrl})`);
    }
    if (!navRes.ok) {
      throw new Error(`3D 导航网格加载失败 (${navRes.status}: ${navGlbUrl})`);
    }
    const [glbBuffer, navBuffer] = await Promise.all([
      glbRes.arrayBuffer(),
      navRes.arrayBuffer(),
    ]);
    const navMesh = buildNavMeshFromGlbBinary(navBuffer);
    const bundle: CachedSceneBundle = { glbBuffer, navMesh };
    while (sceneBundleCache.size >= SCENE_CACHE_MAX) {
      const oldestKey = sceneBundleCache.keys().next().value;
      if (oldestKey === undefined) break;
      sceneBundleCache.delete(oldestKey);
    }
    sceneBundleCache.set(sceneId, bundle);
    return bundle;
  })();

  pendingSceneLoads.set(sceneId, job);
  try {
    return await job;
  } finally {
    pendingSceneLoads.delete(sceneId);
  }
}

// ---------------------------------------------------------------------------
// Reactive UI State & Roaming Controller
// ---------------------------------------------------------------------------
const rootEl = ref<HTMLDivElement | null>(null);
const canvasHostEl = ref<HTMLDivElement | null>(null);
const joystickEl = ref<HTMLDivElement | null>(null);

const roaming = new RoamingController();
const nightMode = ref(false);
const lightingMode = ref<'bright' | 'mood'>('bright');
const spawnCursor = ref(0);
const qualityTier = ref<QualityTier3D>(detectInitialQualityTier());
SCENE_CACHE_MAX = resolveSceneCacheMax(qualityTier.value);

const joystickUi = reactive({
  active: false,
  dx: 0,
  dy: 0,
});

const ui = reactive({
  ready: false,
  loading: true,
  contextLost: false,
  error: null as string | null,
  cameraMode: roaming.cameraMode as CameraMode3D,
  speedPresetId: roaming.speedPresetId as RoamSpeedPresetId | 'custom',
  speedMps: roaming.speedMps,
  shiftHeld: false,
  sprintToggle: false,
  sprintActive: false,
  showCollision: false,
  teleportArmed: false,
  distanceM: 0,
  elapsedS: 0,
  floor: '1F' as FloorId,
  statusMsg: roaming.statusMsg,
  calls: 0,
  triangles: 0,
  navTriangles: 0,
  playerCount: 0,
  spawnLabel: '默认点',
});

const supportsNight = computed(() => hasNightVariant(props.mapId));
const activeSceneId = computed<Scene3DId>(() =>
  resolveScene3DId(props.mapId, supportsNight.value && nightMode.value),
);
const activeSceneLabel = computed(() => SCENE_3D_LABELS_ZH[activeSceneId.value]);

const isHunterSpeedPreset = computed(() =>
  ['hunter1', 'hunter2', 'hunter3', 'hullabaloo', 'witch', 'yithian'].includes(
    String(ui.speedPresetId),
  ),
);

let lastWindowPublishTs = 0;

function publishWindowState(immediate = true): void {
  if (typeof window === 'undefined') return;
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  if (!immediate && now - lastWindowPublishTs < 95) {
    return;
  }
  lastWindowPublishTs = now;
  window.__idv3dState = {
    ready: ui.ready,
    loading: ui.loading,
    error: ui.error,
    mapId: props.mapId,
    sceneId: activeSceneId.value,
    cameraMode: ui.cameraMode,
    calls: ui.calls,
    triangles: ui.triangles,
    avatarPos: {
      x: +roaming.avatarPos.x.toFixed(2),
      y: +roaming.avatarPos.y.toFixed(2),
      z: +roaming.avatarPos.z.toFixed(2),
    },
    distanceM: +ui.distanceM.toFixed(2),
    elapsedS: +ui.elapsedS.toFixed(2),
    speedMps: +ui.speedMps.toFixed(2),
    floor: ui.floor,
    navTriangles: ui.navTriangles,
    playerCount: ui.playerCount,
  };
}

function syncUiFromController(immediatePublish = true): void {
  ui.cameraMode = roaming.cameraMode;
  ui.speedPresetId = roaming.speedPresetId;
  ui.speedMps = roaming.speedMps;
  ui.shiftHeld = roaming.shiftHeld;
  ui.sprintToggle = roaming.sprintToggle;
  ui.sprintActive = roaming.shiftHeld || roaming.sprintToggle;
  ui.showCollision = roaming.showCollision;
  ui.teleportArmed = roaming.teleportArmed;
  ui.distanceM = roaming.distanceM;
  ui.elapsedS = roaming.elapsedS;
  ui.floor = roaming.floor;
  ui.statusMsg = roaming.statusMsg;
  markDirty(2);
  publishWindowState(immediatePublish);
}

// ---------------------------------------------------------------------------
// Three.js Runtime Handles
// ---------------------------------------------------------------------------
let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let controls: OrbitControls | null = null;
let resizeObserver: ResizeObserver | null = null;
let hemiLight: THREE.HemisphereLight | null = null;
let sunLight: THREE.DirectionalLight | null = null;
let rimLight: THREE.DirectionalLight | null = null;

let mapGroup: THREE.Group | null = null;
let raycastTargets: THREE.Object3D[] = [];
let navMesh: NavMesh3D | null = null;
let collisionGroup: THREE.Group | null = null;
let collisionAvatarMesh: THREE.Mesh | null = null;
let avatarGroup: THREE.Group | null = null;
let avatarTorsoMat: THREE.MeshStandardMaterial | null = null;
let avatarRingMat: THREE.MeshBasicMaterial | null = null;

let replayBeaconsGroup: THREE.Group | null = null;
let boardPinsGroup: THREE.Group | null = null;
let ciphersGroup: THREE.Group | null = null;
let tactical3dGroup: THREE.Group | null = null;

// P1 3D Tactical Deduction State (A->B Path, Carry/Tide 3D Surface Field, Hardest-Chair Extrema)
type Tac3DTab = 'route' | 'range' | 'extrema';
type Tac3DPickSlot = 'a' | 'b' | 'range' | null;

const tac3dOpen = ref(false);
const tac3dTab = ref<Tac3DTab>('route');
const tac3dPickSlot = ref<Tac3DPickSlot>(null);
const tac3dPointA = ref<Vec3Point | null>(null);
const tac3dPointB = ref<Vec3Point | null>(null);
const tac3dSpeedMps = ref(3.8);
const tac3dAllowVault = ref(true);
const tac3dVaultPenaltyS = ref(1.0);
const tac3dPathResult = ref<Path3DResult | null>(null);

const tac3dRangeScenario = ref<'carry' | 'tide'>('carry');
const tac3dRangeMode = ref<'chair' | 'point'>('chair');
const tac3dRangeOrigin = ref<{ pos: Vec3Point; label: string } | null>(null);
const tac3dRangeResult = ref<SurfaceField3DResult | null>(null);

const tac3dExtrema = ref<HardestChairSpot3D[]>([]);
const tac3dPathFollowActive = ref(false);
let tac3dPathFollowDistM = 0;
let overviewPickDownPos: { x: number; y: number } | null = null;

let mapCenter = new THREE.Vector3(0, 0, 0);
let mapMaxDim = 1800;

let rafId: number | null = null;
let lastFrameTs = 0;
let loadGeneration = 0;
let dirtyFrames = 3;
let wasRoamingMoving = false;

// Adaptive mobile pixelRatio EMA scaler (1.5 -> 1.0 when sustained EMA > 22ms)
let frameTimeEmaMs = 16.0;
let mobileAdaptivePixelRatioCap = 1.5;

function markDirty(frames = 2): void {
  dirtyFrames = Math.max(dirtyFrames, frames);
}

// Cached replay link for exact sub-pixel 2D->3D alignment on 7-cipher matches
let cachedReplayMatchId: string | null = null;
let cachedReplayLink: ReplayLinkResult | null = null;

// Multi-touch pointer tracker on .canvas-3d-surface (1-finger orbit, 2-finger pinch-zoom)
const surfacePointers = new Map<number, { x: number; y: number }>();
let pointerDragging = false;
let lastPinchDist = 0;
let gestureHadMultiTouch = false;
let primaryDownPos = { x: 0, y: 0 };
let primaryMovedDist = 0;

// Left-thumb virtual analog joystick pointer tracker
let joystickPointerId: number | null = null;
let joystickCenter = { x: 0, y: 0 };
const JOYSTICK_MAX_RADIUS = 38;

const raycaster = new THREE.Raycaster();
raycaster.firstHitOnly = true;
const ndcVec = new THREE.Vector2();

const tmpMeshBox = new THREE.Box3();
const tmpMeshSize = new THREE.Vector3();

// Camera spring-arm occlusion raycaster (throttled to ~30Hz against raycastTargets)
const camRaycaster = new THREE.Raycaster();
camRaycaster.firstHitOnly = true;
const camTargetVec = new THREE.Vector3();
const camEyeVec = new THREE.Vector3();
const camDirVec = new THREE.Vector3();
let lastCamOccTs = 0;
let cachedSafeDist: number | null = null;
const lastCamOccPose = {
  x: NaN,
  y: NaN,
  z: NaN,
  yaw: NaN,
  pitch: NaN,
  dist: NaN,
};

function resetCamOcclusionCache(): void {
  lastCamOccTs = 0;
  cachedSafeDist = null;
  lastCamOccPose.x = NaN;
}

function disposeObject3D(root: THREE.Object3D | null): void {
  if (!root) return;
  const disposedGeoms = new Set<THREE.BufferGeometry>();
  const disposedMats = new Set<THREE.Material>();
  const disposedTexs = new Set<THREE.Texture>();

  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.geometry && !disposedGeoms.has(mesh.geometry)) {
      disposedGeoms.add(mesh.geometry);
      if (mesh.geometry.boundsTree) {
        mesh.geometry.disposeBoundsTree();
      }
      mesh.geometry.dispose();
    }
    const mats = Array.isArray(mesh.material)
      ? mesh.material
      : mesh.material
        ? [mesh.material]
        : [];
    for (const m of mats) {
      if (disposedMats.has(m)) continue;
      disposedMats.add(m);
      for (const val of Object.values(m)) {
        if (val && typeof val === 'object' && (val as THREE.Texture).isTexture) {
          const tex = val as THREE.Texture;
          if (!disposedTexs.has(tex)) {
            disposedTexs.add(tex);
            tex.dispose();
          }
        }
      }
      m.dispose();
    }
  });
}

function clearGroupChildren(group: THREE.Group | null): void {
  if (!group) return;
  while (group.children.length > 0) {
    const child = group.children[0]!;
    group.remove(child);
    disposeObject3D(child);
  }
}

// ---------------------------------------------------------------------------
// Pooled Replay Player Beacons & Pre-Allocated Float32Array(180) Trails
// ---------------------------------------------------------------------------
const TRAIL_MAX_POINTS = 60; // 60 vertices * 3 floats = Float32Array(180)

interface PooledPlayerBeacon {
  isHunter: boolean;
  beaconGroup: THREE.Group;
  bodyMesh: THREE.Mesh;
  bodyMat: THREE.MeshStandardMaterial;
  ringMesh: THREE.Mesh;
  ringMat: THREE.MeshBasicMaterial;
  noseMesh: THREE.Mesh;
  beamMesh: THREE.Mesh;
  beamMat: THREE.MeshBasicMaterial;
  crownMesh: THREE.Mesh;
  crownMat: THREE.MeshBasicMaterial;
  trailBuf: Float32Array;
  trailAttr: THREE.BufferAttribute;
  trailGeom: THREE.BufferGeometry;
  trailMat: THREE.LineBasicMaterial;
  trailLine: THREE.Line;
}

const playerBeaconPool = new Map<string, PooledPlayerBeacon>();
let pooledMatchId: string | null = null;
let lastSyncedStandaloneSig = '';

function clearPlayerBeaconPool(): void {
  if (replayBeaconsGroup) {
    clearGroupChildren(replayBeaconsGroup);
  }
  playerBeaconPool.clear();
  pooledMatchId = null;
}

function acquirePlayerBeacon(uid: string, isHunter: boolean): PooledPlayerBeacon {
  const existing = playerBeaconPool.get(uid);
  if (existing && existing.isHunter === isHunter) {
    return existing;
  }
  if (existing && replayBeaconsGroup) {
    replayBeaconsGroup.remove(existing.beaconGroup);
    replayBeaconsGroup.remove(existing.trailLine);
    disposeObject3D(existing.beaconGroup);
    disposeObject3D(existing.trailLine);
    playerBeaconPool.delete(uid);
  }

  const standingHeight = isHunter ? 17.5 : 13.5;
  const bodyRadius = isHunter ? 4.4 : 3.5;
  const beamHeight = isHunter ? 34 : 26;
  const hexColor = isHunter ? 0xe05263 : 0x5ea2e8;

  const beaconGroup = new THREE.Group();

  const bodyMat = new THREE.MeshStandardMaterial({
    color: hexColor,
    metalness: 0.25,
    roughness: 0.32,
    emissive: hexColor,
    emissiveIntensity: 0.28,
    transparent: false,
    opacity: 0.96,
  });
  const bodyMesh = new THREE.Mesh(
    new THREE.CapsuleGeometry(bodyRadius, Math.max(2.5, standingHeight - bodyRadius * 2), 6, 14),
    bodyMat,
  );
  bodyMesh.position.y = standingHeight * 0.5 + 1.2;
  beaconGroup.add(bodyMesh);

  // Unit-radius ring scaled dynamically via setScalar(ringRadius)
  const ringGeom = new THREE.RingGeometry(0.74, 1.0, 28);
  ringGeom.rotateX(-Math.PI / 2);
  const ringMat = new THREE.MeshBasicMaterial({
    color: hexColor,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.72,
    depthWrite: false,
  });
  const ringMesh = new THREE.Mesh(ringGeom, ringMat);
  ringMesh.position.y = 0.55;
  ringMesh.scale.setScalar(bodyRadius * 1.65);
  beaconGroup.add(ringMesh);

  const noseGeom = new THREE.ConeGeometry(bodyRadius * 0.65, 6.8, 12);
  noseGeom.rotateX(-Math.PI / 2);
  const noseMat = new THREE.MeshStandardMaterial({
    color: 0xf6e6c6,
    metalness: 0.4,
    roughness: 0.3,
  });
  const noseMesh = new THREE.Mesh(noseGeom, noseMat);
  noseMesh.position.set(0, standingHeight * 0.55 + 1.2, -(bodyRadius + 3.4));
  beaconGroup.add(noseMesh);

  const beamMat = new THREE.MeshBasicMaterial({
    color: hexColor,
    transparent: true,
    opacity: 0.3,
    depthWrite: false,
  });
  const beamMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.8, beamHeight, 10), beamMat);
  beamMesh.position.y = standingHeight + beamHeight * 0.5;
  beaconGroup.add(beamMesh);

  const crownMat = new THREE.MeshBasicMaterial({
    color: hexColor,
  });
  const crownMesh = new THREE.Mesh(
    new THREE.SphereGeometry(isHunter ? 4.2 : 3.3, 14, 10),
    crownMat,
  );
  crownMesh.position.y = standingHeight + beamHeight + 2.5;
  beaconGroup.add(crownMesh);

  // Pre-allocated Float32Array(180) trail buffer (zero per-frame GC churn)
  const trailBuf = new Float32Array(TRAIL_MAX_POINTS * 3);
  const trailAttr = new THREE.BufferAttribute(trailBuf, 3);
  trailAttr.setUsage(THREE.DynamicDrawUsage);
  const trailGeom = new THREE.BufferGeometry();
  trailGeom.setAttribute('position', trailAttr);
  trailGeom.setDrawRange(0, 0);
  const trailMat = new THREE.LineBasicMaterial({
    color: hexColor,
    transparent: true,
    opacity: 0.72,
  });
  const trailLine = new THREE.Line(trailGeom, trailMat);
  trailLine.frustumCulled = false;
  trailLine.visible = false;

  if (replayBeaconsGroup) {
    replayBeaconsGroup.add(beaconGroup);
    replayBeaconsGroup.add(trailLine);
  }

  const entry: PooledPlayerBeacon = {
    isHunter,
    beaconGroup,
    bodyMesh,
    bodyMat,
    ringMesh,
    ringMat,
    noseMesh,
    beamMesh,
    beamMat,
    crownMesh,
    crownMat,
    trailBuf,
    trailAttr,
    trailGeom,
    trailMat,
    trailLine,
  };
  playerBeaconPool.set(uid, entry);
  return entry;
}

// ---------------------------------------------------------------------------
// Sculpted 3D Tactical Avatar & Overlays
// ---------------------------------------------------------------------------
function buildAvatarGroup(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'idv-roaming-avatar';

  // Ground halo ring
  const ringGeom = new THREE.RingGeometry(5.2, 7.2, 32);
  ringGeom.rotateX(-Math.PI / 2);
  avatarRingMat = new THREE.MeshBasicMaterial({
    color: 0xe5bc73,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
  });
  const ringMesh = new THREE.Mesh(ringGeom, avatarRingMat);
  ringMesh.position.y = 0.5;
  group.add(ringMesh);

  // Brass plinth
  const plinthGeom = new THREE.CylinderGeometry(4.2, 4.8, 1.8, 24);
  const brassMat = new THREE.MeshStandardMaterial({
    color: 0xd8b36a,
    metalness: 0.65,
    roughness: 0.28,
    emissive: 0x3b2a12,
    emissiveIntensity: 0.35,
  });
  const plinth = new THREE.Mesh(plinthGeom, brassMat);
  plinth.position.y = 1.1;
  group.add(plinth);

  // Body capsule
  const torsoGeom = new THREE.CapsuleGeometry(3.4, 8.8, 8, 18);
  avatarTorsoMat = new THREE.MeshStandardMaterial({
    color: 0x5ea2e8,
    metalness: 0.22,
    roughness: 0.32,
    emissive: 0x1e4b85,
    emissiveIntensity: 0.45,
  });
  const torso = new THREE.Mesh(torsoGeom, avatarTorsoMat);
  torso.position.y = 8.8;
  group.add(torso);

  // Sculpted head finial
  const headGeom = new THREE.SphereGeometry(2.85, 18, 14);
  const headMat = new THREE.MeshStandardMaterial({
    color: 0xf6e6c6,
    metalness: 0.3,
    roughness: 0.28,
    emissive: 0x4b381d,
    emissiveIntensity: 0.22,
  });
  const head = new THREE.Mesh(headGeom, headMat);
  head.position.y = 16.8;
  group.add(head);

  // Forward directional nose cone along local -Z
  const coneGeom = new THREE.ConeGeometry(2.5, 7.2, 16);
  coneGeom.rotateX(-Math.PI / 2);
  const cone = new THREE.Mesh(coneGeom, brassMat);
  cone.position.set(0, 9.2, -6.8);
  group.add(cone);

  group.visible = false;
  return group;
}

function updateAvatarColors(): void {
  if (!avatarTorsoMat || !avatarRingMat) return;
  if (isHunterSpeedPreset.value) {
    avatarTorsoMat.color.setHex(0xe05263);
    avatarTorsoMat.emissive.setHex(0x6e1723);
    avatarRingMat.color.setHex(0xf0717e);
  } else {
    avatarTorsoMat.color.setHex(0x5ea2e8);
    avatarTorsoMat.emissive.setHex(0x1e4b85);
    avatarRingMat.color.setHex(0xe5bc73);
  }
}

function rebuildCollisionOverlay(nav: NavMesh3D): void {
  if (!scene) return;
  if (collisionGroup) {
    scene.remove(collisionGroup);
    disposeObject3D(collisionGroup);
    collisionGroup = null;
    collisionAvatarMesh = null;
  }

  const group = new THREE.Group();
  group.name = 'idv-nav-collision-overlay';

  if (nav.rawTrianglePositions.length >= 9) {
    const lifted = new Float32Array(nav.rawTrianglePositions.length);
    for (let i = 0; i < nav.rawTrianglePositions.length; i += 3) {
      lifted[i] = nav.rawTrianglePositions[i];
      lifted[i + 1] = nav.rawTrianglePositions[i + 1] + 2.2;
      lifted[i + 2] = nav.rawTrianglePositions[i + 2];
    }
    const navGeom = new THREE.BufferGeometry();
    navGeom.setAttribute('position', new THREE.BufferAttribute(lifted, 3));
    const navMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      wireframe: true,
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
      depthTest: false,
    });
    const navWire = new THREE.Mesh(navGeom, navMat);
    navWire.renderOrder = 2;
    group.add(navWire);
  }

  const cylGeom = new THREE.CylinderGeometry(4.4, 4.4, 19.5, 20, 1, true);
  const cylMat = new THREE.MeshBasicMaterial({
    color: 0x67e8f9,
    wireframe: true,
    transparent: true,
    opacity: 0.88,
    depthWrite: false,
  });
  collisionAvatarMesh = new THREE.Mesh(cylGeom, cylMat);
  group.add(collisionAvatarMesh);

  group.visible = roaming.showCollision;
  collisionGroup = group;
  scene.add(group);
}

// ---------------------------------------------------------------------------
// Floor Clipping Planes & Quality Tier Application
// ---------------------------------------------------------------------------
function applyFloorClipping(): void {
  if (!renderer) return;
  const medY = navMesh?.medianFloorY ?? 0;
  if (props.floor === 'B1') {
    renderer.localClippingEnabled = true;
    renderer.clippingPlanes = [new THREE.Plane(new THREE.Vector3(0, -1, 0), medY - 8)];
  } else if (props.floor === '1F') {
    renderer.localClippingEnabled = true;
    renderer.clippingPlanes = [new THREE.Plane(new THREE.Vector3(0, -1, 0), medY + 34)];
  } else {
    renderer.clippingPlanes = [];
    renderer.localClippingEnabled = false;
  }
  markDirty(2);
}

function applyLightingPreset(): void {
  if (!scene || !renderer) return;
  const isNightScene = activeSceneId.value === 'h55_demo2';
  const isBright = lightingMode.value === 'bright';

  if (isBright) {
    // PIL-calibrated 3-point sunlit rig: bright sky-ground bounce + warm sun + cool fill, zero grey haze
    renderer.toneMappingExposure = isNightScene ? 1.18 : 1.3;
    if (hemiLight) {
      hemiLight.color.setHex(isNightScene ? 0xbdd2f2 : 0xf2f7ff);
      hemiLight.groundColor.setHex(isNightScene ? 0x3b3842 : 0x6c6154);
      hemiLight.intensity = isNightScene ? 1.95 : 2.65;
    }
    if (sunLight) {
      sunLight.color.setHex(isNightScene ? 0xdbe7ff : 0xfff2dc);
      sunLight.intensity = isNightScene ? 2.25 : 3.35;
      sunLight.position.set(-220, 520, 320);
    }
    if (rimLight) {
      rimLight.color.setHex(0xd6e8ff);
      rimLight.intensity = isNightScene ? 1.0 : 1.35;
      rimLight.position.set(360, 250, -120);
      rimLight.visible = true;
    }
    const bgHex = isNightScene ? 0x141d2b : 0x22303c;
    scene.background = new THREE.Color(bgHex);
    scene.fog = isNightScene ? new THREE.FogExp2(bgHex, 0.000055) : null;
  } else {
    // Atmospheric Manor twilight mode (still clear & legible, softer directional contrast)
    renderer.toneMappingExposure = isNightScene ? 1.06 : 1.15;
    if (hemiLight) {
      hemiLight.color.setHex(0xd7e4f8);
      hemiLight.groundColor.setHex(0x433d38);
      hemiLight.intensity = isNightScene ? 1.45 : 1.8;
    }
    if (sunLight) {
      sunLight.color.setHex(0xffdfba);
      sunLight.intensity = isNightScene ? 1.6 : 2.15;
      sunLight.position.set(-260, 440, 300);
    }
    if (rimLight) {
      rimLight.color.setHex(0xa8c6ed);
      rimLight.intensity = 0.85;
      rimLight.position.set(360, 240, -120);
      rimLight.visible = true;
    }
    const bgHex = isNightScene ? 0x0e1420 : 0x17202b;
    scene.background = new THREE.Color(bgHex);
    scene.fog = new THREE.FogExp2(bgHex, 0.000085);
  }
  markDirty(2);
}

function toggleLightingMode(): void {
  lightingMode.value = lightingMode.value === 'bright' ? 'mood' : 'bright';
  applyLightingPreset();
  roaming.statusMsg =
    lightingMode.value === 'bright' ? '3D 光照：明亮日光（全图清晰）' : '3D 光照：庄园暮色';
  syncUiFromController(true);
}

function applyQualityTierSettings(): void {
  SCENE_CACHE_MAX = resolveSceneCacheMax(qualityTier.value);
  trimSceneBundleCache(SCENE_CACHE_MAX);
  if (!renderer) return;
  const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
  if (qualityTier.value === 'mobile') {
    const targetRatio = Math.min(dpr, mobileAdaptivePixelRatioCap);
    if (Math.abs(renderer.getPixelRatio() - targetRatio) > 0.01) {
      renderer.setPixelRatio(targetRatio);
      updateRendererSize();
    }
  } else {
    mobileAdaptivePixelRatioCap = 1.5;
    frameTimeEmaMs = 16.0;
    const targetRatio = Math.min(dpr, 2);
    if (Math.abs(renderer.getPixelRatio() - targetRatio) > 0.01) {
      renderer.setPixelRatio(targetRatio);
      updateRendererSize();
    }
  }
  applyLightingPreset();
}

function toggleQualityTier(): void {
  qualityTier.value = qualityTier.value === 'mobile' ? 'desktop' : 'mobile';
  mobileAdaptivePixelRatioCap = 1.5;
  frameTimeEmaMs = 16.0;
  applyQualityTierSettings();
  roaming.statusMsg =
    qualityTier.value === 'mobile' ? '画质档位：流畅（移动端省电）' : '画质档位：高清';
  syncUiFromController(true);
}

// ---------------------------------------------------------------------------
// Spawn Points & View Framing
// ---------------------------------------------------------------------------
interface SpawnCandidate3D {
  x: number;
  y: number;
  z: number;
  label: string;
}

function collectMapSpawns3D(): SpawnCandidate3D[] {
  const mapData = MAPS_DATA[props.mapId];
  if (!mapData) return [];
  const [w, h] = mapData.mapSize;
  const out: SpawnCandidate3D[] = [];

  // Open courtyard center spawn first so third-person roaming always opens with an unobstructed view
  const cNorm = normalizedToWorld3D(props.mapId, 0.5, 0.5);
  const cSnap = navMesh?.findNearestWalkable(cNorm.x, cNorm.z, navMesh.medianFloorY, 360);
  out.push({
    x: cSnap?.x ?? cNorm.x,
    y: cSnap?.y ?? navMesh?.medianFloorY ?? 0,
    z: cSnap?.z ?? cNorm.z,
    label: '中场起点',
  });

  mapData.spawnPoints.forEach((grp, gIdx) => {
    const hNorm = normalizedToWorld3D(props.mapId, grp.hunter[0] / w, grp.hunter[1] / h);
    const hSnap = navMesh?.findNearestWalkable(hNorm.x, hNorm.z, navMesh.medianFloorY, 320);
    out.push({
      x: hSnap?.x ?? hNorm.x,
      y: hSnap?.y ?? navMesh?.medianFloorY ?? 0,
      z: hSnap?.z ?? hNorm.z,
      label: `刷点组${gIdx + 1}·监管`,
    });
    grp.survivor.slice(0, 2).forEach((sv, sIdx) => {
      const sNorm = normalizedToWorld3D(props.mapId, sv[0] / w, sv[1] / h);
      const sSnap = navMesh?.findNearestWalkable(sNorm.x, sNorm.z, navMesh.medianFloorY, 320);
      out.push({
        x: sSnap?.x ?? sNorm.x,
        y: sSnap?.y ?? navMesh?.medianFloorY ?? 0,
        z: sSnap?.z ?? sNorm.z,
        label: `刷点组${gIdx + 1}·求生${sIdx + 1}`,
      });
    });
  });

  return out;
}

function placeAvatarAtInitialSpawn(): void {
  resetCamOcclusionCache();
  const spawns = collectMapSpawns3D();
  if (spawns.length > 0) {
    spawnCursor.value = 0;
    const sp = spawns[0]!;
    roaming.teleportTo(sp.x, sp.z, sp.y, navMesh);
    ui.spawnLabel = sp.label;
    // Face inward toward map center
    const toCenterX = mapCenter.x - roaming.avatarPos.x;
    const toCenterZ = mapCenter.z - roaming.avatarPos.z;
    if (Math.hypot(toCenterX, toCenterZ) > 1) {
      roaming.cameraYaw = Math.atan2(toCenterX, -toCenterZ);
      roaming.facingYaw = roaming.cameraYaw;
    }
    syncUiFromController(true);
    return;
  }

  const centerWorld = normalizedToWorld3D(props.mapId, 0.5, 0.5);
  roaming.teleportTo(centerWorld.x, centerWorld.z, navMesh?.medianFloorY ?? 0, navMesh);
  ui.spawnLabel = '地图中心';
  syncUiFromController(true);
}

function jumpNextSpawn(): void {
  const spawns = collectMapSpawns3D();
  if (spawns.length === 0) return;
  resetCamOcclusionCache();
  spawnCursor.value = (spawnCursor.value + 1) % spawns.length;
  const sp = spawns[spawnCursor.value]!;
  roaming.teleportTo(sp.x, sp.z, sp.y, navMesh);
  ui.spawnLabel = sp.label;
  roaming.statusMsg = `已切换至 ${sp.label}`;
  const toCenterX = mapCenter.x - roaming.avatarPos.x;
  const toCenterZ = mapCenter.z - roaming.avatarPos.z;
  if (Math.hypot(toCenterX, toCenterZ) > 1) {
    roaming.cameraYaw = Math.atan2(toCenterX, -toCenterZ);
    roaming.facingYaw = roaming.cameraYaw;
  }
  syncUiFromController(true);
}

function frameOverviewCamera(): void {
  if (!camera || !controls) return;
  camera.near = Math.max(1.5, mapMaxDim * 0.0008);
  camera.far = Math.max(16000, mapMaxDim * 14);
  camera.updateProjectionMatrix();

  const dist = Math.max(420, mapMaxDim * 0.58);
  controls.target.copy(mapCenter);
  camera.position.set(
    mapCenter.x + dist * 0.72,
    mapCenter.y + dist * 0.78,
    mapCenter.z + dist * 0.72,
  );
  camera.lookAt(mapCenter);
  controls.maxDistance = Math.max(4500, mapMaxDim * 3.2);
  controls.minDistance = 18;
  controls.update();
}

function resetView(): void {
  if (roaming.cameraMode === 'roaming') {
    roaming.cameraPitch = 0.42;
    roaming.cameraDistance = 78;
    placeAvatarAtInitialSpawn();
    roaming.resetTelemetry();
    roaming.statusMsg = '已复位漫游起点与视角';
    syncUiFromController(true);
  } else {
    frameOverviewCamera();
    roaming.statusMsg = '已复位 3D 俯瞰全景视角';
    syncUiFromController(true);
  }
}

function setCameraMode(mode: CameraMode3D): void {
  const prev = roaming.cameraMode;
  resetCamOcclusionCache();
  if (mode === 'overview') {
    joystickPointerId = null;
    joystickUi.active = false;
    joystickUi.dx = 0;
    joystickUi.dy = 0;
    surfacePointers.clear();
    pointerDragging = false;
  }
  roaming.setCameraMode(mode, navMesh);
  if (controls) {
    controls.enabled = mode === 'overview';
    if (mode === 'overview' && prev === 'roaming' && camera) {
      const p = roaming.avatarPos;
      controls.target.set(p.x, p.y + 8, p.z);
      camera.position.set(p.x + 260, p.y + 320, p.z + 260);
      controls.update();
    }
  }
  if (avatarGroup) {
    avatarGroup.visible = mode === 'roaming';
  }
  syncUiFromController(true);
}

// ---------------------------------------------------------------------------
// Replay Beacons, Trails, Ciphers & Standalone Whiteboard Pins
// ---------------------------------------------------------------------------
function resolveReplayWorldRect(payload: Replay2DPayload): WorldRect {
  const wr = payload.world.map_underlay?.world_rect;
  if (wr && wr.max_x > wr.min_x && wr.max_z > wr.min_z) return wr;
  return {
    min_x: payload.world.bounds.min_x,
    max_x: payload.world.bounds.max_x,
    min_z: payload.world.bounds.min_z,
    max_z: payload.world.bounds.max_z,
  };
}

function mapReplayPointTo3D(
  payload: Replay2DPayload,
  rx: number,
  ry: number,
  rz: number,
): { x: number; y: number; z: number } {
  if (cachedReplayMatchId !== payload.match.match_id) {
    cachedReplayMatchId = payload.match.match_id;
    cachedReplayLink = computeReplayLink(payload);
  }
  const mapData = MAPS_DATA[props.mapId];
  let wx: number;
  let wz: number;

  if (
    cachedReplayLink &&
    cachedReplayLink.mapId === props.mapId &&
    cachedReplayLink.confidence >= 0.7 &&
    mapData
  ) {
    const [px, py] = projectReplayPoint([rx, rz], cachedReplayLink.transform);
    const u = px / mapData.mapSize[0];
    const v = py / mapData.mapSize[1];
    const w = normalizedToWorld3D(props.mapId, u, v);
    wx = w.x;
    wz = w.z;
  } else {
    const w = replayWorldTo3D(props.mapId, rx, ry, rz, resolveReplayWorldRect(payload));
    wx = w.x;
    wz = w.z;
  }

  const baseRefY = (navMesh?.medianFloorY ?? 0) + ry;
  const floorHit = navMesh?.sampleFloor(wx, wz, baseRefY, 45, 95);
  return {
    x: wx,
    y: floorHit ? floorHit.y : baseRefY,
    z: wz,
  };
}

function rebuildCiphers3D(): void {
  clearGroupChildren(ciphersGroup);
  if (!ciphersGroup) return;
  if (props.landmarks && props.landmarks.ciphers === false) return;

  const medY = navMesh?.medianFloorY ?? 0;
  const brassMat = new THREE.MeshStandardMaterial({
    color: 0xe2bc73,
    metalness: 0.62,
    roughness: 0.3,
    emissive: 0x473314,
    emissiveIntensity: 0.38,
  });

  if (!props.isStandalone && props.payload?.entities?.ciphers?.length) {
    for (const c of props.payload.entities.ciphers) {
      const p3 = mapReplayPointTo3D(props.payload, c.pos[0], c.pos[1], c.pos[2]);
      const sample = sampleCipherAtTime(c, props.t ?? 0);
      const col = sample.isCompleted ? 0x5fc9a0 : sample.activeFixerCount > 0 ? 0xfbbf24 : 0xd8b36a;
      const m = brassMat.clone();
      m.color.setHex(col);
      const pillar = new THREE.Mesh(new THREE.BoxGeometry(6.5, 11, 5.2), m);
      pillar.position.set(p3.x, p3.y + 5.5, p3.z);
      pillar.userData = { cipherUid: c.uid };
      ciphersGroup.add(pillar);

      const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 9, 8), m);
      antenna.position.set(p3.x, p3.y + 15.5, p3.z);
      ciphersGroup.add(antenna);
    }
    brassMat.dispose();
    return;
  }

  // Standalone mode: show active cipher combination + P0 cipher progress color coding
  const mapData = MAPS_DATA[props.mapId];
  if (mapData) {
    const [w, h] = mapData.mapSize;
    const gCount = Math.max(1, mapData.cipherCombinations.length);
    const gIdx = (((props.cipherGroupIndex ?? 0) % gCount) + gCount) % gCount;
    const combo = mapData.cipherCombinations[gIdx] ?? [];
    const progEnabled = Boolean(props.board?.cipherProgressEnabled);
    const progMap = props.board?.cipherProgress ?? {};
    for (const cid of combo) {
      const cp = mapData.ciphers.find((item) => item.id === cid);
      if (!cp) continue;
      const w3 = normalizedToWorld3D(props.mapId, cp.location[0] / w, cp.location[1] / h);
      const snap = navMesh?.sampleFloor(w3.x, w3.z, medY, 60, 90);
      const y = snap ? snap.y : medY;
      const pct = progEnabled ? Math.max(0, Math.min(100, progMap[cid] ?? 0)) : 0;
      const col = progEnabled
        ? pct >= 100
          ? 0x34d399
          : pct >= 90
            ? 0xfbbf24
            : pct > 0
              ? 0x38bdf8
              : 0xe2bc73
        : 0xe2bc73;
      const m = brassMat.clone();
      m.color.setHex(col);
      if (progEnabled && pct >= 90) {
        m.emissive.setHex(col);
        m.emissiveIntensity = 0.55;
      }
      const pillar = new THREE.Mesh(new THREE.BoxGeometry(6.2, 10.5, 5.0), m);
      pillar.position.set(w3.x, y + 5.25, w3.z);
      ciphersGroup.add(pillar);
    }
  }
  brassMat.dispose();
}

function buildStandaloneTokensSig(): string {
  if (!props.isStandalone || !props.board?.tokens?.length) return '';
  const at = props.animTime != null ? props.animTime.toFixed(2) : 'null';
  let sig = `${props.mapId}|t=${at}|`;
  for (const tk of props.board.tokens) {
    sig += `${tk.tid}:${tk.x.toFixed(4)},${tk.y.toFixed(4)}:${tk.camp}:${tk.anim?.points?.length ?? 0};`;
  }
  return sig;
}

function syncReplayAndBoardEntities(immediatePublish = false): void {
  // Hide pooled replay beacons initially; active players re-enable them in-place without GC
  for (const entry of playerBeaconPool.values()) {
    entry.beaconGroup.visible = false;
    entry.trailLine.visible = false;
  }

  let count = 0;

  // 1. Synchronized 10Hz Replay Player Beacons + 5s Pre-Allocated Trails
  if (!props.isStandalone && props.payload && replayBeaconsGroup) {
    if (lastSyncedStandaloneSig !== '') {
      clearGroupChildren(boardPinsGroup);
      lastSyncedStandaloneSig = '';
    }
    const payload = props.payload;
    if (pooledMatchId !== payload.match.match_id) {
      clearPlayerBeaconPool();
      pooledMatchId = payload.match.match_id;
    }

    const curT = props.t ?? 0;

    for (const player of payload.players) {
      const uidKey = String(player.uid);
      const traj = payload.trajectories[uidKey];
      const sample = samplePlayerAtTime(traj, curT);
      if (!sample) continue;
      count++;

      const p3 = mapReplayPointTo3D(payload, sample.pos[0], sample.pos[1], sample.pos[2]);
      const ahead = mapReplayPointTo3D(
        payload,
        sample.pos[0] + sample.dir[0] * 12,
        sample.pos[1],
        sample.pos[2] + sample.dir[1] * 12,
      );
      const yaw3D = Math.atan2(ahead.x - p3.x, -(ahead.z - p3.z));

      const isHunter = player.camp === 1;
      const isSelected =
        props.selectedUid !== null &&
        props.selectedUid !== undefined &&
        uidKey === String(props.selectedUid);

      let hexColor = isHunter ? 0xe05263 : 0x5ea2e8;
      let opacity = 0.96;
      if (!isHunter) {
        if (sample.fearState === 1) hexColor = 0xeab308;
        else if (sample.fearState === 2 || sample.fearState === 3) hexColor = 0xef4444;
        else if (sample.fearState >= 4) {
          hexColor = 0x64748b;
          opacity = 0.45;
        }
      }

      const entry = acquirePlayerBeacon(uidKey, isHunter);
      entry.beaconGroup.visible = true;
      entry.beaconGroup.position.set(p3.x, p3.y, p3.z);
      entry.beaconGroup.rotation.y = -yaw3D;

      const standingHeight = isHunter ? 17.5 : 13.5;
      const bodyHeight = !isHunter && sample.fearState === 2 ? 6.5 : standingHeight;
      const bodyRadius = isHunter ? 4.4 : 3.5;
      const beamHeight = isHunter ? 34 : 26;

      entry.bodyMesh.scale.set(1, bodyHeight / standingHeight, 1);
      entry.bodyMesh.position.y = bodyHeight * 0.5 + 1.2;
      entry.bodyMat.color.setHex(hexColor);
      entry.bodyMat.emissive.setHex(hexColor);
      entry.bodyMat.emissiveIntensity = isSelected ? 0.55 : 0.28;
      const needTransparent = opacity < 1;
      if (entry.bodyMat.transparent !== needTransparent) {
        entry.bodyMat.transparent = needTransparent;
        entry.bodyMat.needsUpdate = true;
      }
      entry.bodyMat.opacity = opacity;

      const ringRadius = isSelected ? bodyRadius * 2.2 : bodyRadius * 1.65;
      entry.ringMesh.scale.setScalar(ringRadius);
      entry.ringMat.color.setHex(isSelected ? 0xf8d88c : hexColor);
      entry.ringMat.opacity = isSelected ? 0.95 : 0.72;

      entry.noseMesh.position.set(0, bodyHeight * 0.55 + 1.2, -(bodyRadius + 3.4));

      entry.beamMesh.position.y = bodyHeight + beamHeight * 0.5;
      entry.beamMat.color.setHex(isSelected ? 0xf8d88c : hexColor);
      entry.beamMat.opacity = isSelected ? 0.48 : 0.3;

      entry.crownMesh.position.y = bodyHeight + beamHeight + 2.5;
      entry.crownMat.color.setHex(isSelected ? 0xffe8a3 : hexColor);

      // Update pre-allocated Float32Array(180) trail in-place
      const trailPts = extractPlayerTrail(traj, curT, 5.0);
      let vCount = 0;
      const startIdx = trailPts.length > TRAIL_MAX_POINTS ? trailPts.length - TRAIL_MAX_POINTS : 0;
      for (let i = startIdx; i < trailPts.length; i++) {
        const tp = trailPts[i]!;
        if (tp.breakBefore) {
          vCount = 0;
        }
        if (vCount < TRAIL_MAX_POINTS) {
          const t3 = mapReplayPointTo3D(payload, tp.pos[0], tp.pos[1], tp.pos[2]);
          const base = vCount * 3;
          entry.trailBuf[base] = t3.x;
          entry.trailBuf[base + 1] = t3.y + 1.8;
          entry.trailBuf[base + 2] = t3.z;
          vCount++;
        }
      }
      if (vCount >= 2) {
        entry.trailAttr.needsUpdate = true;
        entry.trailGeom.setDrawRange(0, vCount);
        entry.trailMat.color.setHex(hexColor);
        entry.trailLine.visible = true;
      } else {
        entry.trailGeom.setDrawRange(0, 0);
        entry.trailLine.visible = false;
      }

      // Camera follow in overview mode
      if (
        props.followUid !== null &&
        props.followUid !== undefined &&
        uidKey === String(props.followUid) &&
        roaming.cameraMode === 'overview' &&
        controls &&
        camera
      ) {
        const dx = p3.x - controls.target.x;
        const dy = p3.y + 8 - controls.target.y;
        const dz = p3.z - controls.target.z;
        controls.target.set(p3.x, p3.y + 8, p3.z);
        camera.position.x += dx;
        camera.position.y += dy;
        camera.position.z += dz;
      }
    }
  }

  // 2. Standalone Whiteboard 3D Tactical Pins + P0 Synchronized Multi-Character Animation Ribbons
  if (props.isStandalone && boardPinsGroup) {
    const nextSig = buildStandaloneTokensSig();
    count = props.board?.tokens?.length ?? 0;
    if (nextSig !== lastSyncedStandaloneSig) {
      lastSyncedStandaloneSig = nextSig;
      clearGroupChildren(boardPinsGroup);
      if (props.board?.tokens?.length) {
        const medY = navMesh?.medianFloorY ?? 0;
        const mapData = MAPS_DATA[props.mapId];
        const animGeom = mapData
          ? { dw: mapData.mapSize[0], dh: mapData.mapSize[1], widthM: mapData.widthM }
          : { dw: 1000, dh: 1000, widthM: 160 };
        const tVal = props.animTime ?? 0;

        for (const token of props.board.tokens) {
          let relX = token.x;
          let relY = token.y;
          if (token.anim && token.anim.points.length >= 2) {
            const sample = animPositionAt(token.anim, animGeom, tVal);
            if (sample) {
              relX = sample.x;
              relY = sample.y;
            }
          }
          const w3 = normalizedToWorld3D(props.mapId, relX, relY);
          const snap = navMesh?.sampleFloor(w3.x, w3.z, medY, 65, 95);
          const y = snap ? snap.y : medY;
          const isHunter = token.camp === 'hunter';
          const hex = isHunter ? 0xd94b5a : 0x5ea2e8;

          const pin = new THREE.Group();
          pin.position.set(w3.x, y, w3.z);

          const mat = new THREE.MeshStandardMaterial({
            color: hex,
            metalness: 0.22,
            roughness: 0.32,
            emissive: hex,
            emissiveIntensity: 0.36,
          });
          const stem = new THREE.Mesh(new THREE.CylinderGeometry(2.8, 3.8, 12, 16), mat);
          stem.position.y = 6.2;
          pin.add(stem);

          const finial = new THREE.Mesh(new THREE.SphereGeometry(3.6, 16, 12), mat);
          finial.position.y = 14.2;
          pin.add(finial);

          const baseGeom = new THREE.RingGeometry(4.2, 5.8, 24);
          baseGeom.rotateX(-Math.PI / 2);
          const baseMat = new THREE.MeshBasicMaterial({
            color: 0xe5bc73,
            side: THREE.DoubleSide,
            depthWrite: false,
          });
          const base = new THREE.Mesh(baseGeom, baseMat);
          base.position.y = 0.45;
          pin.add(base);

          boardPinsGroup.add(pin);

          // Render 3D trajectory ribbon for animated tokens
          if (token.anim && token.anim.points.length >= 2) {
            const lineVerts: number[] = [];
            for (const pt of token.anim.points) {
              const pw = normalizedToWorld3D(props.mapId, pt.x, pt.y);
              const ps = navMesh?.sampleFloor(pw.x, pw.z, medY, 65, 95);
              lineVerts.push(pw.x, (ps ? ps.y : medY) + 2.4, pw.z);
            }
            const lGeom = new THREE.BufferGeometry();
            lGeom.setAttribute('position', new THREE.Float32BufferAttribute(lineVerts, 3));
            const lMat = new THREE.LineBasicMaterial({
              color: hex,
              transparent: true,
              opacity: 0.85,
            });
            boardPinsGroup.add(new THREE.Line(lGeom, lMat));
          }
        }
      }
    }
  }

  ui.playerCount = count;
  markDirty(2);
  publishWindowState(immediatePublish);
}

// ---------------------------------------------------------------------------
// P1 3D Tactical Deduction Overlays (A->B Path, Carry/Tide Bands, Hardest-Chair Extrema)
// ---------------------------------------------------------------------------
function make3DBeacon(pos: Vec3Point, colorHex: number, height = 28): THREE.Group {
  const g = new THREE.Group();
  g.position.set(pos.x, pos.y, pos.z);
  const ringG = new THREE.RingGeometry(4.5, 7.2, 28);
  ringG.rotateX(-Math.PI / 2);
  const ringM = new THREE.MeshBasicMaterial({
    color: colorHex,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.92,
    depthWrite: false,
  });
  const ring = new THREE.Mesh(ringG, ringM);
  ring.position.y = 0.8;
  g.add(ring);

  const beamM = new THREE.MeshBasicMaterial({
    color: colorHex,
    transparent: true,
    opacity: 0.58,
    depthWrite: false,
  });
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 2.2, height, 10), beamM);
  beam.position.y = height * 0.5;
  g.add(beam);

  const orb = new THREE.Mesh(
    new THREE.SphereGeometry(3.6, 14, 10),
    new THREE.MeshBasicMaterial({ color: colorHex }),
  );
  orb.position.y = height + 3.2;
  g.add(orb);
  return g;
}

function rebuildTactical3DOverlay(): void {
  clearGroupChildren(tactical3dGroup);
  if (!tactical3dGroup || !navMesh) return;

  // 1. A->B 3D NavMesh Path
  if (tac3dPointA.value) {
    tactical3dGroup.add(make3DBeacon(tac3dPointA.value, 0x20d6a0, 26));
  }
  if (tac3dPointB.value) {
    tactical3dGroup.add(make3DBeacon(tac3dPointB.value, 0xfbbf24, 26));
  }
  const pathRes = tac3dPathResult.value;
  if (pathRes?.reachable && pathRes.points.length >= 2) {
    const verts: number[] = [];
    for (const pt of pathRes.points) {
      verts.push(pt.x, pt.y + 3.2, pt.z);
    }
    const lineG = new THREE.BufferGeometry();
    lineG.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    const lineM = new THREE.LineBasicMaterial({ color: 0x38f2b8 });
    tactical3dGroup.add(new THREE.Line(lineG, lineM));

    // Elevated ribbon tube segments for crisp visibility from overview height
    for (let i = 1; i < pathRes.points.length; i++) {
      const a = pathRes.points[i - 1]!;
      const b = pathRes.points[i]!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dz = b.z - a.z;
      const len = Math.hypot(dx, dy, dz);
      if (len < 0.5) continue;
      const segG = new THREE.CylinderGeometry(1.2, 1.2, len, 6);
      const segM = new THREE.MeshBasicMaterial({
        color: 0x20d6a0,
        transparent: true,
        opacity: 0.82,
      });
      const seg = new THREE.Mesh(segG, segM);
      seg.position.set((a.x + b.x) * 0.5, (a.y + b.y) * 0.5 + 2.8, (a.z + b.z) * 0.5);
      seg.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        new THREE.Vector3(dx / len, dy / len, dz / len),
      );
      tactical3dGroup.add(seg);
    }
  }

  // 2. 3D Carry / Tide 5-Band NavMesh Surface Overlay
  const field = tac3dRangeResult.value;
  if (field && field.reachedTris > 0) {
    tactical3dGroup.add(
      make3DBeacon(field.origin, field.scenario === 'carry' ? 0xf59e0b : 0x38bdf8, 30),
    );
    const palette = (field.scenario === 'carry' ? CARRY_BAND_COLORS : TIDE_BAND_COLORS).map(
      (hex) => new THREE.Color(hex),
    );
    const raw = navMesh.rawTrianglePositions;
    const positions: number[] = [];
    const colors: number[] = [];
    const bands = field.triBands;
    for (let i = 0; i < bands.length; i++) {
      const b = bands[i]!;
      if (b < 0 || b >= palette.length) continue;
      const col = palette[b]!;
      const o = i * 9;
      positions.push(
        raw[o]!, raw[o + 1]! + 1.6, raw[o + 2]!,
        raw[o + 3]!, raw[o + 4]! + 1.6, raw[o + 5]!,
        raw[o + 6]!, raw[o + 7]! + 1.6, raw[o + 8]!,
      );
      for (let v = 0; v < 3; v++) {
        colors.push(col.r, col.g, col.b);
      }
    }
    if (positions.length >= 9) {
      const surfG = new THREE.BufferGeometry();
      surfG.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      surfG.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      const surfM = new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.52,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const surfMesh = new THREE.Mesh(surfG, surfM);
      surfMesh.renderOrder = 3;
      tactical3dGroup.add(surfMesh);
    }

    // In point mode, draw 3D lines to reachable rocket chairs
    if (field.mode === 'point') {
      for (const row of field.chairRows.slice(0, 8)) {
        if (row.band < 0 || row.path.length < 2) continue;
        const colHex = field.scenario === 'carry'
          ? (row.risk ? 0xef4444 : 0x20d6a0)
          : (row.reachable20s ? 0x38bdf8 : 0xfbbf24);
        tactical3dGroup.add(make3DBeacon(row.pos, colHex, 20));
        const lv: number[] = [];
        for (const p of row.path) lv.push(p.x, p.y + 3.0, p.z);
        const lg = new THREE.BufferGeometry();
        lg.setAttribute('position', new THREE.Float32BufferAttribute(lv, 3));
        tactical3dGroup.add(new THREE.Line(lg, new THREE.LineBasicMaterial({ color: colHex })));
      }
    }
  }

  // 3. Top-5 Hardest-to-Chair Extremum Spots
  if (tac3dExtrema.value.length > 0) {
    for (const spot of tac3dExtrema.value) {
      const colHex = spot.escapes ? 0xef4444 : 0xf97316;
      tactical3dGroup.add(make3DBeacon(spot.pos, colHex, 34));
      const lg = new THREE.BufferGeometry();
      lg.setAttribute(
        'position',
        new THREE.Float32BufferAttribute(
          [
            spot.pos.x, spot.pos.y + 3.5, spot.pos.z,
            spot.nearestChairPos.x, spot.nearestChairPos.y + 3.5, spot.nearestChairPos.z,
          ],
          3,
        ),
      );
      tactical3dGroup.add(
        new THREE.Line(
          lg,
          new THREE.LineBasicMaterial({ color: 0xfde68a, transparent: true, opacity: 0.72 }),
        ),
      );
    }
  }

  markDirty(3);
}

function runTac3DPath(): void {
  if (!navMesh || !tac3dPointA.value || !tac3dPointB.value) {
    tac3dPathResult.value = null;
    rebuildTactical3DOverlay();
    return;
  }
  tac3dPathResult.value = findPath3D(navMesh, tac3dPointA.value, tac3dPointB.value, {
    speedMps: tac3dSpeedMps.value,
    allowVault: tac3dAllowVault.value,
    vaultPenaltySeconds: tac3dVaultPenaltyS.value,
  });
  tac3dPathFollowActive.value = false;
  rebuildTactical3DOverlay();
}

function runTac3DRange(): void {
  if (!navMesh || !tac3dRangeOrigin.value) {
    tac3dRangeResult.value = null;
    rebuildTactical3DOverlay();
    return;
  }
  const chairSetIndex = props.board?.chairIndex ?? 0;
  const basementIndex = props.board?.chairBasementIndex ?? 0;
  if (tac3dRangeScenario.value === 'carry') {
    const profile = createCarryProfile({
      survivorId: props.rangeState?.survivorId ?? CARRY_DEFAULTS.survivorId,
      baseSpeed: props.rangeState?.carryBaseSpeed ?? CARRY_DEFAULTS.baseSpeed,
      initialProgress: props.rangeState?.initialProgress ?? CARRY_DEFAULTS.initialProgress,
      pickupSeconds: props.rangeState?.pickupSeconds ?? CARRY_DEFAULTS.pickupSeconds,
      buffs: (props.rangeState?.carryBuffs ?? []).map(({ key, level }) => ({ key, level })),
    });
    tac3dRangeResult.value = computeCarryField3D(
      navMesh,
      props.mapId,
      tac3dRangeOrigin.value.pos,
      tac3dRangeMode.value,
      profile,
      { chairSetIndex, basementIndex },
    );
  } else {
    const profile = createTideProfile({
      baseSpeed: props.rangeState?.tideBase?.speed ?? 3.8,
      buffs: (props.rangeState?.tideBuffs ?? []).map((b) => ({
        mult: b.mult ?? 1,
        postMult: b.postMult,
        duration: b.duration,
      })),
    });
    tac3dRangeResult.value = computeTideField3D(
      navMesh,
      props.mapId,
      tac3dRangeOrigin.value.pos,
      tac3dRangeMode.value,
      profile,
      { chairSetIndex, basementIndex },
    );
  }
  rebuildTactical3DOverlay();
}

function runTac3DExtrema(): void {
  if (!navMesh) return;
  const profile = createCarryProfile({
    survivorId: props.rangeState?.survivorId ?? CARRY_DEFAULTS.survivorId,
    baseSpeed: props.rangeState?.carryBaseSpeed ?? CARRY_DEFAULTS.baseSpeed,
    initialProgress: props.rangeState?.initialProgress ?? CARRY_DEFAULTS.initialProgress,
    pickupSeconds: props.rangeState?.pickupSeconds ?? CARRY_DEFAULTS.pickupSeconds,
    buffs: (props.rangeState?.carryBuffs ?? []).map(({ key, level }) => ({ key, level })),
  });
  tac3dExtrema.value = computeHardestChairExtrema3D(navMesh, props.mapId, profile, {
    chairSetIndex: props.board?.chairIndex ?? 0,
    basementIndex: props.board?.chairBasementIndex ?? 0,
    topN: 5,
  });
  roaming.statusMsg = `已标出全图 Top ${tac3dExtrema.value.length} 最难挂椅极值点`;
  rebuildTactical3DOverlay();
  syncUiFromController(true);
}

function clearTac3DOverlays(): void {
  tac3dPickSlot.value = null;
  tac3dPointA.value = null;
  tac3dPointB.value = null;
  tac3dPathResult.value = null;
  tac3dRangeOrigin.value = null;
  tac3dRangeResult.value = null;
  tac3dExtrema.value = [];
  tac3dPathFollowActive.value = false;
  rebuildTactical3DOverlay();
}

function syncFrom2DInputs(): void {
  if (!navMesh) return;
  const medY = navMesh.medianFloorY;
  const hintY = props.floor === 'B1' ? medY - 55 : props.floor === '2F' ? medY + 55 : medY;
  let updated = false;
  if (props.routePointA && props.routePointB) {
    const wa = normalizedToWorld3D(props.mapId, props.routePointA.x, props.routePointA.y);
    const wb = normalizedToWorld3D(props.mapId, props.routePointB.x, props.routePointB.y);
    const sa = navMesh.findNearestWalkable(wa.x, wa.z, hintY, 180);
    const sb = navMesh.findNearestWalkable(wb.x, wb.z, hintY, 180);
    if (sa && sb) {
      tac3dPointA.value = { x: sa.x, y: sa.y, z: sa.z };
      tac3dPointB.value = { x: sb.x, y: sb.y, z: sb.z };
      runTac3DPath();
      updated = true;
    }
  }
  if (props.rangeState?.origin) {
    const wo = normalizedToWorld3D(props.mapId, props.rangeState.origin.x, props.rangeState.origin.y);
    const so = navMesh.findNearestWalkable(wo.x, wo.z, hintY, 180);
    if (so) {
      tac3dRangeScenario.value = props.rangeState.scenario;
      tac3dRangeMode.value = props.rangeState.mode;
      tac3dRangeOrigin.value = {
        pos: { x: so.x, y: so.y, z: so.z },
        label: props.rangeState.origin.label,
      };
      runTac3DRange();
      updated = true;
    }
  }
  if (updated) {
    roaming.statusMsg = '已将 2D 选点同步至 3D 沙盘';
    syncUiFromController(true);
  }
}

function handoffCurrentTo2D(): void {
  if (tac3dTab.value === 'route' && tac3dPointA.value && tac3dPointB.value) {
    const na = world3DToNormalized(props.mapId, tac3dPointA.value.x, tac3dPointA.value.z);
    const nb = world3DToNormalized(props.mapId, tac3dPointB.value.x, tac3dPointB.value.z);
    emit('handoff-to-2d', {
      pointA: { x: na.u, y: na.v },
      pointB: { x: nb.u, y: nb.v },
      floor: props.floor,
    });
    return;
  }
  if (tac3dTab.value === 'range' && tac3dRangeOrigin.value) {
    const no = world3DToNormalized(props.mapId, tac3dRangeOrigin.value.pos.x, tac3dRangeOrigin.value.pos.z);
    emit('handoff-to-2d', {
      rangeOrigin: {
        x: no.u,
        y: no.v,
        label: tac3dRangeOrigin.value.label,
        scenario: tac3dRangeScenario.value,
        mode: tac3dRangeMode.value,
      },
      floor: props.floor,
    });
    return;
  }
  if (tac3dTab.value === 'extrema' && tac3dExtrema.value.length > 0) {
    const top = tac3dExtrema.value[0]!;
    emit('handoff-to-2d', {
      rangeOrigin: {
        x: top.relU,
        y: top.relV,
        label: `极值点 #1 (${top.distanceM.toFixed(1)}m)`,
        scenario: 'carry',
        mode: 'point',
      },
      floor: top.floor,
    });
  }
}

function flyTo3DSpot(pos: Vec3Point, label: string): void {
  if (roaming.cameraMode === 'roaming') {
    roaming.teleportTo(pos.x, pos.z, pos.y, navMesh);
    resetCamOcclusionCache();
  } else if (controls && camera) {
    controls.target.set(pos.x, pos.y + 8, pos.z);
    camera.position.set(pos.x + 170, pos.y + 210, pos.z + 170);
    controls.update();
  }
  roaming.statusMsg = `已定位至 ${label}`;
  syncUiFromController(true);
}

function toggleTac3DPathFollow(): void {
  const res = tac3dPathResult.value;
  if (!res?.reachable || res.points.length < 2) return;
  if (tac3dPathFollowActive.value) {
    tac3dPathFollowActive.value = false;
    return;
  }
  tac3dPathFollowDistM = 0;
  tac3dPathFollowActive.value = true;
  if (roaming.cameraMode !== 'roaming') {
    setCameraMode('roaming');
  }
  const first = res.points[0]!;
  roaming.teleportTo(first.x, first.z, first.y, navMesh);
  roaming.statusMsg = '正在沿 3D A→B 路线模拟跑图…';
  syncUiFromController(true);
}

function applyTac3DPickAt(pt: THREE.Vector3): void {
  const slot = tac3dPickSlot.value;
  if (!slot || !navMesh) return;
  const snap = navMesh.findNearestWalkable(pt.x, pt.z, pt.y, 140);
  const picked: Vec3Point = snap ? { x: snap.x, y: snap.y, z: snap.z } : { x: pt.x, y: pt.y, z: pt.z };
  if (slot === 'a') {
    tac3dPointA.value = picked;
    tac3dPickSlot.value = tac3dPointB.value ? null : 'b';
    runTac3DPath();
  } else if (slot === 'b') {
    tac3dPointB.value = picked;
    tac3dPickSlot.value = null;
    runTac3DPath();
  } else if (slot === 'range') {
    if (tac3dRangeMode.value === 'chair') {
      const chairs = collectChairs3D(
        navMesh,
        props.mapId,
        props.board?.chairIndex ?? 0,
        props.board?.chairBasementIndex ?? 0,
        true,
      );
      let best = chairs[0] ?? null;
      let bestD = Infinity;
      for (const ch of chairs) {
        const d = Math.hypot(ch.pos.x - picked.x, ch.pos.y - picked.y, ch.pos.z - picked.z);
        if (d < bestD) {
          bestD = d;
          best = ch;
        }
      }
      tac3dRangeOrigin.value = best
        ? { pos: best.pos, label: best.label }
        : { pos: picked, label: '3D 椅位' };
    } else {
      tac3dRangeOrigin.value = { pos: picked, label: '3D 倒地点' };
    }
    tac3dPickSlot.value = null;
    runTac3DRange();
  }
}

// ---------------------------------------------------------------------------
// Scene Loading Pipeline
// ---------------------------------------------------------------------------
async function loadActiveScene(): Promise<void> {
  const sceneId = activeSceneId.value;
  const gen = ++loadGeneration;

  ui.loading = true;
  ui.ready = false;
  ui.error = null;
  publishWindowState(true);

  if (!scene || !renderer) {
    // Headless / non-WebGL test environment: still publish scene metadata cleanly
    ui.loading = false;
    publishWindowState(true);
    return;
  }

  try {
    await MeshoptDecoder.ready;
    const bundle = await fetchSceneBundle(sceneId, resolveSceneCacheMax(qualityTier.value));
    if (gen !== loadGeneration || !scene || !renderer) return;

    // Dispose previous mapGroup BEFORE calling loader.parseAsync to cut peak dual-scene RAM/VRAM in half
    if (mapGroup) {
      scene.remove(mapGroup);
      disposeObject3D(mapGroup);
      mapGroup = null;
    }
    if (collisionGroup) {
      scene.remove(collisionGroup);
      disposeObject3D(collisionGroup);
      collisionGroup = null;
      collisionAvatarMesh = null;
    }
    raycastTargets = [];
    resetCamOcclusionCache();
    renderer.renderLists.dispose();

    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    const gltf = await loader.parseAsync(bundle.glbBuffer.slice(0), withBaseUrl('/assets/maps-3d/'));
    if (gen !== loadGeneration || !scene) {
      disposeObject3D(gltf.scene);
      return;
    }

    mapGroup = gltf.scene;
    scene.add(mapGroup);
    mapGroup.updateMatrixWorld(true);

    const nextRaycastTargets: THREE.Object3D[] = [];
    // Normalize materials, enforce FrontSide backface culling on opaque meshes, and build BVH on large static meshes
    mapGroup.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh || !mesh.material) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];

      let allOpaque = mats.length > 0;
      for (const m of mats) {
        if (!m) {
          allOpaque = false;
          continue;
        }
        const std = m as THREE.MeshStandardMaterial;
        const isOpaqueMat = !m.transparent && (m.alphaTest ?? 0) === 0;
        if (!isOpaqueMat) {
          allOpaque = false;
        }
        if (isOpaqueMat && m.side !== THREE.FrontSide) {
          // Restore mobile TBDR backface culling on opaque non-transparent architecture & terrain
          m.side = THREE.FrontSide;
          m.needsUpdate = true;
        } else if (
          m.transparent &&
          std &&
          (std.map || std.alphaMap) &&
          (m.opacity ?? 1) > 0.85 &&
          (m.alphaTest ?? 0) === 0
        ) {
          // Discard zero-alpha cutout fringe on foliage cards while preserving DoubleSide & soft alpha
          m.alphaTest = 0.05;
          m.needsUpdate = true;
        }

        if (std && std.isMeshStandardMaterial) {
          // Without an HDRI scene.environment, high metalness reflects pure black and crushes walls/props to dark grey
          if ((std.metalness ?? 0) > 0.14) {
            std.metalness = 0.14;
            std.needsUpdate = true;
          }
          if (!std.map && std.color) {
            const { r, g, b } = std.color;
            // PIL untextured ground/fallback grey ~[0.52, 0.57, 0.58] in linear or sRGB -> warm sage-stone ground
            if (r > 0.2 && r < 0.72 && g > 0.22 && g < 0.76 && b > 0.22 && b < 0.78 && Math.abs(r - b) < 0.14) {
              std.color.setHex(0x526155);
              std.roughness = 0.92;
              std.metalness = 0.0;
              std.needsUpdate = true;
            }
          } else {
            std.roughness = Math.min(Math.max(std.roughness ?? 0.82, 0.62), 0.96);
          }
        }
      }

      const isInstanced = Boolean((mesh as THREE.InstancedMesh).isInstancedMesh);
      if (!isInstanced && allOpaque && mesh.geometry && mesh.geometry.attributes.position) {
        if (!mesh.geometry.boundingBox) {
          mesh.geometry.computeBoundingBox();
        }
        if (mesh.geometry.boundingBox) {
          tmpMeshBox.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld);
          tmpMeshBox.getSize(tmpMeshSize);
          const diag = Math.hypot(tmpMeshSize.x, tmpMeshSize.y, tmpMeshSize.z);
          if (diag >= 8) {
            if (!mesh.geometry.boundsTree) {
              mesh.geometry.computeBoundsTree();
            }
            nextRaycastTargets.push(mesh);
          }
        }
      }
    });
    raycastTargets = nextRaycastTargets;

    applyLightingPreset();

    navMesh = bundle.navMesh;
    ui.navTriangles = navMesh.triangleCount;

    const box = new THREE.Box3().setFromObject(mapGroup);
    const size = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(mapCenter);
    mapMaxDim = Math.max(size.x, size.y, size.z, 400);

    rebuildCollisionOverlay(navMesh);
    applyFloorClipping();
    applyQualityTierSettings();
    placeAvatarAtInitialSpawn();

    if (roaming.cameraMode === 'overview') {
      frameOverviewCamera();
      roaming.statusMsg = '3D 俯瞰 · 拖拽旋转 / 双指缩放 · 可切换模拟跑图';
    } else {
      setCameraMode('roaming');
    }

    lastSyncedStandaloneSig = '';
    rebuildCiphers3D();
    syncReplayAndBoardEntities(true);
    clearTac3DOverlays();
    syncFrom2DInputs();

    ui.loading = false;
    ui.ready = true;
    ui.calls = 0;
    syncUiFromController(true);
  } catch (err) {
    if (gen !== loadGeneration) return;
    ui.loading = false;
    ui.ready = false;
    ui.error = err instanceof Error ? err.message : String(err);
    publishWindowState(true);
  }
}

// ---------------------------------------------------------------------------
// Render & Physics Frame Loop
// ---------------------------------------------------------------------------
const freeFlyForward = new THREE.Vector3();
const freeFlyRight = new THREE.Vector3();
const freeFlyUp = new THREE.Vector3(0, 1, 0);
const freeFlyMove = new THREE.Vector3();

function updateOverviewFreeFly(dt: number): void {
  if (!camera || !controls || roaming.cameraMode !== 'overview') return;
  const input = roaming.getInputVector();
  if (!input.active) return;

  const speedUnits = roaming.effectiveSpeedMps() * UNITS_PER_METER * dt;
  camera.getWorldDirection(freeFlyForward);
  freeFlyForward.y = 0;
  if (freeFlyForward.lengthSq() < 1e-6) freeFlyForward.set(0, 0, -1);
  freeFlyForward.normalize();

  freeFlyRight.crossVectors(freeFlyForward, freeFlyUp).normalize();
  freeFlyMove
    .set(0, 0, 0)
    .addScaledVector(freeFlyForward, input.forward * speedUnits)
    .addScaledVector(freeFlyRight, input.strafe * speedUnits);
  freeFlyMove.y += input.elev * speedUnits * 0.85;

  camera.position.add(freeFlyMove);
  controls.target.add(freeFlyMove);
}

function updateRoamingFrame(dt: number, nowMs: number): void {
  if (!camera || roaming.cameraMode !== 'roaming') return;
  const summary = roaming.step(dt, navMesh);
  const movingNow = summary.movedUnits > 0;
  const sprintChanged =
    roaming.shiftHeld !== ui.shiftHeld || roaming.sprintToggle !== ui.sprintToggle;

  if (movingNow || wasRoamingMoving || sprintChanged) {
    // Publish immediately on roam-start, roam-stop, or sprint toggle; throttle to ~10Hz mid-stride
    const immediate = (movingNow && !wasRoamingMoving) || (!movingNow && wasRoamingMoving) || sprintChanged;
    wasRoamingMoving = movingNow;
    syncUiFromController(immediate);
  }

  // O(1) NavMesh spatial-grid ground lookup — zero full-scene raycasts per frame
  const avatarFloor = navMesh
    ? navMesh.sampleFloor(roaming.avatarPos.x, roaming.avatarPos.z, roaming.avatarPos.y, 40, 80)
    : null;
  const groundY = avatarFloor ? avatarFloor.y : roaming.avatarPos.y;

  if (avatarGroup) {
    avatarGroup.visible = true;
    avatarGroup.position.set(roaming.avatarPos.x, groundY, roaming.avatarPos.z);
    avatarGroup.rotation.y = -roaming.facingYaw;
  }
  if (collisionAvatarMesh && roaming.showCollision) {
    collisionAvatarMesh.position.set(
      roaming.avatarPos.x,
      groundY + 9.75,
      roaming.avatarPos.z,
    );
  }

  const yOffset = groundY - roaming.avatarPos.y;
  const { eye, target } = roaming.computeThirdPersonCamera(15 + yOffset);
  let eyeX = eye.x;
  let eyeY = eye.y + yOffset;
  let eyeZ = eye.z;
  if (navMesh) {
    const camGround = navMesh.sampleFloor(eyeX, eyeZ, groundY, 60, 60);
    if (camGround && eyeY < camGround.y + 10) {
      eyeY = camGround.y + 10;
    }
  }
  if (eyeY < groundY + 8) {
    eyeY = groundY + 8;
  }

  // Camera spring-arm occlusion pull-in throttled to ~30Hz against BVH raycastTargets
  if (raycastTargets.length > 0) {
    camTargetVec.set(target.x, target.y, target.z);
    camEyeVec.set(eyeX, eyeY, eyeZ);
    camDirVec.subVectors(camEyeVec, camTargetVec);
    const desiredDist = camDirVec.length();
    if (desiredDist > 12) {
      camDirVec.divideScalar(desiredDist);
      const poseChanged =
        Number.isNaN(lastCamOccPose.x) ||
        Math.abs(roaming.avatarPos.x - lastCamOccPose.x) > 0.25 ||
        Math.abs(groundY - lastCamOccPose.y) > 0.25 ||
        Math.abs(roaming.avatarPos.z - lastCamOccPose.z) > 0.25 ||
        Math.abs(roaming.cameraYaw - lastCamOccPose.yaw) > 0.004 ||
        Math.abs(roaming.cameraPitch - lastCamOccPose.pitch) > 0.004 ||
        Math.abs(roaming.cameraDistance - lastCamOccPose.dist) > 0.25;

      if (poseChanged && (Number.isNaN(lastCamOccPose.x) || nowMs - lastCamOccTs >= 33)) {
        lastCamOccTs = nowMs;
        lastCamOccPose.x = roaming.avatarPos.x;
        lastCamOccPose.y = groundY;
        lastCamOccPose.z = roaming.avatarPos.z;
        lastCamOccPose.yaw = roaming.cameraYaw;
        lastCamOccPose.pitch = roaming.cameraPitch;
        lastCamOccPose.dist = roaming.cameraDistance;

        camRaycaster.set(camTargetVec, camDirVec);
        camRaycaster.near = 6;
        camRaycaster.far = desiredDist;
        const occluders = camRaycaster.intersectObjects(raycastTargets, false);
        if (occluders.length > 0 && occluders[0]!.distance < desiredDist - 2) {
          cachedSafeDist = Math.max(18, occluders[0]!.distance - 4);
        } else {
          cachedSafeDist = null;
        }
      }

      if (cachedSafeDist !== null && cachedSafeDist < desiredDist) {
        camEyeVec.copy(camTargetVec).addScaledVector(camDirVec, cachedSafeDist);
        eyeX = camEyeVec.x;
        eyeY = Math.max(camEyeVec.y, groundY + 12);
        eyeZ = camEyeVec.z;
      }
    }
  }

  if (camera.near > 1.0) {
    camera.near = 0.8;
    camera.updateProjectionMatrix();
  }
  camera.position.set(eyeX, eyeY, eyeZ);
  camera.lookAt(target.x, target.y, target.z);
}

function renderTick(now: number): void {
  rafId = requestAnimationFrame(renderTick);
  if (!renderer || !scene || !camera || ui.contextLost) return;

  const rawDtMs = lastFrameTs > 0 ? now - lastFrameTs : 16.67;
  const dt = lastFrameTs > 0 ? Math.min(0.1, Math.max(0, rawDtMs / 1000)) : 1 / 60;
  lastFrameTs = now;

  const inputActive = roaming.getInputVector().active || tac3dPathFollowActive.value;
  if (inputActive || pointerDragging) {
    markDirty(4);
  }

  // Advance P1 3D A->B path playback along solved polyline when active
  if (tac3dPathFollowActive.value && tac3dPathResult.value?.reachable && tac3dPathResult.value.points.length >= 2) {
    const pts = tac3dPathResult.value.points;
    tac3dPathFollowDistM += tac3dSpeedMps.value * dt;
    let rem = tac3dPathFollowDistM;
    let finished = true;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]!;
      const b = pts[i]!;
      const segM = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) / UNITS_PER_METER;
      if (segM > 1e-4 && rem <= segM) {
        const ratio = rem / segM;
        const nx = a.x + (b.x - a.x) * ratio;
        const ny = a.y + (b.y - a.y) * ratio;
        const nz = a.z + (b.z - a.z) * ratio;
        roaming.avatarPos.x = nx;
        roaming.avatarPos.y = ny;
        roaming.avatarPos.z = nz;
        roaming.facingYaw = Math.atan2(b.x - a.x, -(b.z - a.z));
        roaming.cameraYaw = roaming.facingYaw;
        finished = false;
        break;
      }
      rem -= segM;
    }
    if (finished) {
      const last = pts[pts.length - 1]!;
      roaming.teleportTo(last.x, last.z, last.y, navMesh);
      tac3dPathFollowActive.value = false;
      roaming.statusMsg = '3D A→B 路线模拟播放完成';
      syncUiFromController(true);
    }
  }

  let cameraChanged = false;
  if (roaming.cameraMode === 'overview') {
    if (inputActive) {
      updateOverviewFreeFly(dt);
      cameraChanged = true;
    }
    if (dirtyFrames > 0 && controls?.update()) {
      cameraChanged = true;
    }
  } else if (dirtyFrames > 0 || inputActive || pointerDragging || wasRoamingMoving) {
    updateRoamingFrame(dt, now);
    cameraChanged = true;
  }

  if (dirtyFrames <= 0 && !cameraChanged) {
    return;
  }
  dirtyFrames = Math.max(0, dirtyFrames - 1);

  // Adaptive EMA frame-time scaler on mobile tier (steps pixelRatio cap 1.5 -> 1.0 if EMA > 22ms)
  if (qualityTier.value === 'mobile' && rawDtMs > 0 && rawDtMs < 100) {
    frameTimeEmaMs = frameTimeEmaMs * 0.88 + rawDtMs * 0.12;
    if (frameTimeEmaMs > 22 && mobileAdaptivePixelRatioCap > 1.0) {
      mobileAdaptivePixelRatioCap = 1.0;
      applyQualityTierSettings();
    }
  }

  renderer.render(scene, camera);

  const firstRenderAfterLoad = ui.ready && ui.calls === 0 && renderer.info.render.calls > 0;
  ui.calls = renderer.info.render.calls;
  ui.triangles = renderer.info.render.triangles;
  publishWindowState(firstRenderAfterLoad);
}

// ---------------------------------------------------------------------------
// Input Handlers (Keyboard, Multi-Touch Orbit/Pinch, Virtual Joystick, D-Pad)
// ---------------------------------------------------------------------------
function isTextInputFocused(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || el.isContentEditable;
}

function onWindowKeyDown(e: KeyboardEvent): void {
  if (isTextInputFocused(e.target)) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  if (e.key === 'Escape' && roaming.teleportArmed) {
    roaming.teleportArmed = false;
    roaming.statusMsg = '已取消点地传送';
    syncUiFromController(true);
    return;
  }

  const handled = roaming.setKey(e.code || e.key, true);
  if (handled) {
    ui.shiftHeld = roaming.shiftHeld;
    ui.sprintActive = roaming.shiftHeld || roaming.sprintToggle;
    markDirty(4);
    if (
      e.key === 'ArrowUp' ||
      e.key === 'ArrowDown' ||
      e.key === 'ArrowLeft' ||
      e.key === 'ArrowRight'
    ) {
      e.preventDefault();
    }
  }
}

function onWindowKeyUp(e: KeyboardEvent): void {
  const handled = roaming.setKey(e.code || e.key, false);
  if (handled) {
    ui.shiftHeld = roaming.shiftHeld;
    ui.sprintActive = roaming.shiftHeld || roaming.sprintToggle;
  }
}

function onWindowBlur(): void {
  roaming.clearKeys();
  joystickPointerId = null;
  joystickUi.active = false;
  joystickUi.dx = 0;
  joystickUi.dy = 0;
  surfacePointers.clear();
  pointerDragging = false;
  syncUiFromController(true);
}

function raycastGroundHit(clientX: number, clientY: number): THREE.Vector3 | null {
  if (!renderer || !camera || !mapGroup) return null;
  const rect = renderer.domElement.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  ndcVec.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  ndcVec.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(ndcVec, camera);
  if (raycastTargets.length > 0) {
    const hits = raycaster.intersectObjects(raycastTargets, false);
    if (hits.length > 0) return hits[0]!.point;
  }
  const fallbackHits = raycaster.intersectObject(mapGroup, true);
  return fallbackHits.length > 0 ? fallbackHits[0]!.point : null;
}

function onCanvasPointerDown(e: PointerEvent): void {
  if (tac3dPickSlot.value) {
    overviewPickDownPos = { x: e.clientX, y: e.clientY };
  }
  if (roaming.cameraMode !== 'roaming') return;
  if (surfacePointers.size === 0) {
    gestureHadMultiTouch = false;
    primaryDownPos = { x: e.clientX, y: e.clientY };
    primaryMovedDist = 0;
  }
  surfacePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  pointerDragging = surfacePointers.size > 0;
  (e.currentTarget as HTMLElement | null)?.setPointerCapture?.(e.pointerId);

  if (surfacePointers.size >= 2) {
    gestureHadMultiTouch = true;
    const pts = Array.from(surfacePointers.values());
    lastPinchDist = Math.hypot(pts[1]!.x - pts[0]!.x, pts[1]!.y - pts[0]!.y);
  }
}

function onCanvasPointerMove(e: PointerEvent): void {
  if (roaming.cameraMode !== 'roaming') return;
  const prev = surfacePointers.get(e.pointerId);
  if (!prev) return;

  const dx = e.clientX - prev.x;
  const dy = e.clientY - prev.y;
  prev.x = e.clientX;
  prev.y = e.clientY;

  if (surfacePointers.size === 1) {
    primaryMovedDist += Math.hypot(dx, dy);
    roaming.orbitCamera(dx * 0.0055, dy * 0.0045);
    markDirty(4);
  } else if (surfacePointers.size >= 2) {
    const pts = Array.from(surfacePointers.values());
    const dist = Math.hypot(pts[1]!.x - pts[0]!.x, pts[1]!.y - pts[0]!.y);
    if (lastPinchDist > 1) {
      roaming.zoomCamera((lastPinchDist - dist) * 0.32);
      markDirty(4);
    }
    lastPinchDist = dist;
  }
}

function onCanvasPointerUp(e: PointerEvent): void {
  if (tac3dPickSlot.value && overviewPickDownPos) {
    const d = Math.hypot(e.clientX - overviewPickDownPos.x, e.clientY - overviewPickDownPos.y);
    overviewPickDownPos = null;
    if (d < 10 && (e.button === 0 || e.pointerType === 'touch')) {
      const pt = raycastGroundHit(e.clientX, e.clientY);
      if (pt) {
        applyTac3DPickAt(pt);
        return;
      }
    }
  }
  if (!surfacePointers.has(e.pointerId)) return;
  surfacePointers.delete(e.pointerId);
  (e.currentTarget as HTMLElement | null)?.releasePointerCapture?.(e.pointerId);

  if (surfacePointers.size >= 2) {
    const pts = Array.from(surfacePointers.values());
    lastPinchDist = Math.hypot(pts[1]!.x - pts[0]!.x, pts[1]!.y - pts[0]!.y);
  } else {
    lastPinchDist = 0;
  }
  pointerDragging = surfacePointers.size > 0;

  if (surfacePointers.size === 0) {
    const tapDist = Math.max(
      primaryMovedDist,
      Math.hypot(e.clientX - primaryDownPos.x, e.clientY - primaryDownPos.y),
    );
    const wasTap = !gestureHadMultiTouch && tapDist < 12;
    if (
      wasTap &&
      roaming.cameraMode === 'roaming' &&
      roaming.teleportArmed &&
      (e.button === 0 || e.pointerType === 'touch')
    ) {
      const pt = raycastGroundHit(e.clientX, e.clientY);
      if (pt) {
        roaming.teleportTo(pt.x, pt.z, pt.y, navMesh);
        roaming.teleportArmed = false;
        resetCamOcclusionCache();
        syncUiFromController(true);
      }
    }
  }
}

function onCanvasWheel(e: WheelEvent): void {
  if (roaming.cameraMode !== 'roaming') return;
  e.preventDefault();
  roaming.zoomCamera(e.deltaY * 0.08);
  markDirty(3);
}

function onCanvasDblClick(e: MouseEvent): void {
  const pt = raycastGroundHit(e.clientX, e.clientY);
  if (pt) {
    roaming.teleportTo(pt.x, pt.z, pt.y, navMesh);
    resetCamOcclusionCache();
  }
  if (roaming.cameraMode !== 'roaming') {
    setCameraMode('roaming');
  } else {
    syncUiFromController(true);
  }
}

// Virtual Analog Thumbstick Handlers
function updateJoystickFromClient(clientX: number, clientY: number): void {
  const rawDx = clientX - joystickCenter.x;
  const rawDy = clientY - joystickCenter.y;
  const dist = Math.hypot(rawDx, rawDy);
  const clampedDist = Math.min(dist, JOYSTICK_MAX_RADIUS);
  const angle = dist > 1e-4 ? Math.atan2(rawDy, rawDx) : 0;

  joystickUi.dx = Math.cos(angle) * clampedDist;
  joystickUi.dy = Math.sin(angle) * clampedDist;

  const normRatio = clampedDist / JOYSTICK_MAX_RADIUS;
  if (normRatio < 0.08) {
    roaming.setAnalogStick(0, 0);
    return;
  }
  const scaledMag = (normRatio - 0.08) / 0.92;
  const strafe = Math.cos(angle) * scaledMag;
  const forward = -Math.sin(angle) * scaledMag;
  roaming.setAnalogStick(forward, strafe);
  markDirty(4);
}

function onJoystickPointerDown(e: PointerEvent): void {
  if (joystickPointerId !== null) return;
  const el = (e.currentTarget as HTMLElement | null) ?? joystickEl.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  joystickCenter = {
    x: rect.width > 0 ? rect.left + rect.width / 2 : e.clientX,
    y: rect.height > 0 ? rect.top + rect.height / 2 : e.clientY,
  };
  joystickPointerId = e.pointerId;
  joystickUi.active = true;
  el.setPointerCapture?.(e.pointerId);
  updateJoystickFromClient(e.clientX, e.clientY);
}

function onJoystickPointerMove(e: PointerEvent): void {
  if (e.pointerId !== joystickPointerId) return;
  updateJoystickFromClient(e.clientX, e.clientY);
}

function onJoystickPointerUp(e: PointerEvent): void {
  if (e.pointerId !== joystickPointerId) return;
  const el = (e.currentTarget as HTMLElement | null) ?? joystickEl.value;
  el?.releasePointerCapture?.(e.pointerId);
  joystickPointerId = null;
  joystickUi.active = false;
  joystickUi.dx = 0;
  joystickUi.dy = 0;
  roaming.setAnalogStick(0, 0);
}

// ---------------------------------------------------------------------------
// HUD Control Actions
// ---------------------------------------------------------------------------
function toggleNightVariant(): void {
  if (!supportsNight.value) return;
  nightMode.value = !nightMode.value;
}

function toggleCollisionOverlay(): void {
  roaming.showCollision = !roaming.showCollision;
  if (collisionGroup) {
    collisionGroup.visible = roaming.showCollision;
  }
  roaming.statusMsg = roaming.showCollision ? '已开启 3D 导航碰撞网格显示' : '已隐藏 3D 导航碰撞网格';
  syncUiFromController(true);
}

function toggleTeleportArmed(): void {
  roaming.teleportArmed = !roaming.teleportArmed;
  roaming.statusMsg = roaming.teleportArmed
    ? '点地传送已就绪 · 单击地面即可瞬移人物'
    : '已退出点地传送';
  syncUiFromController(true);
}

function handleToggleSprint(): void {
  roaming.toggleSprint();
  syncUiFromController(true);
}

function onPresetSelect(e: Event): void {
  const val = (e.target as HTMLSelectElement).value;
  if (val === 'custom') {
    roaming.setCustomSpeed(roaming.speedMps);
  } else {
    roaming.setSpeedPreset(val as RoamSpeedPresetId);
  }
  syncUiFromController(true);
  updateAvatarColors();
  markDirty(2);
}

function onSpeedSliderInput(e: Event): void {
  const val = Number((e.target as HTMLInputElement).value);
  roaming.setCustomSpeed(val);
  syncUiFromController(true);
  updateAvatarColors();
  markDirty(2);
}

function resetTelemetryStats(): void {
  roaming.resetTelemetry();
  syncUiFromController(true);
}

function handleDpad(dir: DpadDirection, pressed: boolean, ev?: PointerEvent): void {
  if (ev && pressed) {
    ev.preventDefault();
  }
  roaming.setDpad(dir, pressed);
  markDirty(4);
}

// ---------------------------------------------------------------------------
// WebGL Context Loss Recovery & Lifecycle
// ---------------------------------------------------------------------------
function onWebGLContextLost(e: Event): void {
  e.preventDefault();
  ui.contextLost = true;
  ui.ready = false;
  roaming.statusMsg = 'WebGL 显存上下文已丢失，正在自动恢复…';
  publishWindowState(true);
}

function onWebGLContextRestored(): void {
  ui.contextLost = false;
  roaming.statusMsg = 'WebGL 已恢复，正在重建 3D 场景…';
  void loadActiveScene();
}

function updateRendererSize(): void {
  if (!rootEl.value || !renderer || !camera) return;
  const w = Math.max(1, rootEl.value.clientWidth);
  const h = Math.max(1, rootEl.value.clientHeight);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  markDirty(2);
}

onMounted(() => {
  publishWindowState(true);

  window.addEventListener('keydown', onWindowKeyDown);
  window.addEventListener('keyup', onWindowKeyUp);
  window.addEventListener('blur', onWindowBlur);

  const isJsdom =
    typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent || '');

  if (canvasHostEl.value && !isJsdom) {
    try {
      const startMobile = qualityTier.value === 'mobile';
      renderer = new THREE.WebGLRenderer({
        antialias: !startMobile,
        powerPreference: 'high-performance',
      });
      const dpr = window.devicePixelRatio || 1;
      renderer.setPixelRatio(Math.min(dpr, startMobile ? 1.5 : 2));
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.3;
      renderer.domElement.className = 'webgl-3d-surface';
      renderer.domElement.addEventListener('webglcontextlost', onWebGLContextLost, false);
      renderer.domElement.addEventListener('webglcontextrestored', onWebGLContextRestored, false);
      canvasHostEl.value.appendChild(renderer.domElement);

      scene = new THREE.Scene();
      scene.background = new THREE.Color(0x22303c);

      hemiLight = new THREE.HemisphereLight(0xf2f7ff, 0x6c6154, 2.65);
      scene.add(hemiLight);

      sunLight = new THREE.DirectionalLight(0xfff2dc, 3.35);
      sunLight.position.set(-220, 520, 320);
      scene.add(sunLight);

      rimLight = new THREE.DirectionalLight(0xd6e8ff, 1.35);
      rimLight.position.set(360, 250, -120);
      scene.add(rimLight);
      applyLightingPreset();

      camera = new THREE.PerspectiveCamera(46, 16 / 9, 2, 18000);
      controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.screenSpacePanning = false;
      controls.maxPolarAngle = Math.PI * 0.492;
      controls.addEventListener('change', () => markDirty(18));

      replayBeaconsGroup = new THREE.Group();
      boardPinsGroup = new THREE.Group();
      ciphersGroup = new THREE.Group();
      tactical3dGroup = new THREE.Group();
      avatarGroup = buildAvatarGroup();
      scene.add(ciphersGroup);
      scene.add(replayBeaconsGroup);
      scene.add(boardPinsGroup);
      scene.add(tactical3dGroup);
      scene.add(avatarGroup);

      updateRendererSize();
      if (typeof ResizeObserver !== 'undefined' && rootEl.value) {
        resizeObserver = new ResizeObserver(() => updateRendererSize());
        resizeObserver.observe(rootEl.value);
      }

      if (typeof requestAnimationFrame === 'function') {
        rafId = requestAnimationFrame(renderTick);
      }
    } catch (err) {
      ui.loading = false;
      ui.ready = false;
      ui.error = err instanceof Error ? err.message : '当前环境未启用 WebGL 3D 渲染';
      publishWindowState(true);
    }
  }

  void loadActiveScene();
});

onBeforeUnmount(() => {
  loadGeneration++;
  if (rafId !== null && typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  resizeObserver?.disconnect();
  resizeObserver = null;

  window.removeEventListener('keydown', onWindowKeyDown);
  window.removeEventListener('keyup', onWindowKeyUp);
  window.removeEventListener('blur', onWindowBlur);
  roaming.clearKeys();
  surfacePointers.clear();

  controls?.dispose();
  controls = null;

  playerBeaconPool.clear();
  raycastTargets = [];

  if (scene) {
    disposeObject3D(scene);
    scene.clear();
    scene = null;
  }
  mapGroup = null;
  collisionGroup = null;
  collisionAvatarMesh = null;
  avatarGroup = null;
  replayBeaconsGroup = null;
  boardPinsGroup = null;
  ciphersGroup = null;
  tactical3dGroup = null;
  hemiLight = null;
  sunLight = null;
  rimLight = null;

  if (renderer) {
    renderer.domElement.removeEventListener('webglcontextlost', onWebGLContextLost, false);
    renderer.domElement.removeEventListener('webglcontextrestored', onWebGLContextRestored, false);
    renderer.dispose();
    renderer.domElement.remove();
    renderer = null;
  }
  camera = null;
});

watch(
  () => props.mapId,
  (nextId) => {
    if (!hasNightVariant(nextId)) {
      nightMode.value = false;
    }
  },
);

watch(activeSceneId, () => {
  void loadActiveScene();
});

watch(
  () => props.floor,
  () => {
    applyFloorClipping();
  },
);

// Shallow watcher + 10Hz (0.08s) time quantization — zero deep traversal of Replay2DPayload!
let lastSyncNonTimeKey = '';
let lastSyncT = -Infinity;

watch(
  [
    () => props.payload,
    () => props.t,
    () => props.animTime,
    () => props.selectedUid,
    () => props.followUid,
    () => props.isStandalone,
    () => props.board?.tokens?.length,
    () => buildStandaloneTokensSig(),
  ],
  () => {
    if (!ui.ready) return;
    const curT = props.isStandalone ? (props.animTime ?? 0) : (props.t ?? 0);
    const nonTimeKey = `${props.payload?.match.match_id ?? 'none'}|${props.isStandalone ? 1 : 0}|${props.selectedUid ?? ''}|${props.followUid ?? ''}|${props.board?.tokens?.length ?? 0}|${buildStandaloneTokensSig()}`;
    const nonTimeChanged = nonTimeKey !== lastSyncNonTimeKey;
    if (!nonTimeChanged && Math.abs(curT - lastSyncT) < 0.04 && curT !== 0) {
      return;
    }
    lastSyncNonTimeKey = nonTimeKey;
    lastSyncT = curT;
    syncReplayAndBoardEntities(nonTimeChanged);
  },
);

watch(
  [
    () => props.payload?.match.match_id,
    () => props.isStandalone,
    () => props.landmarks?.ciphers,
    () => props.cipherGroupIndex,
    () => props.board?.cipherProgressEnabled,
    () => JSON.stringify(props.board?.cipherProgress ?? {}),
  ],
  () => {
    if (ui.ready) {
      rebuildCiphers3D();
    }
  },
);

defineExpose({
  resetView,
  setCameraMode,
});
</script>

<template>
  <div
    ref="rootEl"
    class="canvas-3d-wrap"
    :class="{ 'is-standalone': isStandalone, 'is-hud-expanded': hudExpanded }"
    data-test="tactical-3d-canvas"
  >
    <div
      ref="canvasHostEl"
      class="canvas-3d-surface"
      :class="{ 'cursor-teleport': (ui.cameraMode === 'roaming' && ui.teleportArmed) || tac3dPickSlot !== null }"
      @pointerdown="onCanvasPointerDown"
      @pointermove="onCanvasPointerMove"
      @pointerup="onCanvasPointerUp"
      @pointercancel="onCanvasPointerUp"
      @lostpointercapture="onCanvasPointerUp"
      @wheel="onCanvasWheel"
      @dblclick="onCanvasDblClick"
      @contextmenu.prevent
    />

    <!-- Top-left Manor Ebony-Brass 3D Camera & Scene Bar -->
    <div class="hud-3d-topbar" role="toolbar" aria-label="3D 视角与跑图控制">
      <div class="seg hud-3d-seg">
        <button
          type="button"
          class="hud-3d-btn"
          :class="{ on: ui.cameraMode === 'overview' }"
          :aria-pressed="ui.cameraMode === 'overview'"
          data-test="btn-3d-overview"
          @click="setCameraMode('overview')"
        >
          俯瞰视角
        </button>
        <button
          type="button"
          class="hud-3d-btn"
          :class="{ on: ui.cameraMode === 'roaming' }"
          :aria-pressed="ui.cameraMode === 'roaming'"
          data-test="btn-3d-roam"
          @click="setCameraMode('roaming')"
        >
          模拟跑图
        </button>
      </div>

      <button
        type="button"
        class="hud-3d-pill"
        :class="{ on: qualityTier === 'desktop' }"
        :aria-pressed="qualityTier === 'desktop'"
        data-test="btn-3d-quality"
        :title="qualityTier === 'mobile' ? '当前：流畅档（点击切换高清）' : '当前：高清档（点击切换流畅）'"
        @click="toggleQualityTier"
      >
        {{ qualityTier === 'mobile' ? '流畅' : '高清' }}
      </button>

      <button
        type="button"
        class="hud-3d-pill"
        :class="{ on: lightingMode === 'bright' }"
        :aria-pressed="lightingMode === 'bright'"
        data-test="btn-3d-light"
        :title="lightingMode === 'bright' ? '当前：明亮日光（点击切换暮色氛围）' : '当前：庄园暮色（点击切换明亮日光）'"
        @click="toggleLightingMode"
      >
        {{ lightingMode === 'bright' ? '☀ 明亮' : '☾ 暮色' }}
      </button>

      <button
        v-if="supportsNight"
        type="button"
        class="hud-3d-pill"
        :class="{ on: nightMode }"
        :aria-pressed="nightMode"
        data-test="btn-3d-night"
        title="切换红教堂昼/夜 3D 场景"
        @click="toggleNightVariant"
      >
        {{ nightMode ? '夜 · 红教堂' : '昼 / 夜' }}
      </button>

      <button
        type="button"
        class="hud-3d-pill"
        :class="{ on: tac3dOpen }"
        :aria-pressed="tac3dOpen"
        data-test="btn-3d-tactical"
        title="展开 3D A→B 寻路、挂椅/搏命色带与极值点推演"
        @click="tac3dOpen = !tac3dOpen"
      >
        战术推演
      </button>

      <button
        type="button"
        class="hud-3d-pill"
        data-test="btn-3d-reset"
        title="复位 3D 相机与起点"
        @click="resetView"
      >
        复位视角
      </button>

      <button
        type="button"
        class="hud-3d-pill"
        :class="{ on: ui.showCollision }"
        :aria-pressed="ui.showCollision"
        data-test="btn-roam-collision"
        title="显示或隐藏 3D 通行碰撞导航网格"
        @click="toggleCollisionOverlay"
      >
        导航网
      </button>

      <button
        v-if="ui.cameraMode === 'roaming'"
        type="button"
        class="hud-3d-pill"
        :class="{ on: ui.teleportArmed }"
        :aria-pressed="ui.teleportArmed"
        data-test="btn-roam-teleport"
        title="单击地面将漫游人物传送至该位置"
        @click="toggleTeleportArmed"
      >
        点地传送
      </button>
    </div>

    <!-- Top-right subtle status readout -->
    <div v-if="ui.ready && !ui.loading && !ui.contextLost" class="hud-3d-status">
      <span class="scene-tag">{{ activeSceneLabel }}</span>
      <span class="sep">·</span>
      <span>{{ ui.statusMsg }}</span>
      <span v-if="ui.sprintActive" class="boost-tag">×3 疾跑</span>
    </div>

    <!-- Center Manor Brass Context-Loss / Loading / Error Badge -->
    <div v-if="ui.contextLost" class="hud-3d-center-card" data-test="scene3d-context-lost">
      <span class="brass-spinner" aria-hidden="true" />
      <div class="card-lines">
        <strong>正在恢复 3D 渲染上下文…</strong>
        <span>显存回收后正在自动重建庄园沙盘</span>
      </div>
    </div>

    <div v-else-if="ui.loading" class="hud-3d-center-card" data-test="scene3d-loading">
      <span class="brass-spinner" aria-hidden="true" />
      <div class="card-lines">
        <strong>正在展开 {{ activeSceneLabel }} 3D 实景沙盘…</strong>
        <span>载入本地轻量化建筑网格与多层通行面</span>
      </div>
    </div>

    <div v-else-if="ui.error" class="hud-3d-center-card is-error" data-test="scene3d-error">
      <div class="card-lines">
        <strong>3D 场景暂不可用</strong>
        <span>{{ ui.error }}</span>
      </div>
    </div>

    <!-- P1 Floating 3D Tactical Deduction Dock (A->B Routing, Carry/Tide 3D Bands, Hardest-Chair Extrema, 2D<->3D Handoff) -->
    <aside
      v-if="tac3dOpen && ui.ready"
      class="hud-3d-tac-dock"
      data-test="hud-3d-tactical-dock"
      aria-label="3D 战术推演面板"
    >
      <div class="tac3d-tabs">
        <button type="button" class="hud-3d-btn" :class="{ on: tac3dTab === 'route' }" data-test="tac3d-tab-route" @click="tac3dTab = 'route'">A→B 寻路</button>
        <button type="button" class="hud-3d-btn" :class="{ on: tac3dTab === 'range' }" data-test="tac3d-tab-range" @click="tac3dTab = 'range'">挂椅/搏命</button>
        <button type="button" class="hud-3d-btn" :class="{ on: tac3dTab === 'extrema' }" data-test="tac3d-tab-extrema" @click="tac3dTab = 'extrema'">极值点</button>
      </div>

      <!-- Tab 1: 3D A->B Pathfinding -->
      <div v-if="tac3dTab === 'route'" class="tac3d-body">
        <div class="tac3d-row">
          <button type="button" class="hud-3d-pill compact" :class="{ on: tac3dPickSlot === 'a' }" data-test="btn-tac3d-pick-a" @click="tac3dPickSlot = tac3dPickSlot === 'a' ? null : 'a'">
            {{ tac3dPickSlot === 'a' ? '点地面设 A…' : tac3dPointA ? '重设起点 A' : '选起点 A' }}
          </button>
          <button type="button" class="hud-3d-pill compact" :class="{ on: tac3dPickSlot === 'b' }" data-test="btn-tac3d-pick-b" @click="tac3dPickSlot = tac3dPickSlot === 'b' ? null : 'b'">
            {{ tac3dPickSlot === 'b' ? '点地面设 B…' : tac3dPointB ? '重设终点 B' : '选终点 B' }}
          </button>
        </div>
        <div class="tac3d-row">
          <select v-model.number="tac3dSpeedMps" class="sel roam-select" data-test="tac3d-speed" @change="runTac3DPath">
            <option :value="3.8">求生跑 · 3.80 m/s</option>
            <option :value="4.64">监管标准 · 4.64 m/s</option>
            <option :value="3.2">牵气球 · 3.20 m/s</option>
            <option :value="5.4">歌剧影跃 · 5.40 m/s</option>
          </select>
          <label class="tac3d-chk">
            <input v-model="tac3dAllowVault" type="checkbox" @change="runTac3DPath" />
            翻窗 (+{{ tac3dVaultPenaltyS.toFixed(1) }}s)
          </label>
        </div>
        <div v-if="tac3dPathResult" class="tac3d-summary" data-test="tac3d-path-result">
          <template v-if="tac3dPathResult.reachable">
            <b>{{ tac3dPathResult.distanceM.toFixed(1) }} m</b> ·
            <b class="gold">{{ tac3dPathResult.totalTimeS.toFixed(2) }} s</b>
            <span>（翻窗 {{ tac3dPathResult.vaultCount }} 次 · {{ tac3dPathResult.floors.join('/') }}）</span>
          </template>
          <span v-else>两点间无可达 3D 路线</span>
        </div>
        <div class="tac3d-row">
          <button
            type="button"
            class="hud-3d-pill compact"
            :class="{ on: tac3dPathFollowActive }"
            :disabled="!tac3dPathResult?.reachable"
            data-test="btn-tac3d-follow-path"
            @click="toggleTac3DPathFollow"
          >
            {{ tac3dPathFollowActive ? '⏹ 停止' : '▶ 沿线跑图' }}
          </button>
          <button type="button" class="hud-3d-pill compact" data-test="btn-tac3d-sync-from-2d" @click="syncFrom2DInputs">同步 2D</button>
          <button type="button" class="hud-3d-pill compact" :disabled="!tac3dPointA || !tac3dPointB" data-test="btn-tac3d-to-2d" @click="handoffCurrentTo2D">同步回 2D</button>
          <button type="button" class="hud-3d-pill compact" @click="clearTac3DOverlays">清除</button>
        </div>
      </div>

      <!-- Tab 2: 3D Carry / Tide 5-Band Surface Field -->
      <div v-else-if="tac3dTab === 'range'" class="tac3d-body">
        <div class="tac3d-row">
          <button type="button" class="hud-3d-pill compact" :class="{ on: tac3dRangeScenario === 'carry' }" data-test="btn-tac3d-carry" @click="tac3dRangeScenario = 'carry'; runTac3DRange()">牵气球-上椅</button>
          <button type="button" class="hud-3d-pill compact" :class="{ on: tac3dRangeScenario === 'tide' }" data-test="btn-tac3d-tide" @click="tac3dRangeScenario = 'tide'; runTac3DRange()">搏命 20s</button>
        </div>
        <div class="tac3d-row">
          <button type="button" class="hud-3d-pill compact" :class="{ on: tac3dRangeMode === 'chair' }" @click="tac3dRangeMode = 'chair'; runTac3DRange()">选椅铺色带</button>
          <button type="button" class="hud-3d-pill compact" :class="{ on: tac3dRangeMode === 'point' }" @click="tac3dRangeMode = 'point'; runTac3DRange()">选点看可挂椅</button>
        </div>
        <div class="tac3d-row">
          <button type="button" class="hud-3d-pill compact" :class="{ on: tac3dPickSlot === 'range' }" data-test="btn-tac3d-pick-range" @click="tac3dPickSlot = tac3dPickSlot === 'range' ? null : 'range'">
            {{ tac3dPickSlot === 'range' ? '点地面/椅位…' : tac3dRangeOrigin ? `重选 (${tac3dRangeOrigin.label})` : '点 3D 地图选点' }}
          </button>
          <button type="button" class="hud-3d-pill compact" :disabled="!tac3dRangeOrigin" data-test="btn-tac3d-range-to-2d" @click="handoffCurrentTo2D">同步回 2D</button>
          <button type="button" class="hud-3d-pill compact" @click="clearTac3DOverlays">清除</button>
        </div>
        <p v-if="tac3dRangeResult" class="tac3d-summary" data-test="tac3d-range-summary">{{ tac3dRangeResult.summaryText }}</p>
        <div v-if="tac3dRangeResult?.mode === 'point' && tac3dRangeResult.chairRows.length" class="tac3d-list">
          <button
            v-for="row in tac3dRangeResult.chairRows.slice(0, 6)"
            :key="row.index"
            type="button"
            class="tac3d-list-row"
            @click="flyTo3DSpot(row.pos, row.label)"
          >
            <span>{{ row.label }} ({{ row.floor }})</span>
            <span class="num">{{ Number.isFinite(row.travelSeconds) ? `${row.travelSeconds.toFixed(1)}s` : '不可达' }}</span>
          </button>
        </div>
      </div>

      <!-- Tab 3: 3D Hardest-to-Chair Extremum Spots -->
      <div v-else class="tac3d-body">
        <div class="tac3d-row">
          <button type="button" class="hud-3d-pill compact on" data-test="btn-tac3d-calc-extrema" @click="runTac3DExtrema">
            计算全图最难挂椅 Top 5
          </button>
          <button type="button" class="hud-3d-pill compact" :disabled="!tac3dExtrema.length" @click="handoffCurrentTo2D">同步 #1 回 2D</button>
          <button type="button" class="hud-3d-pill compact" @click="clearTac3DOverlays">清除</button>
        </div>
        <div v-if="tac3dExtrema.length" class="tac3d-list" data-test="tac3d-extrema-list">
          <button
            v-for="spot in tac3dExtrema"
            :key="spot.rank"
            type="button"
            class="tac3d-list-row"
            @click="flyTo3DSpot(spot.pos, `极值点 #${spot.rank}`)"
          >
            <span>#{{ spot.rank }} · {{ spot.floor }} · 最近 {{ spot.nearestChairLabel }}</span>
            <span class="num" :class="spot.escapes ? 'danger-txt' : 'gold'">
              {{ spot.distanceM.toFixed(1) }}m / {{ spot.hangSeconds.toFixed(1) }}s{{ spot.escapes ? ' 挣脱' : '' }}
            </span>
          </button>
        </div>
        <p v-else class="tac3d-summary">基于 3D 多层导航网全图多源计算最难挂上椅子的倒地点</p>
      </div>
    </aside>

    <!-- Bottom-left Floating Virtual Analog Thumbstick (116x116px brass-ring touch zone) -->
    <div
      v-if="ui.cameraMode === 'roaming'"
      ref="joystickEl"
      class="hud-3d-joystick"
      :class="{ active: joystickUi.active }"
      data-test="roam-joystick"
      role="group"
      aria-label="虚拟摇杆移动控制"
      @pointerdown.stop.prevent="onJoystickPointerDown"
      @pointermove.stop.prevent="onJoystickPointerMove"
      @pointerup.stop="onJoystickPointerUp"
      @pointercancel.stop="onJoystickPointerUp"
      @lostpointercapture="onJoystickPointerUp"
    >
      <div class="joystick-ring" aria-hidden="true">
        <span
          class="joystick-knob"
          :style="{ transform: `translate3d(${joystickUi.dx.toFixed(1)}px, ${joystickUi.dy.toFixed(1)}px, 0)` }"
        />
      </div>
    </div>

    <!-- Bottom-center Compact Roaming Dock (visible in roaming mode) -->
    <div
      v-if="ui.cameraMode === 'roaming'"
      class="hud-3d-roam-dock"
      data-test="roam-hud"
      role="region"
      aria-label="第三人称模拟跑图仪表盘"
    >
      <label class="roam-field">
        <span class="sr-only">角色移速档位</span>
        <select
          class="sel roam-select"
          data-test="roam-speed-preset"
          :value="ui.speedPresetId"
          @change="onPresetSelect"
        >
          <option v-for="p in ROAM_SPEED_PRESETS" :key="p.id" :value="p.id">
            {{ p.label }}
          </option>
          <option value="custom">自定义 · {{ ui.speedMps.toFixed(2) }} m/s</option>
        </select>
      </label>

      <label class="roam-slider-wrap" title="自由调速 (1–40 m/s)">
        <input
          type="range"
          min="1"
          max="40"
          step="0.05"
          class="roam-slider"
          data-test="roam-speed-slider"
          :value="ui.speedMps"
          @input="onSpeedSliderInput"
        />
        <span class="roam-speed-num num">{{ ui.speedMps.toFixed(2) }} m/s</span>
      </label>

      <div class="roam-metrics">
        <span class="metric-chip num" data-test="roam-distance" title="累计跑图距离">
          {{ ui.distanceM.toFixed(1) }} m
        </span>
        <span class="metric-chip num" data-test="roam-timer" title="累计移动用时">
          {{ ui.elapsedS.toFixed(1) }} s
        </span>
        <span class="metric-chip floor-chip" data-test="roam-floor" title="当前所在楼层">
          {{ ui.floor }}
        </span>
      </div>

      <div class="roam-actions">
        <button
          type="button"
          class="hud-3d-pill compact"
          :class="{ on: ui.sprintActive }"
          :aria-pressed="ui.sprintActive"
          data-test="btn-roam-sprint"
          title="切换 ×3 疾跑倍速（等效按住 Shift）"
          @click="handleToggleSprint"
        >
          ×3
        </button>
        <button
          type="button"
          class="hud-3d-pill compact"
          data-test="btn-roam-reset-stats"
          title="归零测距与计时"
          @click="resetTelemetryStats"
        >
          归零
        </button>
        <button
          type="button"
          class="hud-3d-pill compact"
          data-test="btn-roam-next-spawn"
          :title="`切换出生点（当前：${ui.spawnLabel}）`"
          @click="jumpNextSpawn"
        >
          出生点
        </button>
      </div>
    </div>

    <!-- Bottom-right Touch / Mouse Press-and-Hold D-Pad (kept cleanly on desktop) -->
    <div
      v-if="ui.cameraMode === 'roaming'"
      class="hud-3d-dpad"
      data-test="roam-dpad"
      role="group"
      aria-label="方向移动键"
    >
      <button
        type="button"
        class="dpad-btn dpad-w"
        data-test="dpad-w"
        aria-label="向前移动 W"
        @pointerdown="handleDpad('forward', true, $event)"
        @pointerup="handleDpad('forward', false)"
        @pointerleave="handleDpad('forward', false)"
        @pointercancel="handleDpad('forward', false)"
      >
        W
      </button>
      <button
        type="button"
        class="dpad-btn dpad-a"
        data-test="dpad-a"
        aria-label="向左移动 A"
        @pointerdown="handleDpad('left', true, $event)"
        @pointerup="handleDpad('left', false)"
        @pointerleave="handleDpad('left', false)"
        @pointercancel="handleDpad('left', false)"
      >
        A
      </button>
      <button
        type="button"
        class="dpad-btn dpad-s"
        data-test="dpad-s"
        aria-label="向后移动 S"
        @pointerdown="handleDpad('backward', true, $event)"
        @pointerup="handleDpad('backward', false)"
        @pointerleave="handleDpad('backward', false)"
        @pointercancel="handleDpad('backward', false)"
      >
        S
      </button>
      <button
        type="button"
        class="dpad-btn dpad-d"
        data-test="dpad-d"
        aria-label="向右移动 D"
        @pointerdown="handleDpad('right', true, $event)"
        @pointerup="handleDpad('right', false)"
        @pointerleave="handleDpad('right', false)"
        @pointercancel="handleDpad('right', false)"
      >
        D
      </button>
    </div>
  </div>
</template>

<style scoped>
.canvas-3d-wrap {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: #22303c;
  user-select: none;
}

.canvas-3d-surface {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  touch-action: none;
  cursor: grab;
}

.canvas-3d-surface:active {
  cursor: grabbing;
}

.canvas-3d-surface.cursor-teleport {
  cursor: crosshair;
}

.canvas-3d-surface :deep(canvas) {
  display: block;
  width: 100%;
  height: 100%;
}

/* Top-left camera & overlay bar — positioned cleanly below Stage 02 #toolbar / #sandboxBar */
.hud-3d-topbar {
  position: absolute;
  top: 62px;
  left: 12px;
  z-index: 6;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  max-width: calc(100% - 24px);
}

.canvas-3d-wrap.is-standalone .hud-3d-topbar,
.canvas-3d-wrap.is-hud-expanded .hud-3d-topbar {
  top: 112px;
}

.hud-3d-seg {
  display: inline-flex;
  flex: none;
  background: linear-gradient(180deg, rgba(30, 24, 19, 0.94), rgba(18, 15, 13, 0.94));
  border: 1px solid #a8834b;
  border-radius: 5px;
  padding: 2px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.55);
}

.hud-3d-btn {
  border: 1px solid transparent;
  border-radius: 4px;
  padding: 4px 10px;
  min-height: 28px;
  background: transparent;
  color: #f3e4c7;
  font: 700 12.5px/1.2 var(--font-cjk);
  letter-spacing: 0.02em;
  cursor: pointer;
  white-space: nowrap;
}

.hud-3d-btn:hover {
  background: rgba(216, 179, 106, 0.16);
  color: #fff6e3;
}

.hud-3d-btn.on {
  background: linear-gradient(180deg, #faecc8 0%, #e7c689 54%, #cfa25e 100%);
  border-color: #987240;
  color: #24160a;
  box-shadow: inset 0 1px 0 rgba(255, 250, 236, 0.78);
}

.hud-3d-pill {
  flex: none;
  border: 1px solid #9d7944;
  border-radius: 4px;
  padding: 4px 10px;
  min-height: 30px;
  background: linear-gradient(180deg, rgba(34, 27, 21, 0.94), rgba(20, 16, 13, 0.94));
  color: #f5e6c8;
  font: 600 12.5px/1.2 var(--font-cjk);
  letter-spacing: 0.02em;
  box-shadow:
    inset 0 1px 0 rgba(255, 244, 214, 0.14),
    0 3px 10px rgba(0, 0, 0, 0.5);
  cursor: pointer;
  white-space: nowrap;
}

.hud-3d-pill.compact {
  padding: 4px 9px;
  min-height: 28px;
}

.hud-3d-pill:hover {
  border-color: #d8b36a;
  color: #fff6e4;
}

.hud-3d-pill.on {
  background: linear-gradient(180deg, #faecc8 0%, #e4c283 55%, #cb9d58 100%);
  border-color: #987240;
  color: #24160a;
  font-weight: 700;
}

/* Top-right status badge — positioned cleanly below Stage 02 #toolbar / #sandboxBar and clear of folio toggle */
.hud-3d-status {
  position: absolute;
  top: 62px;
  right: 46px;
  z-index: 5;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: min(44%, 420px);
  padding: 5px 11px;
  border-radius: 4px;
  border: 1px solid rgba(196, 155, 90, 0.65);
  background: linear-gradient(180deg, rgba(26, 21, 17, 0.9), rgba(15, 14, 13, 0.9));
  color: #f3e4c7;
  font-size: 12px;
  line-height: 1.3;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
  box-shadow: 0 3px 10px rgba(0, 0, 0, 0.52);
}

.canvas-3d-wrap.is-standalone .hud-3d-status,
.canvas-3d-wrap.is-hud-expanded .hud-3d-status {
  top: 112px;
}

.hud-3d-tac-dock {
  position: absolute;
  top: 106px;
  left: 12px;
  z-index: 7;
  width: min(332px, calc(100% - 24px));
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px solid #b58d52;
  background: linear-gradient(180deg, rgba(28, 22, 17, 0.95), rgba(16, 14, 12, 0.95));
  box-shadow: 0 10px 26px rgba(0, 0, 0, 0.65);
  color: #f3e4c7;
  font-size: 12px;
}
.canvas-3d-wrap.is-standalone .hud-3d-tac-dock,
.canvas-3d-wrap.is-hud-expanded .hud-3d-tac-dock {
  top: 152px;
}
.tac3d-tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 8px;
  border-bottom: 1px solid rgba(181, 141, 82, 0.35);
  padding-bottom: 6px;
}
.tac3d-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.tac3d-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.tac3d-chk {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: #e8d8b7;
  font-size: 12px;
  cursor: pointer;
}
.tac3d-summary {
  margin: 0;
  padding: 5px 8px;
  border-radius: 4px;
  background: rgba(216, 179, 106, 0.12);
  border: 1px solid rgba(216, 179, 106, 0.32);
  color: #f6e7c8;
  line-height: 1.4;
}
.tac3d-summary .gold,
.tac3d-list-row .gold {
  color: #f8d483;
}
.tac3d-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 165px;
  overflow-y: auto;
}
.tac3d-list-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 6px;
  padding: 5px 7px;
  border-radius: 4px;
  border: 1px solid rgba(168, 131, 75, 0.45);
  background: rgba(24, 19, 15, 0.85);
  color: #f3e4c7;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.tac3d-list-row:hover {
  border-color: #e5be76;
  background: rgba(58, 44, 28, 0.9);
}
.danger-txt {
  color: #fca5a5;
  font-weight: 700;
}

.scene-tag {
  color: #f7d996;
  font-weight: 700;
}

.sep {
  color: #cbb894;
}

.boost-tag {
  padding: 1px 6px;
  border-radius: 3px;
  background: #e5bc73;
  color: #231509;
  font-size: 12px;
  font-weight: 700;
}

/* Loading & error center card */
.hud-3d-center-card {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  z-index: 7;
  display: flex;
  align-items: center;
  gap: 12px;
  max-width: calc(100% - 32px);
  padding: 12px 18px;
  border-radius: 6px;
  border: 1px solid #b89154;
  background: linear-gradient(180deg, rgba(32, 25, 19, 0.96), rgba(18, 15, 13, 0.96));
  color: #f6e7c8;
  box-shadow:
    inset 0 1px 0 rgba(255, 245, 218, 0.2),
    0 10px 28px rgba(0, 0, 0, 0.68);
}

.hud-3d-center-card.is-error {
  border-color: #c95b68;
}

.brass-spinner {
  width: 20px;
  height: 20px;
  flex: none;
  border-radius: 50%;
  border: 2.5px solid rgba(216, 179, 106, 0.28);
  border-top-color: #f2cf88;
  animation: spin3d 0.85s linear infinite;
}

@keyframes spin3d {
  to {
    transform: rotate(360deg);
  }
}

.card-lines {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.card-lines strong {
  font-size: 13.5px;
  color: #fff3da;
}

.card-lines span {
  font-size: 12px;
  color: #d8c8ab;
}

/* Bottom-left 116x116px Floating Virtual Analog Thumbstick */
.hud-3d-joystick {
  position: absolute;
  left: 12px;
  bottom: 12px;
  z-index: 6;
  width: 116px;
  height: 116px;
  display: flex;
  align-items: center;
  justify-content: center;
  touch-action: none;
  cursor: pointer;
}

.joystick-ring {
  position: relative;
  width: 104px;
  height: 104px;
  border-radius: 50%;
  border: 1.5px solid rgba(206, 165, 98, 0.72);
  background: radial-gradient(
    circle,
    rgba(36, 28, 20, 0.56) 0%,
    rgba(19, 15, 12, 0.82) 100%
  );
  box-shadow:
    inset 0 0 0 1px rgba(255, 243, 214, 0.12),
    0 6px 18px rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
}

.hud-3d-joystick.active .joystick-ring {
  border-color: #f0cb80;
  box-shadow:
    inset 0 0 0 1px rgba(255, 244, 214, 0.28),
    0 0 14px rgba(229, 188, 115, 0.28),
    0 6px 18px rgba(0, 0, 0, 0.62);
}

.joystick-knob {
  width: 42px;
  height: 42px;
  border-radius: 50%;
  border: 2px solid #f5d896;
  background: radial-gradient(circle at 35% 30%, #faecc8 0%, #d8ae66 65%, #9a7138 100%);
  box-shadow:
    inset 0 1px 1px rgba(255, 252, 242, 0.8),
    0 3px 10px rgba(0, 0, 0, 0.65);
  will-change: transform;
  pointer-events: none;
}

/* Bottom-center Roaming Dock (positioned cleanly between bottom-left joystick and bottom-right dpad) */
.hud-3d-roam-dock {
  position: absolute;
  left: 138px;
  right: 132px;
  bottom: 12px;
  z-index: 6;
  margin-inline: auto;
  width: fit-content;
  max-width: calc(100% - 270px);
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: 6px;
  border: 1px solid #b38c50;
  background: linear-gradient(180deg, rgba(31, 25, 19, 0.95), rgba(17, 15, 13, 0.95));
  color: #f5e6c8;
  box-shadow:
    inset 0 1px 0 rgba(255, 245, 218, 0.16),
    0 6px 20px rgba(0, 0, 0, 0.62);
}

.roam-field {
  display: inline-flex;
  align-items: center;
  flex: none;
}

.roam-select {
  appearance: none;
  -webkit-appearance: none;
  -moz-appearance: none;
  min-height: 28px;
  max-width: 220px;
  padding: 4px 24px 4px 8px;
  font-size: 12.5px;
  color: #f6e7c8;
}

.roam-slider-wrap {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
}

.roam-slider {
  width: 78px;
}

.roam-speed-num {
  min-width: 58px;
  font-size: 12.5px;
  font-weight: 700;
  color: #fae5b8;
  text-align: right;
  white-space: nowrap;
}

.roam-metrics {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: none;
}

.metric-chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 26px;
  padding: 2px 8px;
  border-radius: 4px;
  border: 1px solid rgba(184, 145, 84, 0.55);
  background: rgba(12, 10, 9, 0.72);
  color: #fff2d6;
  font-size: 12.5px;
  font-weight: 700;
  white-space: nowrap;
}

.floor-chip {
  color: #f7d68a;
  font-family: var(--font-latin);
}

.roam-actions {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: none;
}

/* Bottom-right Touch / Mouse D-Pad */
.hud-3d-dpad {
  position: absolute;
  right: 12px;
  bottom: 12px;
  z-index: 6;
  display: grid;
  grid-template-columns: repeat(3, 32px);
  grid-template-rows: repeat(2, 32px);
  gap: 4px;
  padding: 5px;
  border-radius: 6px;
  border: 1px solid #a8834b;
  background: linear-gradient(180deg, rgba(29, 23, 18, 0.92), rgba(16, 14, 12, 0.92));
  box-shadow: 0 5px 16px rgba(0, 0, 0, 0.58);
  touch-action: none;
}

.dpad-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid #967240;
  border-radius: 4px;
  background: linear-gradient(180deg, #2d241b 0%, #1b1611 100%);
  color: #f6e7c8;
  font: 700 12.5px/1 var(--font-latin);
  cursor: pointer;
  touch-action: none;
}

.dpad-btn:hover {
  border-color: #dfbc76;
  color: #fff7e5;
}

.dpad-btn:active {
  background: linear-gradient(180deg, #f8e8c0 0%, #d8ae66 100%);
  color: #24160a;
}

.dpad-w {
  grid-column: 2;
  grid-row: 1;
}

.dpad-a {
  grid-column: 1;
  grid-row: 2;
}

.dpad-s {
  grid-column: 2;
  grid-row: 2;
}

.dpad-d {
  grid-column: 3;
  grid-row: 2;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

@media (min-width: 1024px) and (pointer: fine) {
  .hud-3d-joystick {
    display: none;
  }

  .hud-3d-roam-dock {
    left: 12px;
    max-width: calc(100% - 148px);
  }
}

@media (max-width: 1120px) {
  .hud-3d-status {
    display: none;
  }
}

/* Mobile Portrait & Narrow Tablet (< 900px): compact single-row topbar + single-row telemetry dock */
@media (max-width: 900px) {
  .hud-3d-topbar {
    top: 54px;
    left: 8px;
    right: 32px;
    max-width: calc(100% - 40px);
    flex-wrap: nowrap;
    overflow-x: auto;
    scrollbar-width: none;
    gap: 5px;
  }

  .hud-3d-topbar::-webkit-scrollbar {
    display: none;
  }

  .canvas-3d-wrap.is-standalone .hud-3d-topbar,
  .canvas-3d-wrap.is-hud-expanded .hud-3d-topbar {
    top: 96px;
  }

  .hud-3d-joystick {
    left: 8px;
    bottom: 10px;
  }

  .hud-3d-dpad {
    display: none;
  }

  .hud-3d-roam-dock {
    left: 130px;
    right: 8px;
    bottom: 10px;
    margin-inline: 0;
    width: auto;
    max-width: none;
    flex-wrap: nowrap;
    justify-content: flex-start;
    overflow-x: auto;
    scrollbar-width: none;
    gap: 6px;
    padding: 5px 8px;
  }

  .hud-3d-roam-dock::-webkit-scrollbar {
    display: none;
  }

  .roam-slider-wrap {
    display: none;
  }

  .roam-select {
    max-width: 148px;
    padding: 3px 18px 3px 6px;
    font-size: 12px;
  }

  .metric-chip {
    padding: 2px 6px;
    font-size: 12px;
  }
}

@media (max-width: 560px) {
  .hud-3d-joystick {
    width: 96px;
    height: 96px;
    left: 8px;
    bottom: 10px;
  }

  .joystick-ring {
    width: 88px;
    height: 88px;
  }

  .joystick-knob {
    width: 36px;
    height: 36px;
  }

  .hud-3d-roam-dock {
    left: 110px;
    right: 8px;
    bottom: 10px;
    flex-wrap: wrap;
    overflow-x: visible;
    gap: 5px;
    padding: 5px 7px;
  }

  .roam-select {
    max-width: 100%;
    width: 100%;
  }
}

/* Mobile Landscape (e.g. 844x390, max-height: 500px): keep center viewport completely unobstructed */
@media (max-height: 500px) {
  .hud-3d-topbar {
    top: 48px;
    left: 8px;
    right: 32px;
    max-width: calc(100% - 40px);
    flex-wrap: nowrap;
    overflow-x: auto;
    scrollbar-width: none;
    gap: 5px;
  }

  .hud-3d-topbar::-webkit-scrollbar {
    display: none;
  }

  .canvas-3d-wrap.is-standalone .hud-3d-topbar,
  .canvas-3d-wrap.is-hud-expanded .hud-3d-topbar {
    top: 54px;
  }

  .hud-3d-status {
    display: none;
  }

  .hud-3d-joystick {
    left: 8px;
    bottom: 8px;
  }

  .hud-3d-dpad {
    display: none;
  }

  .hud-3d-roam-dock {
    left: 130px;
    right: 8px;
    bottom: 8px;
    margin-inline: 0;
    width: auto;
    max-width: none;
    flex-wrap: nowrap;
    justify-content: flex-start;
    overflow-x: auto;
    scrollbar-width: none;
    gap: 6px;
    padding: 4px 8px;
  }

  .hud-3d-roam-dock::-webkit-scrollbar {
    display: none;
  }

  .roam-slider-wrap {
    display: none;
  }

  .roam-select {
    max-width: 156px;
    font-size: 12px;
  }

  .metric-chip {
    font-size: 12px;
  }
}
</style>
