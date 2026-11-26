import type { Replay2DPayload } from '@idv/replay-renderer';
import { cipherOf, mapsZonesRelative } from './geo';
import { findPilMapByName, WORLD_UNITS_PER_METER } from './maps';
import type { DeduceMarksState, PilMapId } from './types';

type Point = readonly [number, number];
export interface LinkTransform { s: number; dihedral: number; tx: number; ty: number }
export interface SpawnPoint {
  uid: number;
  camp: 1 | 2;
  name: string;
  zone: number;
  px: number;
  py: number;
  edgeDistPx: number;
  nearEdge: boolean;
}
export interface ReplayLinkResult {
  matchId: string;
  mapId: PilMapId;
  transform: LinkTransform;
  confidence: number;
  matchedCipherIds: string[];
  groupIndex: number | null;
  groupMatch: 'exact' | 'approx' | 'none';
  spawn: { survivorZones: number[]; hunterZone: number | null; perPlayer: SpawnPoint[] };
  lockCipherId: string | null;
  truthMarks: DeduceMarksState;
}

export const LINK_CONFIDENCE = 0.8;

function orient([x, y]: Point, d: number): Point {
  if (d >= 4) x = -x;
  switch (d % 4) {
    case 1: return [-y, x];
    case 2: return [-x, -y];
    case 3: return [y, -x];
    default: return [x, y];
  }
}

export function projectReplayPoint(point: Point, transform: LinkTransform): Point {
  const [x, y] = orient(point, transform.dihedral);
  return [x * transform.s + transform.tx, y * transform.s + transform.ty];
}

export function unprojectReplayPoint([x, y]: Point, transform: LinkTransform): Point {
  const { s, dihedral, tx, ty } = transform;
  const inverse = dihedral < 4 ? (4 - dihedral) % 4 : dihedral;
  return orient([(x - tx) / s, (y - ty) / s], inverse);
}

interface Correspondence { p: Point; q: Point; index: number; distance: number }

function correspond(points: Point[], targets: Point[], t: LinkTransform, tolerance: number): Correspondence[] {
  const edges: Correspondence[] = [];
  for (const p of points) {
    const [x, y] = projectReplayPoint(p, t);
    targets.forEach((q, index) => {
      const distance = Math.hypot(x - q[0], y - q[1]);
      if (distance <= tolerance) edges.push({ p, q, index, distance });
    });
  }
  // Enumerate gated matches. At seven observations the graph is small, and
  // maximizing cardinality first keeps a close pair from stealing another match.
  if (!edges.length) return [];
  const rows = points.map((p) => edges.filter((edge) => edge.p === p));
  let best: Correspondence[] = [];
  let bestCost = Infinity;
  const used = new Set<number>();
  const chosen: Correspondence[] = [];
  function visit(row: number, cost: number): void {
    if (chosen.length + rows.length - row < best.length) return;
    if (row === rows.length) {
      if (chosen.length > best.length || (chosen.length === best.length && cost < bestCost)) {
        best = chosen.slice();
        bestCost = cost;
      }
      return;
    }
    for (const edge of rows[row]!) {
      if (used.has(edge.index)) continue;
      used.add(edge.index);
      chosen.push(edge);
      visit(row + 1, cost + edge.distance);
      chosen.pop();
      used.delete(edge.index);
    }
    visit(row + 1, cost);
  }
  visit(0, 0);
  return best;
}

function refine(rows: Correspondence[], prior: number, transform: LinkTransform): LinkTransform {
  if (rows.length < 2) return transform;
  const p = rows.map((row) => orient(row.p, transform.dihedral));
  const q = rows.map((row) => row.q);
  const mean = (points: Point[], axis: 0 | 1) =>
    points.reduce((sum, point) => sum + point[axis], 0) / points.length;
  const [px, py, qx, qy] = [mean(p, 0), mean(p, 1), mean(q, 0), mean(q, 1)] as const;
  let covariance = 0;
  let variance = 0;
  p.forEach(([x, y], i) => {
    covariance += (x - px) * (q[i]![0] - qx) + (y - py) * (q[i]![1] - qy);
    variance += (x - px) ** 2 + (y - py) ** 2;
  });
  const s = covariance / variance;
  if (!Number.isFinite(s) || Math.abs(s / prior - 1) >= 0.15) return transform;
  return { s, dihedral: transform.dihedral, tx: qx - s * px, ty: qy - s * py };
}

type LinkReplay = Pick<Replay2DPayload, 'match' | 'entities' | 'players' | 'trajectories'>;

export function computeReplayLink(replay: LinkReplay): ReplayLinkResult | null {
  const map = findPilMapByName(replay.match.map_name);
  const points: Point[] = replay.entities.ciphers.map(({ pos }) => [pos[0], pos[2]]);
  if (!map || points.length !== 7 || points.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y))) return null;
  const [width, height] = map.mapSize;
  const prior = width / (map.widthM * WORLD_UNITS_PER_METER);
  const tolerance = width * 0.03;
  const candidates = [...new Set(map.cipherCombinations.flat())].map((id) => cipherOf(map.mapId, id)!);
  const targets = candidates.map(({ location }) => [location[0], location[1]] as const);
  let transform: LinkTransform = { s: prior, dihedral: 0, tx: 0, ty: 0 };
  let matched: Correspondence[] = [];
  let confidence = 0;
  for (let dihedral = 0; dihedral < 8; dihedral++) {
    for (const p of points) {
      const [x, y] = orient(p, dihedral);
      for (const [qx, qy] of targets) {
        const seed = { s: prior, dihedral, tx: qx - x * prior, ty: qy - y * prior };
        const initial = correspond(points, targets, seed, tolerance);
        if (initial.length < 3) continue;
        const fit = refine(initial, prior, seed);
        const rows = correspond(points, targets, fit, tolerance);
        const error = rows.reduce((sum, row) => sum + row.distance, 0);
        const score = rows.length ? rows.length / 7 * Math.exp(-error / (rows.length * tolerance)) : 0;
        if (score <= confidence) continue;
        confidence = score;
        transform = fit;
        matched = rows;
      }
    }
  }
  const matchedCipherIds = matched.map(({ index }) => candidates[index]!.id);
  const counts = map.cipherCombinations.map((group) => group.filter((id) => matchedCipherIds.includes(id)).length);
  const hits = Math.max(...counts);
  const groupIndex = hits >= 6 && counts.filter((count) => count === hits).length === 1 ? counts.indexOf(hits) : null;
  const zones = mapsZonesRelative[map.mapId]!;
  const perPlayer = replay.players.flatMap<SpawnPoint>((player) => {
    const sample = replay.trajectories[player.uid]?.find(([t, x, , z]) =>
      t >= 0 && t <= 5 && Number.isFinite(x) && Number.isFinite(z));
    if (!sample) return [];
    const [px, py] = projectReplayPoint([sample[1], sample[3]], transform);
    let zone = -1;
    let nearest = Infinity;
    let edgeDistPx = Infinity;
    zones.forEach((rect, index) => {
      const [left, right] = [rect.x * width, (rect.x + rect.width) * width];
      const [top, bottom] = [rect.y * height, (rect.y + rect.height) * height];
      const distance = Math.hypot(Math.max(left - px, 0, px - right), Math.max(top - py, 0, py - bottom));
      if (distance >= nearest) return;
      nearest = distance;
      zone = index;
      edgeDistPx = distance || Math.min(px - left, right - px, py - top, bottom - py);
    });
    return [{ uid: player.uid, camp: player.camp, name: player.player_name, zone, px, py, edgeDistPx,
      nearEdge: nearest > 0 || edgeDistPx < width * 0.02 }];
  });
  const hunter = perPlayer.find((player) => player.camp === 1);
  const lockCipherId = hunter
    ? matchedCipherIds.reduce<string | null>((farthest, id) => {
        const distance = (key: string) => {
          const { location } = cipherOf(map.mapId, key)!;
          return Math.hypot(location[0] - hunter.px, location[1] - hunter.py);
        };
        return farthest === null || distance(id) > distance(farthest) ? id : farthest;
      }, null)
    : null;
  const truthMarks: DeduceMarksState = {};
  map.ciphers.forEach((cipher, index) => {
    if (!cipher.locked) truthMarks[index] = matchedCipherIds.includes(cipher.id) ? 'yes' : 'no';
  });
  return {
    matchId: replay.match.match_id, mapId: map.mapId, transform, confidence, matchedCipherIds, groupIndex,
    groupMatch: groupIndex === null ? 'none' : hits === 7 ? 'exact' : 'approx',
    spawn: { survivorZones: [...new Set(perPlayer.filter((p) => p.camp === 2).map((p) => p.zone))],
      hunterZone: hunter?.zone ?? null, perPlayer },
    lockCipherId, truthMarks,
  };
}
