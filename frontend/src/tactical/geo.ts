/**
 * PIL map zone geometry, cipher relative coordinates, lock cipher calculation,
 * and regional cipher distance analysis (zero DOM).
 */
import { tZh } from './locales-zh';
import { CIPHER_EXTRA, MAPS_DATA, resolvePilMapId } from './maps';
import type {
  CipherPoint,
  Point2D,
  RegionAnalysisResult,
  RegionCipherRow,
  ZoneRect,
} from './types';

export function cipherOf(mapId: number, cipherId: string): CipherPoint | undefined {
  const id = resolvePilMapId(mapId);
  return (
    MAPS_DATA[id]!.ciphers.find((p) => p.id === cipherId) ??
    (CIPHER_EXTRA[id] ?? []).find((c) => c.id === cipherId)
  );
}

export function calculateMapsZonesRelative(): ZoneRect[][] {
  return MAPS_DATA.map(({ zonesInfo, mapSize }, mapId) => {
    const [xInit, yInit, w, h, cols, rows] = zonesInfo;
    const [imgW, imgH] = mapSize;
    const rel = { x: xInit / imgW, y: yInit / imgH, w: w / imgW, h: h / imgH };
    const zones: ZoneRect[] = [];

    if (mapId === 6) {
      for (let i = 0; i < cols; i++) {
        for (let j = 0; j < rows; j++) {
          zones.push({
            x: rel.x + (cols - 1 - j) * rel.w,
            y: rel.y + i * rel.h,
            width: rel.w,
            height: rel.h,
          });
        }
      }
      // Eversleeping Town 10th cemetery zone
      zones.push({
        x: rel.x + 1.35 * rel.w,
        y: rel.y + 3 * rel.h,
        width: 1.65 * rel.w,
        height: 1.16 * rel.h,
      });
      return zones;
    }

    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < rows; j++) {
        zones.push({
          x: rel.x + i * rel.w,
          y: rel.y + (j - (mapId === 2 ? i * 0.125 : 0)) * rel.h,
          width: rel.w,
          height: rel.h,
        });
      }
    }
    return zones;
  });
}

export function calculateCiphersCoordsRelative(): Array<Array<Array<[number, number]>>> {
  return MAPS_DATA.map((map, mapId) => {
    const [imgW, imgH] = map.mapSize;
    return map.cipherCombinations.map((group) =>
      group.map((cipherId) => {
        const pt = cipherOf(mapId, cipherId)!.location;
        return [pt[0] / imgW, pt[1] / imgH];
      }),
    );
  });
}

export function calculateZoneCenters(zones: readonly ZoneRect[]): Point2D[] {
  return zones.map((zone) => ({
    x: zone.x + zone.width / 2,
    y: zone.y + zone.height / 2,
  }));
}

export function calculateLockCipher(
  hunterPos: Point2D,
  ciphers: ReadonlyArray<readonly [number, number]>,
  mapSize: readonly [number, number],
): number {
  let maxDist = -1;
  let idLock = 0;
  const imgW = mapSize[0];
  const imgH = mapSize[1];
  for (let i = 0; i < ciphers.length; i++) {
    const c = ciphers[i]!;
    const dx = (hunterPos.x - c[0]) * imgW;
    const dy = (hunterPos.y - c[1]) * imgH;
    const dist = Math.hypot(dx, dy);
    if (dist > maxDist) {
      maxDist = dist;
      idLock = i;
    }
  }
  return idLock;
}

export const mapsZonesRelative: readonly ZoneRect[][] = calculateMapsZonesRelative();

export const ciphersCoordsRelative: ReadonlyArray<ReadonlyArray<ReadonlyArray<[number, number]>>> =
  calculateCiphersCoordsRelative();

export function analyzeRegionCiphers(
  mapIdInput: number | string,
  cipherGroupIndex = 0,
  hunterZoneIdx: number | null = null,
): RegionAnalysisResult {
  const id = resolvePilMapId(mapIdInput);
  const map = MAPS_DATA[id]!;
  const groupCount = map.cipherCombinations.length;
  const gIdx = ((cipherGroupIndex % groupCount) + groupCount) % groupCount;
  const zones = mapsZonesRelative[id]!;
  const centers = calculateZoneCenters(zones);
  const cipherGroup = map.cipherCombinations[gIdx]!;
  const ciphersRel = ciphersCoordsRelative[id]![gIdx]!;
  const mPerPx = map.widthM / map.mapSize[0];

  const validHunter =
    hunterZoneIdx !== null &&
    Number.isInteger(hunterZoneIdx) &&
    hunterZoneIdx >= 0 &&
    hunterZoneIdx < centers.length;

  const hunterPos = validHunter ? centers[hunterZoneIdx]! : null;
  const hunterPixelCoords: [number, number] | null = hunterPos
    ? [Math.round(hunterPos.x * map.mapSize[0]), Math.round(hunterPos.y * map.mapSize[1])]
    : null;
  const hunterZoneName = validHunter
    ? (map.zoneNames[hunterZoneIdx!] ?? tZh('maps.default.zoneNames'))
    : null;

  const lockIndex = hunterPos
    ? calculateLockCipher(hunterPos, ciphersRel, map.mapSize)
    : -1;

  const rows: RegionCipherRow[] = ciphersRel.map((rel, idx) => {
    const cObj = cipherOf(id, cipherGroup[idx]!)!;
    const pixelDist = hunterPos
      ? Math.hypot((hunterPos.x - rel[0]) * map.mapSize[0], (hunterPos.y - rel[1]) * map.mapSize[1])
      : 0;
    return {
      idx,
      id: cObj.id,
      name: cObj.name,
      feature: cObj.feature,
      location: cObj.location,
      relPos: [rel[0], rel[1]],
      pixelDist,
      distanceM: pixelDist * mPerPx,
      isLocked: idx === lockIndex,
      isFarthest: idx === lockIndex,
    };
  });

  return {
    mapId: id,
    cipherGroupIndex: gIdx,
    hunterZoneIdx: validHunter ? hunterZoneIdx! : -1,
    hunterZoneName,
    hunterPixelCoords,
    lockIndex,
    lockCipherName: lockIndex >= 0 ? rows[lockIndex]!.name : null,
    lockDistanceM: lockIndex >= 0 ? rows[lockIndex]!.distanceM : null,
    rows,
  };
}
