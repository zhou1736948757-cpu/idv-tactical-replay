import { calculateZoneCenters, mapsZonesRelative } from './geo';
import { MAPS_DATA } from './maps';
import type { ReplayLinkResult } from './replay-link';
import type { PilMapId, StorageLike } from './types';

export const PRACTICE_STORAGE_KEY = 'idv.practice.v1';

export interface PracticeAttempt {
  survivorZones: number[];
  hunterZone: number;
  groupIndex: number;
  lockCipherId: string | null;
  cipherIds?: string[];
}

export interface PracticeScoreResult {
  totalScore: number;
  survivorHits: number;
  hunterHit: boolean;
  hunterOffsetMeters: number;
  groupExactMatch: boolean;
  lockCipherMatch: boolean;
  cipherHitCount: number | null;
  insights: string[];
}

export function evaluatePractice(attempt: PracticeAttempt, truth: ReplayLinkResult): PracticeScoreResult {
  const map = MAPS_DATA[truth.mapId]!;
  const survivorHits = Math.min(4, [...new Set(attempt.survivorZones)].filter((zone) =>
    truth.spawn.survivorZones.includes(zone)).length);
  const hunterHit = attempt.hunterZone === truth.spawn.hunterZone;
  const hunter = truth.spawn.perPlayer.find((player) => player.camp === 1);
  const center = calculateZoneCenters(mapsZonesRelative[truth.mapId]!)[attempt.hunterZone];
  const hunterOffsetMeters = hunter && center ? Math.round(10 * Math.hypot(
    center.x * map.mapSize[0] - hunter.px, center.y * map.mapSize[1] - hunter.py,
  ) * map.widthM / map.mapSize[0]) / 10 : 0;
  const groupExactMatch = truth.groupMatch === 'exact' && attempt.groupIndex === truth.groupIndex;
  const lockCipherMatch = truth.lockCipherId !== null && attempt.lockCipherId === truth.lockCipherId;
  const cipherHitCount = attempt.cipherIds ? Math.min(7, [...new Set(attempt.cipherIds)]
    .filter((id) => truth.matchedCipherIds.includes(id)).length) : null;
  return {
    totalScore: 10 * survivorHits + (hunterHit ? 30 : 0) + (lockCipherMatch ? 15 : 0) +
      (cipherHitCount === null ? (groupExactMatch ? 15 : 0) : Math.round(cipherHitCount * 15 / 7)),
    survivorHits, hunterHit, hunterOffsetMeters, groupExactMatch, lockCipherMatch, cipherHitCount,
    insights: [
      `求生选区命中 ${survivorHits}/4，可对照未命中区域的开局转点。`,
      `监管实际出生在${map.zoneNames[truth.spawn.hunterZone ?? -1] ?? '未知区域'}，距预测区中心 ${hunterOffsetMeters} 米。`,
      lockCipherMatch ? '封禁密码机判断一致。' : '封禁判断有偏差，观察监管出生点与远端密码机的距离。',
    ],
  };
}

export interface PracticeRecord {
  matchId: string;
  mapId: PilMapId;
  at: number;
  totalScore: number;
  survivorHits: number;
  hunterHit: boolean;
  lockCipherMatch: boolean;
  attempt?: PracticeAttempt;
}

function sanitizeAttempt(raw: unknown, mapId: PilMapId): PracticeAttempt | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Partial<PracticeAttempt>;
  const map = MAPS_DATA[mapId]!;
  const zoneCount = mapsZonesRelative[mapId]!.length;
  const validZone = (zone: unknown): zone is number =>
    typeof zone === 'number' && Number.isInteger(zone) && zone >= 0 && zone < zoneCount;
  const groupIndex = value.groupIndex;
  const hunterZone = value.hunterZone;
  if (!validZone(hunterZone) || !Array.isArray(value.survivorZones) ||
    typeof groupIndex !== 'number' || !Number.isInteger(groupIndex) || !map.cipherCombinations[groupIndex]) return undefined;
  const survivorZones = [...new Set(value.survivorZones.filter((zone) => validZone(zone) && zone !== hunterZone))].slice(0, 4);
  if (!survivorZones.length) return undefined;
  const known = new Set(map.cipherCombinations.flat());
  const lockCipherId = typeof value.lockCipherId === 'string' && known.has(value.lockCipherId) ? value.lockCipherId : null;
  const result: PracticeAttempt = { survivorZones, hunterZone, groupIndex, lockCipherId };
  if (Array.isArray(value.cipherIds)) result.cipherIds = [...new Set(value.cipherIds.filter((id) => known.has(id)))].slice(0, 7);
  return result;
}

export function readPracticeHistory(storage: StorageLike | null): PracticeRecord[] {
  try {
    const raw: unknown = JSON.parse(storage?.getItem(PRACTICE_STORAGE_KEY) ?? '[]');
    if (!Array.isArray(raw)) return [];
    return raw.slice(-200).flatMap<PracticeRecord>((record) => {
      if (!record || typeof record.matchId !== 'string' || !/^[0-9a-f]{24}$/i.test(record.matchId) ||
        !Number.isInteger(record.mapId) || !MAPS_DATA[record.mapId] || !Number.isFinite(record.at) ||
        !Number.isInteger(record.totalScore) || record.totalScore < 0 || record.totalScore > 100 ||
        !Number.isInteger(record.survivorHits) || record.survivorHits < 0 || record.survivorHits > 4 ||
        typeof record.hunterHit !== 'boolean' || typeof record.lockCipherMatch !== 'boolean') return [];
      const { matchId, mapId, at, totalScore, survivorHits, hunterHit, lockCipherMatch } = record;
      const attempt = sanitizeAttempt(record.attempt, mapId);
      return [{ matchId, mapId, at, totalScore, survivorHits, hunterHit, lockCipherMatch, ...(attempt && { attempt }) }];
    });
  } catch {
    return [];
  }
}

export function appendPracticeHistory(storage: StorageLike | null, record: PracticeRecord): PracticeRecord[] {
  const { matchId, mapId, at, totalScore, survivorHits, hunterHit, lockCipherMatch } = record;
  const attempt = sanitizeAttempt(record.attempt, mapId);
  const history = [...readPracticeHistory(storage), {
    matchId, mapId, at, totalScore, survivorHits, hunterHit, lockCipherMatch, ...(attempt && { attempt }),
  }].slice(-200);
  try {
    storage?.setItem(PRACTICE_STORAGE_KEY, JSON.stringify(history));
  } catch {
    // Preserve the result in the current session.
  }
  return history;
}
