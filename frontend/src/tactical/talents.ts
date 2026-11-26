/**
 * All PIL Survivor & Hunter talents (zero external URLs, zero DOM).
 */
import { tZh } from './locales-zh';
import { TAC_HUNTER_ROLES, TAC_SURVIVOR_ROLES } from './roles-roster';
import type { TalentDefinition } from './types';

// 恐惧半径的修正标签：角色名（可选形态名）+ 由倍率推导的百分比，避免把加成值写死在语言键里
const fearLabel = (roleName: string, formName: string | null, mult: number): string => {
  const name = [roleName, formName].filter(Boolean).join(true ? '' : ' ');
  return tZh("talent.survivor.fearRadius.range.mode.fmt", {
    name, value: `${mult > 1 ? '+' : ''}${Math.round((mult - 1) * 100)}%` });
};

// 恐惧半径修正：数据源在角色条目下（survivor.js / hunter.js 的 fearRadius 字段），此处派生
const FEAR_MODS: { hunter: Array<[string, string, number]>; survivor: Array<[string, string, number]> } = {
  hunter: [['hunter', tZh("characters.camps.hunter"), 1]],
  survivor: [['survivor', tZh("characters.camps.survivor"), 1]],
};
Object.entries(TAC_HUNTER_ROLES).forEach(([, r]) => {
  ((r.fearRadius || {}).forms || []).forEach((f) => {
    FEAR_MODS.hunter.push([f.key, fearLabel(r.name, f.name, f.mult), f.mult]);
  });
});
Object.entries(TAC_SURVIVOR_ROLES).forEach(([roleKey, r]) => {
  const fr = r.fearRadius || {};
  if (fr.mult) FEAR_MODS.survivor.push([roleKey, fearLabel(r.name, null, fr.mult), fr.mult]);
});


// 角色人格（天赋）注册表：求生者 40 人格 + 恐惧半径，监管者 40 人格 + 耳鸣。
// 仅部分人格外加 ranges（有明确距离参数、需要在地图上画圈的）；其余只有名称和图标。
const RAW_TALENT_TYPES = {
  fearRadius: {
    name: tZh("talent.survivor.fearRadius"),
    camp: 'survivor' as const,
    ranges: {
      key: 'showItem' as const,
      fearMods: FEAR_MODS,
      options: [
        { size_m: 32.07, label: tZh("talent.survivor.fearRadius") },
      ],
    },
  },
  borrowedTime: {
    name: tZh("talent.survivor.borrowedTime"),
    camp: 'survivor' as const,
    buff: { speedBuff: { aim: 'survivor' as const, mult: 1.5, duration: 5, extra: { talent: 'escape', level: 3, mult: 1.05 } } },
  },
  tideTurner: {
    name: tZh("talent.survivor.tideTurner"),
    camp: 'survivor' as const,
  },
  kneeJerkReflex: {
    name: tZh("talent.survivor.kneeJerkReflex"),
    camp: 'survivor' as const,
    buff: { speedBuff: { aim: 'survivor' as const, mult: 1.5, duration: 3 } },
  },
  flywheelEffect: {
    name: tZh("talent.survivor.flywheelEffect"),
    camp: 'survivor' as const,
  },
  curiosity: {
    name: tZh("talent.survivor.curiosity"),
    camp: 'survivor' as const,
  },
  sticker: {
    name: tZh("talent.survivor.sticker"),
    camp: 'survivor' as const,
    buff: { speedBuff: { aim: 'survivor' as const, levels: [1.3, 1.6, 1.9], states: ['crawl'] } },
  },
  escape: {
    name: tZh("talent.survivor.escape"),
    camp: 'survivor' as const,
    buff: { speedBuff: { aim: 'survivor' as const, levels: [1.03, 1.04, 1.05] } },
  },
  distraction: {
    name: tZh("talent.survivor.distraction"),
    camp: 'survivor' as const,
  },
  snooze: {
    name: tZh("talent.survivor.snooze"),
    camp: 'survivor' as const,
  },
  touchEffect: {
    name: tZh("talent.survivor.touchEffect"),
    camp: 'survivor' as const,
    buff: { speedBuff: { aim: 'survivor' as const, levels: [1.16, 1.28, 1.4], duration: 1.5 } },
  },
  telepathy: {
    name: tZh("talent.survivor.telepathy"),
    camp: 'survivor' as const,
  },
  companionEffect: {
    name: tZh("talent.survivor.companionEffect"),
    camp: 'survivor' as const,
    buff: { speedBuff: { aim: 'survivor' as const, mult: 1.28, duration: 2 } },
  },
  audienceEffect: {
    name: tZh("talent.survivor.audienceEffect"),
    camp: 'survivor' as const,
  },
  birdcageEffect: {
    name: tZh("talent.survivor.birdcageEffect"),
    camp: 'survivor' as const,
    buff: { speedBuff: { aim: 'survivor' as const, mult: 1.1 } },
  },
  saviorComplex: {
    name: tZh("talent.survivor.saviorComplex"),
    camp: 'survivor' as const,
    buff: { speedBuff: { aim: 'survivor' as const, levels: [1.05, 1.1, 1.15], duration: 3 } },
  },
  herdMentality: {
    name: tZh("talent.survivor.herdMentality"),
    camp: 'survivor' as const,
    buff: { speedBuff: { aim: 'survivor' as const, levels: [1.04, 1.06, 1.08] } },
  },
  sneak: {
    name: tZh("talent.survivor.sneak"),
    camp: 'survivor' as const,
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: 22, label: tZh("talent.survivor.sneak") },
      ],
    },
  },
  doctor: {
    name: tZh("talent.survivor.doctor"),
    camp: 'survivor' as const,
  },
  shelter: {
    name: tZh("talent.survivor.shelter"),
    camp: 'survivor' as const,
  },
  catharsisEffect: {
    name: tZh("talent.survivor.catharsisEffect"),
    camp: 'survivor' as const,
  },
  emergencyReserves: {
    name: tZh("talent.survivor.emergencyReserves"),
    camp: 'survivor' as const,
  },
  empathy: {
    name: tZh("talent.survivor.empathy"),
    camp: 'survivor' as const,
    buff: { speedBuff: { aim: 'survivor' as const, mult: 1.14, duration: 12 } },
  },
  riskyMove: {
    name: tZh("talent.survivor.riskyMove"),
    camp: 'survivor' as const,
  },
  horseflyEffect: {
    name: tZh("talent.survivor.horseflyEffect"),
    camp: 'survivor' as const,
  },
  muscleMemory: {
    name: tZh("talent.survivor.muscleMemory"),
    camp: 'survivor' as const,
  },
  wellEarned: {
    name: tZh("talent.survivor.wellEarned"),
    camp: 'survivor' as const,
    buff: { speedBuff: { aim: 'survivor' as const, mult: 1.25, duration: 4 } },
  },
  greatPower: {
    name: tZh("talent.survivor.greatPower"),
    camp: 'survivor' as const,
  },
  willToSurvive: {
    name: tZh("talent.survivor.willToSurvive"),
    camp: 'survivor' as const,
    buff: {
      struggleBuff: { aim: 'survivor' as const, levels: [0.10, 0.15, 0.20] },
    },
  },
  exitPath: {
    name: tZh("talent.survivor.exitPath"),
    camp: 'survivor' as const,
  },
  brewingEffect: {
    name: tZh("talent.survivor.brewingEffect"),
    camp: 'survivor' as const,
  },
  sensoryAdaptation: {
    name: tZh("talent.survivor.sensoryAdaptation"),
    camp: 'survivor' as const,
  },
  herdBehavior: {
    name: tZh("talent.survivor.herdBehavior"),
    camp: 'survivor' as const,
  },
  boldGambit: {
    name: tZh("talent.survivor.boldGambit"),
    camp: 'survivor' as const,
  },
  webersLaw: {
    name: tZh("talent.survivor.webersLaw"),
    camp: 'survivor' as const,
    buff: { speedBuff: { aim: 'survivor' as const, levels: [1.1, 1.15, 1.2], duration: 3.5 } },
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: 18, label: tZh("talent.survivor.webersLaw") },
      ],
    },
  },
  survivorsInstinct: {
    name: tZh("talent.survivor.survivorsInstinct"),
    camp: 'survivor' as const,
  },
  healing: {
    name: tZh("talent.survivor.healing"),
    camp: 'survivor' as const,
  },
  defenseMechanism: {
    name: tZh("talent.survivor.defenseMechanism"),
    camp: 'survivor' as const,
  },
  mutualSupport: {
    name: tZh("talent.survivor.mutualSupport"),
    camp: 'survivor' as const,
    buff: { speedBuff: { aim: 'survivor' as const, levels: [1.04, 1.08] } },
  },
  symbioticEffect: {
    name: tZh("talent.survivor.symbioticEffect"),
    camp: 'survivor' as const,
    buff: { speedBuff: { aim: 'survivor' as const, levels: [1.06, 1.1] } },
  },
  attachmentEffect: {
    name: tZh("talent.survivor.attachmentEffect"),
    camp: 'survivor' as const,
  },
  tinnitus: {
    name: tZh("talent.hunter.tinnitus"),
    camp: 'hunter' as const,
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: 36, label: tZh("talent.hunter.tinnitus") },
      ],
    },
  },
  trumpCard: {
    name: tZh("talent.hunter.trumpCard"),
    camp: 'hunter' as const,
  },
  detention: {
    name: tZh("talent.hunter.detention"),
    camp: 'hunter' as const,
  },
  insolence: {
    name: tZh("talent.hunter.insolence"),
    camp: 'hunter' as const,
  },
  confinedSpace: {
    name: tZh("talent.hunter.confinedSpace"),
    camp: 'hunter' as const,
  },
  constrain: {
    name: tZh("talent.hunter.constrain"),
    camp: 'hunter' as const,
  },
  huntersInstinct: {
    name: tZh("talent.hunter.huntersInstinct"),
    camp: 'hunter' as const,
    buff: { speedBuff: { aim: 'hunter' as const, levels: [1.01, 1.015, 1.02], carry: true } },
  },
  hospitable: {
    name: tZh("talent.hunter.hospitable"),
    camp: 'hunter' as const,
    buff: { speedBuff: { aim: 'hunter' as const, levels: [1.04, 1.06, 1.08], carry: true } },
  },
  announcement: {
    name: tZh("talent.hunter.announcement"),
    camp: 'hunter' as const,
  },
  wantedOrder: {
    name: tZh("talent.hunter.wantedOrder"),
    camp: 'hunter' as const,
    buff: { speedBuff: { aim: 'hunter' as const, levels: [0.98, 0.99, 1], carry: true } },
  },
  impact: {
    name: tZh("talent.hunter.impact"),
    camp: 'hunter' as const,
  },
  desperateFight: {
    name: tZh("talent.hunter.desperateFight"),
    camp: 'hunter' as const,
  },
  addiction: {
    name: tZh("talent.hunter.addiction"),
    camp: 'hunter' as const,
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: 20, label: tZh("talent.hunter.addiction") },
      ],
    },
  },
  nostalgic: {
    name: tZh("talent.hunter.nostalgic"),
    camp: 'hunter' as const,
    buff: { speedBuff: { aim: 'hunter' as const, mult: 1.1, duration: 14 } },
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: 32, label: tZh("talent.hunter.nostalgic") },
      ],
    },
  },
  inertia: {
    name: tZh("talent.hunter.inertia"),
    camp: 'hunter' as const,
  },
  mock: {
    name: tZh("talent.hunter.mock"),
    camp: 'hunter' as const,
    buff: { speedBuff: { aim: 'hunter' as const, levels: [1.03, 1.04, 1.05], carry: true } },
  },
  carnival: {
    name: tZh("talent.hunter.carnival"),
    camp: 'hunter' as const,
    buff: { speedBuff: { aim: 'hunter' as const, levels: [1.03, 1.04, 1.05], duration: 120, carry: true } },
  },
  tippingPoint: {
    name: tZh("talent.hunter.tippingPoint"),
    camp: 'hunter' as const,
  },
  sadist: {
    name: tZh("talent.hunter.sadist"),
    camp: 'hunter' as const,
  },
  giantClaw: {
    name: tZh("talent.hunter.giantClaw"),
    camp: 'hunter' as const,
    buff: {
      struggleBuff: { aim: 'survivor' as const, levels: [-0.05, -0.10, -0.15] },
      dropBuff: { aim: 'survivor' as const, levels: [18, 12, 6] },
    },
  },
  overwhelm: {
    name: tZh("talent.hunter.overwhelm"),
    camp: 'hunter' as const,
  },
  impulsive: {
    name: tZh("talent.hunter.impulsive"),
    camp: 'hunter' as const,
  },
  skittish: {
    name: tZh("talent.hunter.skittish"),
    camp: 'hunter' as const,
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: 12, label: tZh("talent.hunter.skittish") },
      ],
    },
  },
  deerHunt: {
    name: tZh("talent.hunter.deerHunt"),
    camp: 'hunter' as const,
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: 18, label: tZh("talent.hunter.deerHunt") },
      ],
    },
  },
  tolerance: {
    name: tZh("talent.hunter.tolerance"),
    camp: 'hunter' as const,
  },
  afterEffects: {
    name: tZh("talent.hunter.afterEffects"),
    camp: 'hunter' as const,
  },
  exhibitionist: {
    name: tZh("talent.hunter.exhibitionist"),
    camp: 'hunter' as const,
  },
  hunt: {
    name: tZh("talent.hunter.hunt"),
    camp: 'hunter' as const,
    buff: { speedBuff: { aim: 'hunter' as const, mult: 1.1 } },
  },
  streetSweeper: {
    name: tZh("talent.hunter.streetSweeper"),
    camp: 'hunter' as const,
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: [30, 45, 60], label: tZh("talent.hunter.streetSweeper") },
      ],
    },
  },
  controlFreak: {
    name: tZh("talent.hunter.controlFreak"),
    camp: 'hunter' as const,
    buff: { speedBuff: { aim: 'hunter' as const, mult: 1.1, duration: 3, carry: true } },
  },
  claustrophobia: {
    name: tZh("talent.hunter.claustrophobia"),
    camp: 'hunter' as const,
  },
  lingeringMight: {
    name: tZh("talent.hunter.lingeringMight"),
    camp: 'hunter' as const,
    buff: { speedBuff: { aim: 'hunter' as const, mult: 1.1, duration: 50 } },
  },
  deteriorate: {
    name: tZh("talent.hunter.deteriorate"),
    camp: 'hunter' as const,
  },
  wither: {
    name: tZh("talent.hunter.wither"),
    camp: 'hunter' as const,
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: 10, label: tZh("talent.hunter.wither") },
      ],
    },
  },
  destructiveness: {
    name: tZh("talent.hunter.destructiveness"),
    camp: 'hunter' as const,
  },
  panic: {
    name: tZh("talent.hunter.panic"),
    camp: 'hunter' as const,
  },
  rage: {
    name: tZh("talent.hunter.rage"),
    camp: 'hunter' as const,
  },
  berserk: {
    name: tZh("talent.hunter.berserk"),
    camp: 'hunter' as const,
  },
  obsession: {
    name: tZh("talent.hunter.obsession"),
    camp: 'hunter' as const,
    buff: { speedBuff: { aim: 'hunter' as const, mult: 1.05, duration: 15 } },
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: 16, label: tZh("talent.hunter.obsession") },
      ],
    },
  },
  mischievous: {
    name: tZh("talent.hunter.mischievous"),
    camp: 'hunter' as const,
    buff: { pickupBuff: { aim: 'hunter' as const, levels: [0.20] } },
  },
  famine: {
    name: tZh("talent.hunter.famine"),
    camp: 'hunter' as const,
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: 16, label: tZh("talent.hunter.famine") },
      ],
    },
  },
};

// 各阵营人格道具键清单：roles.js 的 items 直接引用，新增人格只需改本文件
export const TAC_TALENT_KEYS: { readonly survivor: readonly string[]; readonly hunter: readonly string[] } = {
  survivor: [
    'fearRadius',
    'borrowedTime',
    'tideTurner',
    'kneeJerkReflex',
    'flywheelEffect',
    'curiosity',
    'sticker',
    'escape',
    'distraction',
    'snooze',
    'touchEffect',
    'telepathy',
    'companionEffect',
    'audienceEffect',
    'birdcageEffect',
    'saviorComplex',
    'herdMentality',
    'sneak',
    'doctor',
    'shelter',
    'catharsisEffect',
    'emergencyReserves',
    'empathy',
    'riskyMove',
    'horseflyEffect',
    'muscleMemory',
    'wellEarned',
    'greatPower',
    'willToSurvive',
    'exitPath',
    'brewingEffect',
    'sensoryAdaptation',
    'herdBehavior',
    'boldGambit',
    'webersLaw',
    'survivorsInstinct',
    'healing',
    'defenseMechanism',
    'mutualSupport',
    'symbioticEffect',
    'attachmentEffect'
  ],
  hunter: [
    'tinnitus',
    'trumpCard',
    'detention',
    'insolence',
    'confinedSpace',
    'constrain',
    'huntersInstinct',
    'hospitable',
    'announcement',
    'wantedOrder',
    'impact',
    'desperateFight',
    'addiction',
    'nostalgic',
    'inertia',
    'mock',
    'carnival',
    'tippingPoint',
    'sadist',
    'giantClaw',
    'overwhelm',
    'impulsive',
    'skittish',
    'deerHunt',
    'tolerance',
    'afterEffects',
    'exhibitionist',
    'hunt',
    'streetSweeper',
    'controlFreak',
    'claustrophobia',
    'lingeringMight',
    'deteriorate',
    'wither',
    'destructiveness',
    'panic',
    'rage',
    'berserk',
    'obsession',
    'mischievous',
    'famine'
  ],
};


export const TAC_TALENT_TYPES: Readonly<Record<string, TalentDefinition>> = Object.fromEntries(
  Object.entries(RAW_TALENT_TYPES).map(([key, entry]) => [
    key,
    {
      ...entry,
      key,
      glyph: entry.name.replace(/["“”\s]/g, '').slice(0, 2) || '?',
    } as TalentDefinition,
  ]),
);
