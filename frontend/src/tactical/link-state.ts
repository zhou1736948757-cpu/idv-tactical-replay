import { MAPS_DATA } from './maps';
import { mapsZonesRelative } from './geo';
import type { DeduceMarksState, PilMapId, StorageLike } from './types';

export const LINK_STORAGE_KEY = 'idv.pil.v2.link';
export interface TacticalLink {
  source: 'manual' | 'replay' | 'deduce' | 'practice';
  matchId?: string;
  groupIndex: number | null;
  survivorZones?: number[];
  hunterZone?: number | null;
  marks?: DeduceMarksState;
}

function sanitize(mapId: PilMapId, raw: unknown): TacticalLink | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Partial<TacticalLink>;
  const map = MAPS_DATA[mapId];
  if (!map || !value.source || !['manual', 'replay', 'deduce', 'practice'].includes(value.source)) return null;
  const result: TacticalLink = { source: value.source, groupIndex: null };
  if (typeof value.matchId === 'string' && /^[0-9a-f]{24}$/i.test(value.matchId)) result.matchId = value.matchId;
  if (typeof value.groupIndex === 'number' && Number.isInteger(value.groupIndex) &&
    value.groupIndex >= 0 && value.groupIndex < map.cipherCombinations.length) result.groupIndex = value.groupIndex;
  const validZone = (zone: unknown): zone is number => typeof zone === 'number' &&
    Number.isInteger(zone) && zone >= 0 && zone < mapsZonesRelative[mapId]!.length;
  if (Array.isArray(value.survivorZones)) result.survivorZones = [...new Set(value.survivorZones.filter(validZone))].slice(0, 4);
  if (validZone(value.hunterZone) || value.hunterZone === null) result.hunterZone = value.hunterZone;
  if (value.marks && typeof value.marks === 'object') {
    result.marks = {};
    map.ciphers.forEach((cipher, index) => {
      const mark = value.marks?.[index];
      if (!cipher.locked && (mark === 'yes' || mark === 'no')) result.marks![index] = mark;
    });
  }
  return result;
}

function read(storage: StorageLike | null): Record<string, TacticalLink> {
  const links: Record<string, TacticalLink> = {};
  try {
    const raw: unknown = JSON.parse(storage?.getItem(LINK_STORAGE_KEY) ?? '{}');
    if (raw && typeof raw === 'object') {
      MAPS_DATA.forEach(({ mapId }) => {
        const link = sanitize(mapId, (raw as Record<string, unknown>)[mapId]);
        if (link) links[mapId] = link;
      });
    }
  } catch {
    // A corrupt or unavailable store starts empty.
  }
  return links;
}

export function readTacticalLink(storage: StorageLike | null, mapId: PilMapId, hiddenMatch: string | null = null): TacticalLink | null {
  const link = read(storage)[mapId];
  if (hiddenMatch && link?.matchId === hiddenMatch && link.source === 'replay') return null;
  return link ?? null;
}

export function writeTacticalLink(storage: StorageLike | null, mapId: PilMapId, value: TacticalLink, explicit = false): boolean {
  const links = read(storage);
  if (!explicit && links[mapId]?.source === 'manual' && value.source !== 'manual') return false;
  const link = sanitize(mapId, value);
  if (!link || !storage) return false;
  links[mapId] = link;
  try {
    storage.setItem(LINK_STORAGE_KEY, JSON.stringify(links));
    return true;
  } catch {
    return false;
  }
}
