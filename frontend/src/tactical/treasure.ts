/**
 * Explorer treasure password page ring geometry (zero DOM).
 * Ported from pil-tactical-friend/js/core/treasure.js.
 */
import { TAC_TREASURE_RULE } from './tactic-data';
import type { CipherPoint, PilMapData, TreasureRing, TreasureRule, TreasureTokenLike } from './types';

export function getTreasureRings(
  map: Pick<PilMapData, 'mapSize' | 'widthM' | 'ciphers' | 'cipherCombinations'>,
  token: TreasureTokenLike | null | undefined,
  cipherIndex: number,
  rule: TreasureRule = TAC_TREASURE_RULE,
): TreasureRing[] {
  if (!map.widthM || !token?.showTreasureRange) return [];
  const [width, height] = map.mapSize;
  const metresPerPixel = map.widthM / width;
  const combo = map.cipherCombinations[cipherIndex] ?? [];

  const candidates = combo
    .map((id) => map.ciphers.find((cipher) => cipher.id === id))
    .filter((cipher): cipher is CipherPoint => Boolean(cipher))
    .map((cipher) => ({
      cipher,
      distance: Math.hypot(
        (cipher.location[0] - token.x * width) * metresPerPixel,
        (cipher.location[1] - token.y * height) * metresPerPixel,
      ),
    }));

  const nearest = candidates.reduce<{ cipher: CipherPoint; distance: number } | null>(
    (best, candidate) => (!best || candidate.distance < best.distance ? candidate : best),
    null,
  );

  // Preserve same-cipher exclusion rule and its 0.7 m tolerance (<= 8.0m).
  const excludedId =
    nearest && nearest.distance <= rule.ringM[1] + 0.7 ? nearest.cipher.id : null;

  return candidates
    .filter(({ distance }) => distance <= rule.rangeM)
    .map(({ cipher }) => ({
      cipherId: cipher.id,
      x: cipher.location[0] / width,
      y: cipher.location[1] / height,
      innerRadius: rule.ringM[0] / map.widthM,
      outerRadius: rule.ringM[1] / map.widthM,
      excluded: cipher.id === excludedId,
    }));
}
