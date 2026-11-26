/**
 * Combined PIL role registry (survivors, hunters, skills, talents, custom props) with zero external URLs.
 */
import { tZh } from './locales-zh';
import {
  SHIPPED_HUNTER_PORTRAITS,
  TAC_HUNTER_ROLES,
  TAC_SURVIVOR_ROLES,
} from './roles-roster';
import { TAC_TALENT_KEYS } from './talents';
import type { RoleDefinition } from './types';

export { SHIPPED_HUNTER_PORTRAITS, TAC_HUNTER_ROLES, TAC_SURVIVOR_ROLES };

export const TAC_CUSTOM_KEYS: readonly string[] = [
  'customSurvivor',
  'customHunter',
  'customEscapeDoor',
  'customCipherMachine',
  'customDungeon',
  'customRocketChair',
  'customLocker',
  'customBox',
  'customPhoneBooth',
];

export const TAC_ROLES: Readonly<Record<string, RoleDefinition>> = {
  ...TAC_SURVIVOR_ROLES,
  ...TAC_HUNTER_ROLES,
  custom: {
    key: 'custom',
    name: tZh('characters.custom.name'),
    camp: 'other',
    glyph: '自',
    color: '#fbbf24',
    portraitUrl: null,
    ranges: {
      key: 'show',
      options: [{ size_m: { min: 0, max: null }, label: tZh('characters.custom.name') }],
    },
    items: [...TAC_CUSTOM_KEYS],
  },
  skill: {
    key: 'skill',
    name: tZh('characters.skill.name'),
    camp: 'other',
    glyph: '技',
    color: '#c9a25f',
    portraitUrl: null,
    items: ['listen', 'abnormal', 'excitement', 'patroller', 'teleport', 'peeper', 'blink', 'warp'],
  },
  talentSurvivor: {
    key: 'talentSurvivor',
    name: tZh('characters.talentSurvivor.name'),
    camp: 'other',
    glyph: '求',
    color: '#6f8fb8',
    portraitUrl: null,
    items: [...TAC_TALENT_KEYS.survivor],
  },
  talentHunter: {
    key: 'talentHunter',
    name: tZh('characters.talentHunter.name'),
    camp: 'other',
    glyph: '监',
    color: '#b04a58',
    portraitUrl: null,
    items: [...TAC_TALENT_KEYS.hunter],
  },
};
