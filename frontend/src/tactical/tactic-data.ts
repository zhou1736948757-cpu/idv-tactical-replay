/**
 * Movement speeds, movement buffs (trait/talent/other), treasure rule, and board defaults (zero DOM).
 */
import { tZh } from './locales-zh';
import { TAC_HUNTER_ROLES, TAC_SURVIVOR_ROLES } from './roles-roster';
import { TAC_TALENT_TYPES } from './talents';
import type {
  BuffSpeedSpec,
  MovementOtherSpeedBuff,
  MovementTalentSpeedBuff,
  MovementTraitSpeedBuff,
  RoleDefinition,
  RoleSpeedGroup,
  TreasureRule,
} from './types';

function deriveTalentSpeedBuffs(): Record<string, MovementTalentSpeedBuff> {
  const out: Record<string, MovementTalentSpeedBuff> = {};
  for (const [key, t] of Object.entries(TAC_TALENT_TYPES)) {
    const sb: BuffSpeedSpec | undefined = t.buff?.speedBuff;
    if (!sb) continue;
    const { aim: _aim, extra, ...rest } = sb;
    const entry: MovementTalentSpeedBuff = {
      name: t.name,
      ...rest,
      camp: t.camp,
    };
    if (extra) {
      const extraTalent = TAC_TALENT_TYPES[extra.talent];
      entry.extra = {
        name: tZh('application.buff.common.name.level', {
          name: extraTalent ? extraTalent.name : extra.talent,
          value: extra.level,
        }),
        mult: extra.mult,
        camp: t.camp,
      };
    }
    out[key] = entry;
  }
  return out;
}

function deriveTraitSpeedBuffs(roles: Readonly<Record<string, RoleDefinition>>): MovementTraitSpeedBuff[] {
  const out: MovementTraitSpeedBuff[] = [];
  for (const r of Object.values(roles)) {
    for (const [traitKey, t] of Object.entries(r.traits ?? {})) {
      if (!t.speedBuff) continue;
      const { aim: _aim, ...rest } = t.speedBuff;
      out.push({
        key: traitKey,
        role: r.name,
        name: t.name,
        ...rest,
      });
    }
  }
  return out;
}

function deriveSurvivorSpeedGroup(group: 'role' | 'fixed'): Record<string, RoleSpeedGroup> {
  const out: Record<string, RoleSpeedGroup> = {};
  for (const [roleKey, r] of Object.entries(TAC_SURVIVOR_ROLES)) {
    for (const s of r.speeds ?? []) {
      if (s.group === group) {
        const form = s.form ?? 0;
        out[`${roleKey}:${form}`] = {
          name: s.name,
          speed: s.speed,
          role: roleKey,
          form,
        };
      }
    }
  }
  return out;
}

export const TAC_MOVEMENT_SURVIVOR = {
  states: {
    run: { name: tZh('movement.survivor.run'), speed: 3.8 },
    walk: { name: tZh('movement.survivor.walk'), speed: 2.11 },
    crouch: { name: tZh('movement.survivor.crouch'), speed: 1.14 },
    crawl: { name: tZh('movement.survivor.crawl'), speed: 0.44 },
  },
  roles: {
    survivor: { name: tZh('characters.camps.survivor'), speed: 3.8, role: null } as RoleSpeedGroup,
    ...deriveSurvivorSpeedGroup('role'),
  } as Record<string, RoleSpeedGroup>,
  fixed: deriveSurvivorSpeedGroup('fixed') as Record<string, RoleSpeedGroup>,
  stateNames: {
    run: tZh('movement.survivor.run'),
    walk: tZh('movement.survivor.walk'),
    crouch: tZh('movement.survivor.crouch'),
    crawl: tZh('movement.survivor.crawl'),
    role: tZh('common.roles'),
    fixed: tZh('movement.survivor.fixed'),
    custom: tZh('common.custom'),
    hunter: tZh('characters.camps.hunter'),
  } as Record<string, string>,
} as const;

export const TAC_MOVEMENT_BUFFS: {
  trait: {
    survivor: MovementTraitSpeedBuff[];
    hunter: MovementTraitSpeedBuff[];
  };
  talent: Record<string, MovementTalentSpeedBuff>;
  other: {
    survivor: MovementOtherSpeedBuff[];
    hunter: MovementOtherSpeedBuff[];
  };
} = {
  trait: {
    survivor: deriveTraitSpeedBuffs(TAC_SURVIVOR_ROLES),
    hunter: deriveTraitSpeedBuffs(TAC_HUNTER_ROLES),
  },
  talent: deriveTalentSpeedBuffs(),
  other: {
    survivor: [
      { key: 'fastMusicbox', name: tZh('movement.buff.other.fastMusicbox.name'), levels: [1.15, 1.25, 1.35] },
      { key: 'swarmAround', name: tZh('movement.buff.other.swarmAround.name'), mult: 1.1 },
      { key: 'urgentLetter', name: tZh('movement.buff.other.urgentLetter.name'), mult: 1.1, duration: 15 },
      { key: 'farewellLetter', name: tZh('movement.buff.other.farewellLetter.name'), mult: 1.4, duration: 3 },
      { key: 'cheerful', name: tZh('movement.buff.other.cheerful.name'), mult: 1.5, duration: 1.3 },
      { key: 'entangled', name: tZh('movement.buff.other.entangled.nameAlternate'), levels: [0.92, 0.5] },
      { key: 'corruptingBreath', name: tZh('movement.buff.other.corruptingBreath.name'), mult: 0.7, duration: 3 },
      { key: 'demonNotes', name: tZh('movement.buff.other.demonNotes.name'), levels: [0.96, 0.92, 0.88] },
      { key: 'peeper', name: tZh('movement.buff.other.peeper.name'), mult: 0.94 },
    ],
    hunter: [
      { key: 'slowMusicbox', name: tZh('movement.buff.other.slowMusicbox.name'), levels: [0.88, 0.79, 0.7] },
      { key: 'stickyBomb', name: tZh('movement.buff.other.stickyBomb.name'), mult: 0.7, duration: 5 },
      { key: 'pounce', name: tZh('movement.buff.other.pounce.name'), mult: 0.65, duration: 2.5 },
    ],
  },
};

export const TAC_MEASURE_DEFAULT = {
  single: { color: '#eab308', width: 2 },
  chain: { color: '#f97316', width: 2 },
} as const;

export const TAC_DISPLAY_DEFAULT = {
  spawnSize: 6,
  escapeDoorSize: 6,
  cipherSize: 6,
  dungeonSize: 6,
  rocketChairSize: 6,
  lockerSize: 3,
  boxSize: 3,
  phoneBoothSize: 3,
} as const;

export const TAC_ABYSS_MAX_M = 57.5;

export const TAC_TREASURE_RULE: TreasureRule = {
  rangeM: 70,
  ringM: [5.5, 7.3],
};

export const TAC_MANAGE_DEFAULT = {
  roleSize: 6,
  iconSize: 3.4,
} as const;
