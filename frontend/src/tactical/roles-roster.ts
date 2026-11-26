/**
 * All PIL Survivor & Hunter role definitions with local portrait paths (zero external URLs, zero DOM).
 */
import { tZh } from './locales-zh';
import type { RoleDefinition } from './types';
import { withBaseUrl } from '@/lib/assetUrl';

export const SHIPPED_HUNTER_PORTRAITS: ReadonlySet<string> = new Set([
  '26号守卫', '使徒', '博士', '厂长', '台球手', '喧嚣', '噩梦', '女王蜂', '孽蜥',
  '守夜人', '宿伞之魂', '小丑', '小提琴家', '心兽', '愚人金', '摄影师', '时空之影', '杂货商',
  '杰克', '梦之女巫', '歌剧演员', '渔女', '爱哭鬼', '牙医', '疯眼', '破轮', '红夫人',
  '红蝶', '蜘蛛', '蜡像师', '记录员', '跛脚羊', '隐士', '雕刻家', '鹿头', '黄衣之主',
]);

function roleGlyph(name: string): string {
  const clean = name.replace(/["“”\s]/g, '');
  return clean.slice(0, 2) || '?';
}

function localHunterPortrait(name: string): string | null {
  const clean = name.replace(/["“”]/g, '');
  return SHIPPED_HUNTER_PORTRAITS.has(clean) ? withBaseUrl(encodeURI(`/assets/hunters/${clean}.png`)) : null;
}

// 求生者角色数据：名称、特殊移速、特质、范围、道具、头像
// speeds: 角色专属基础移速（form 形态序号；group 决定归入“角色”还是“固定”移速组）
const RAW_SURVIVOR_ROLES = {
  luckyGuy: {
    name: tZh("characters.luckyGuy.name"),
    camp: 'survivor' as const,
    ranges: {
      key: 'showTrait' as const,
      options: [
        { size_m: 25.3, label: tZh("characters.luckyGuy.range.detectChestNearby") },
      ],
    },
    items: ['luckyParcel'],
  },
  doctor: {
    name: tZh("characters.doctor.name"),
    camp: 'survivor' as const,
    traits: {
      sensitivity: { name: tZh("movement.buff.trait.doctor.sensitivity.name"),
                     speedBuff: { aim: 'survivor' as const, mult: 1.45, duration: 2 } },
    },
    items: ['syringe'],
  },
  lawyer: {
    name: tZh("characters.lawyer.name"),
    camp: 'survivor' as const,
    traits: {
      takeNotes: { name: tZh("movement.buff.trait.lawyer.takeNotes.name"),
                   speedBuff: { aim: 'survivor' as const, mult: 1.035 } },
    },
    items: ['map'],
  },
  thief: {
    name: tZh("characters.thief.name"),
    camp: 'survivor' as const,
    ranges: {
      key: 'showTrait' as const,
      options: [
        { size_m: 8, label: tZh("characters.thief.range.flashlightShining") },
      ],
    },
    items: ['flashlight'],
  },
  gardener: {
    name: tZh("characters.gardener.name"),
    camp: 'survivor' as const,
    ranges: {
      key: 'showTrait' as const,
      options: [
        { size_m: 15, label: tZh("characters.gardener.range.locateRocketChairNearby") },
      ],
    },
    items: ['toolkit'],
  },
  magician: {
    name: tZh("characters.magician.name"),
    camp: 'survivor' as const,
    traits: {
      illusion: { name: tZh("movement.buff.trait.magician.illusion.name"),
                  speedBuff: { aim: 'survivor' as const, mult: 1.5, duration: 0.87 } },
    },
    items: ['wand'],
  },
  explorer: {
    name: tZh("characters.explorer.name"),
    camp: 'survivor' as const,
    traits: {
      tinyLilliputian: { name: tZh("movement.buff.trait.explorer.tinyLilliputian.name"),
                         speedBuff: { aim: 'survivor' as const, mult: 0.9 } },
      energyReserves: { name: tZh("movement.buff.trait.explorer.energyReserves.name"),
                        speedBuff: { aim: 'survivor' as const, mult: 1.35, duration: 4 } },
    },
    ranges: {
      key: 'showTrait' as const,
      options: [
        { size_m: 60, label: tZh("characters.explorer.range.senseHunter") },
        { size_m: 70, label: tZh("characters.explorer.range.passwordPage") },
      ],
    },
    items: ['gulliversTravels' ,'passwordPage'],
  },
  mercenary: {
    name: tZh("characters.mercenary.name"),
    camp: 'survivor' as const,
    items: ['elbowPads', 'elbowPadsOff'],
  },
  coordinator: {
    name: tZh("characters.coordinator.name"),
    camp: 'survivor' as const,
    traits: {
      armyBond: { name: tZh("movement.buff.trait.coordinator.armyBond.name"),
                  speedBuff: { aim: 'survivor' as const, mult: 1.05 } },
    },
    ranges: {
      key: 'showTrait' as const,
      options: [
        { size_m: 10, label: tZh("characters.coordinator.range.flareGunCanUse") },
      ],
    },
    items: ['flareGun'],
  },
  mechanic: {
    name: tZh("characters.mechanic.name"),
    camp: 'survivor' as const,
    items: ['mechanicsDoll', 'mechanicsDollControl'],
  },
  forward: {
    name: tZh("characters.forward.name"),
    camp: 'survivor' as const,
    traits: {
      dashFootball: { name: tZh("movement.buff.trait.forward.dashFootball.name"),
                      speedBuff: { aim: 'survivor' as const, mult: 3 } },
      struggle: { name: tZh("struggle.buff.trait.forward.struggle.name"),
                  struggleBuff: { aim: 'survivor' as const, levels: [0.10] } },
    },
    items: ['football'],
  },
  theMindsEye: {
    name: tZh("characters.theMindsEye.name"),
    camp: 'survivor' as const,
    traits: {
      tapTapWalk: { name: tZh("movement.buff.trait.theMindsEye.tapTapWalk.name"),
                    speedBuff: { aim: 'survivor' as const, mult: 1.25, states: ['walk'] } },
      tapTap: { name: tZh("movement.buff.trait.theMindsEye.tapTap.name"),
                speedBuff: { aim: 'survivor' as const, mult: 1.3, duration: 2, states: ['run'] } },
    },
    ranges: {
      key: 'showTrait' as const,
      options: [
        { size_m: 25.3, label: tZh("characters.theMindsEye.range.tapTapLocatePosition") },
        { size_m: 6.8, label: tZh("characters.theMindsEye.range.strikeInteractionSpeedReduceOne") },
        { size_m: 25.3, label: tZh("characters.theMindsEye.range.strikeInteractionSpeedReduceTwo") },
      ],
    },
    items: ['cane'],
  },
  priestess: {
    name: tZh("characters.priestess.name"),
    camp: 'survivor' as const,
    items: ['straightPassage', 'ultralongPassage'],
  },
  perfumer: {
    name: tZh("characters.perfumer.name"),
    camp: 'survivor' as const,
    items: ['euphoriaPerfume'],
  },
  cowboy: {
    name: tZh("characters.cowboy.name"),
    camp: 'survivor' as const,
    ranges: {
      key: 'showTrait' as const,
      options: [
        { size_m: 15.2, label: tZh("characters.cowboy.range.lassoHitMax") },
      ],
    },
    items: ['lasso'],
  },
  femaleDancer: {
    name: tZh("characters.femaleDancer.name"),
    camp: 'survivor' as const,
    ranges: {
      key: 'showTrait' as const,
      options: [
        { size_m: 8.44, label: tZh("characters.femaleDancer.range.slide") },
      ],
    },
    items: ['fastMusicbox', 'slowMusicbox', 'musicboxSwitch'],
  },
  seer: {
    name: tZh("characters.seer.name"),
    camp: 'survivor' as const,
    items: ['owl'],
  },
  embalmer: {
    name: tZh("characters.embalmer.name"),
    camp: 'survivor' as const,
    items: ['makeupBox', 'coffin'],
  },
  prospector: {
    name: tZh("characters.prospector.name"),
    camp: 'survivor' as const,
    ranges: {
      key: 'showTrait' as const,
      options: [
        { size_m: 14.5, label: tZh("characters.prospector.range.magnetThrowMax") },
        { size_m: 18, label: tZh("characters.prospector.range.stunReduce") },
      ],
    },
    items: ['meteoriteMagnetN', 'meteoriteMagnetS'],
  },
  enchantress: {
    name: tZh("characters.enchantress.name"),
    camp: 'survivor' as const,
    ranges: {
      key: 'showTrait' as const,
      options: [
        { size_m: 5.1, label: tZh("characters.enchantress.range.apeCurseParalyze") },
        { size_m: 16.9, label: tZh("characters.enchantress.range.guardStack") },
        { size_m: 12.7, label: tZh("characters.enchantress.range.guardStackReduce") },
      ],
    },
    items: ['cursedEmblem', 'cursedEmblemSpecial'],
  },
  wildling: {
    name: tZh("characters.wildling.name"),
    camp: 'survivor' as const,
    speeds: [
      { form: 0, group: 'role' as const, name: tZh("movement.survivor.wildling0"), speed: 3.65 },
    ],
    traits: {
      ridingFullRage: { name: tZh("movement.buff.trait.wildling.ridingFullRage.name"),
                        speedBuff: { aim: 'survivor' as const, mult: 1.33 } },
    },
    ranges: {
      key: 'showTrait' as const,
      options: [
        { size_m: 15, label: tZh("characters.wildling.range.bumpMax") },
        { size_m: 17, label: tZh("characters.wildling.range.bumpAddKnockBackMax") },
      ],
    },
    items: ['wildlingPartner', 'wildlingPartnerRide', 'wildlingPartnerFollowingState', 'wildlingPartnerRidingState', 'wildlingPartnerRidingStateCross'],
  },
  acrobat: {
    name: tZh("characters.acrobat.name"),
    camp: 'survivor' as const,
    ranges: {
      key: 'showTrait' as const,
      options: [
        { size_m: 4, label: tZh("characters.acrobat.range.leapDefault") },
        { size_m: 7.5, label: tZh("characters.acrobat.range.leapMax") },
        { size_m: 12, label: tZh("characters.acrobat.range.leapAddSomersault") },
      ],
    },
    items: ['stickyBomb', 'nitroBomb', 'fireBomb', 'stickyBombThrow', 'nitroBombThrow', 'fireBombThrow'],
  },
  firstOfficer: {
    name: tZh("characters.firstOfficer.name"),
    camp: 'survivor' as const,
    ranges: {
      key: 'showTrait' as const,
      options: [
        { size_m: 27, label: tZh("characters.firstOfficer.range.hypnotize1") },
        { size_m: 8.4, label: tZh("characters.firstOfficer.range.hypnotize2") },
        { size_m: 5.1, label: tZh("characters.firstOfficer.range.hypnotize3") },
      ],
    },
    items: ['poseidonWatch'],
  },
  barmaid: {
    name: tZh("characters.barmaid.name"),
    camp: 'survivor' as const,
    traits: {
      duphrin: { name: tZh("movement.buff.trait.barmaid.duphrin.name"),
                 speedBuff: { aim: 'survivor' as const, mult: 1.5, duration: 2 } },
    },
    items: ['duphrin', 'strongDovlin', 'mixDovlin'],
  },
  postman: {
    name: tZh("characters.postman.name"),
    camp: 'survivor' as const,
    ranges: {
      key: 'showTrait' as const,
      options: [
        { size_m: 16.9, label: tZh("characters.postman.range.postDogDashMax") },
      ],
    },
    items: ['letter', 'postDog'],
  },
  graveKeeper: {
    name: tZh("characters.graveKeeper.name"),
    camp: 'survivor' as const,
    traits: {
      undergroundSneak: { name: tZh("movement.buff.trait.graveKeeper.undergroundSneak.name"),
                          speedBuff: { aim: 'survivor' as const, mult: 1.1 } },
    },
    ranges: {
      key: 'showTrait' as const,
      options: [
        { size_m: 9.7, label: tZh("characters.graveKeeper.range.tremor") },
      ],
    },
    items: ['shovel', 'shovelEmerge'],
  },
  prisoner: {
    name: tZh("characters.prisoner.name"),
    camp: 'survivor' as const,
    fearRadius: { mult: 0.8 },
    ranges: {
      key: 'showTrait' as const,
      options: [
        { size_m: 5.9, label: tZh("characters.prisoner.range.severeElectricCurrentStun") },
      ],
    },
    items: ['insulatingGloves', 'severeElectricCurrent', 'electricalArea'],
  },
  entomologist: {
    name: tZh("characters.entomologist.name"),
    camp: 'survivor' as const,
    items: ['swarmNet', 'swarmNetWave'],
  },
  painter: {
    name: tZh("characters.painter.name"),
    camp: 'survivor' as const,
    traits: {
      aestheticResonance: { name: tZh("movement.buff.trait.painter.aestheticResonance.name"),
                            speedBuff: { aim: 'survivor' as const, levels: [1.02, 1.04] } },
    },
    items: ['paintBruahAndDrawingBoard', 'drawingBoard'],
  },
  batter: {
    name: tZh("characters.batter.name"),
    camp: 'survivor' as const,
    traits: {
      altruism: { name: tZh("movement.buff.trait.batter.altruism.name"),
                  speedBuff: { aim: 'survivor' as const, mult: 1.5, duration: 10 } },
    },
    ranges: {
      key: 'showTrait' as const,
      options: [
        { size_m: 10.1, label: tZh("characters.batter.range.cricketBatCanHit") },
        { size_m: 17.55, label: tZh("characters.batter.range.cricketBatHitAddKnockBackMax") },
        { size_m: 15.2, label: tZh("characters.batter.range.altruism") },
      ],
    },
    items: ['cricketBat', 'rampage'],
  },
  toyMerchant: {
    name: tZh("characters.toyMerchant.name"),
    camp: 'survivor' as const,
    speeds: [
      { form: 0, group: 'fixed' as const, name: tZh("movement.survivor.toyMerchant0"), speed: 5.74 },
    ],
    traits: {
      landing: { name: tZh("movement.buff.trait.toyMerchant.landing.name"),
                 speedBuff: { aim: 'survivor' as const, mult: 1.3, duration: 2 } },
    },
    items: ['catapult', 'woodenWings', 'toyBox', 'toyContainer'],
  },
  psychologist: {
    name: tZh("characters.psychologist.name"),
    camp: 'survivor' as const,
    ranges: {
      key: 'showTrait' as const,
      options: [
        { size_m: 13, label: tZh("characters.psychologist.range.subjectiveAnchor") },
        { size_m: 13, label: tZh("characters.psychologist.range.bonded") },
      ],
    },
    items: ['whistle', 'subjectiveAnchor', 'bonded'],
  },
  patient: {
    name: tZh("characters.patient.name"),
    camp: 'survivor' as const,
    ranges: {
      key: 'showTrait' as const,
      options: [
        { size_m: 13, label: tZh("characters.patient.range.bonded") },
      ],
    },
    items: ['grapplingHook', 'bonded'],
  },
  novelist: {
    name: tZh("characters.novelist.name"),
    camp: 'survivor' as const,
    traits: {
      resonance: { name: tZh("movement.buff.trait.novelist.resonance.name"),
                   speedBuff: { aim: 'survivor' as const, mult: 1.5, duration: 2.5 } },
    },
    ranges: {
      key: 'showTrait' as const,
      options: [
        { size_m: 13.5, label: tZh("characters.novelist.range.metaphorDefault") },
        { size_m: 9.8, label: tZh("characters.novelist.range.metaphorReduce") },
      ],
    },
    items: ['sketchBook'],
  },
  littleGirl: {
    name: tZh("characters.littleGirl.name"),
    camp: 'survivor' as const,
    ranges: {
      key: 'showTrait' as const,
      options: [
        { size_m: 3.4, label: tZh("characters.littleGirl.range.memorySync") },
      ],
    },
    items: ['memoryFragment', 'memorySync', 'pity'],
  },
  weepingClown: {
    name: tZh("characters.weepingClown.name"),
    camp: 'survivor' as const,
    traits: {
      rocketDash: { name: tZh("movement.buff.trait.weepingClown.rocketDash.name"),
                    speedBuff: { aim: 'survivor' as const, mult: 1.5 } },
    },
    ranges: {
      key: 'showTrait' as const,
      options: [
        { size_m: 6, label: tZh("characters.weepingClown.range.rocketExplode") },
        { size_m: 3, label: tZh("characters.weepingClown.range.stunHunter") },
      ],
    },
    items: ['rocket'],
  },
  professor: {
    name: tZh("characters.professor.name"),
    camp: 'survivor' as const,
    items: ['scale', 'injection'],
  },
  antiquarian: {
    name: tZh("characters.antiquarian.name"),
    camp: 'survivor' as const,
    traits: {
      concealedSpin: { name: tZh("movement.buff.trait.antiquarian.concealedSpin.name"),
                       speedBuff: { aim: 'survivor' as const, mult: 1.05 } },
    },
    ranges: {
      key: 'showTrait' as const,
      options: [
        { size_m: 4.9, label: tZh("characters.antiquarian.range.flip") },
        { size_m: 3.5, label: tZh("characters.antiquarian.range.sweepSwing") },
        { size_m: 4.7, label: tZh("characters.antiquarian.range.stab") },
        { size_m: 12.7, label: tZh("characters.antiquarian.range.obscure") },
      ],
    },
    items: ['mechanicalFlute'],
  },
  composer: {
    name: tZh("characters.composer.name"),
    camp: 'survivor' as const,
    traits: {
      tuning: { name: tZh("movement.buff.trait.composer.tuning.name"),
                speedBuff: { aim: 'survivor' as const, mult: 1.5 } },
    },
    items: ['tuningFork'],
  },
  journalist: {
    name: tZh("characters.journalist.name"),
    camp: 'survivor' as const,
    ranges: {
      key: 'showTrait' as const,
      options: [
        { size_m: 15, label: tZh("characters.journalist.range.phantomPlacement") },
      ],
    },
    items: ['cameraJournalist'],
  },
  aeroplanist: {
    name: tZh("characters.aeroplanist.name"),
    camp: 'survivor' as const,
    ranges: {
      key: 'showTrait' as const,
      options: [
        { size_m: 18.5, label: tZh("characters.aeroplanist.range.jetpackPropelThreeMax") },
        { size_m: 12.7, label: tZh("characters.aeroplanist.range.essentialTremor") },
      ],
    },
    items: ['jetpack', 'jetpackPropel'],
  },
  cheerleader: {
    name: tZh("characters.cheerleader.name"),
    camp: 'survivor' as const,
    traits: {
      motivate: { name: tZh("movement.buff.trait.cheerleader.motivate.name"),
                  speedBuff: { aim: 'survivor' as const, mult: 1.7, duration: 4 } },
    },
    ranges: {
      key: 'showTrait' as const,
      options: [
        { size_m: 20, label: tZh("characters.cheerleader.range.encourage") },
      ],
    },
    items: ['pompoms', 'inspire', 'inspireIcon', 'encourage1', 'encourage2', 'encourageCheerful', 'encourageExcited'],
  },
  puppeteer: {
    name: tZh("characters.puppeteer.name"),
    camp: 'survivor' as const,
    traits: {
      flexibleJoints: { name: tZh("movement.buff.trait.puppeteer.flexibleJoints.name"),
                        speedBuff: { aim: 'survivor' as const, mult: 1.08, duration: 9 } },
    },
    items: ['louis'],
  },
  fireInvestigator: {
    name: tZh("characters.fireInvestigator.name"),
    camp: 'survivor' as const,
    traits: {
      firefightingTraining: { name: tZh("movement.buff.trait.fireInvestigator.firefightingTraining.name"),
                              speedBuff: { aim: 'survivor' as const, mult: 1.5, duration: 2 } },
    },
    ranges: {
      key: 'showTrait' as const,
      options: [
        { size_m: 4.2, label: tZh("characters.fireInvestigator.range.deployDefault") },
        { size_m: 12.64, label: tZh("characters.fireInvestigator.range.deployMax") },
        { size_m: 9.6, label: tZh("characters.fireInvestigator.range.repulsion") },
      ],
    },
    items: ['airbag'],
  },
  faroLady: {
    name: tZh("characters.faroLady.name"),
    camp: 'survivor' as const,
    ranges: {
      key: 'showTrait' as const,
      options: [
        { size_m: 18, label: tZh("characters.faroLady.range.cloak") },
      ],
    },
    items: ['aromatherapyCane', 'dexterous'],
  },
  knight: {
    name: tZh("characters.knight.name"),
    camp: 'survivor' as const,
    ranges: {
      key: 'showTrait' as const,
      options: [
        { size_m: 13, label: tZh("characters.knight.range.tacticalForesight") },
        { size_m: 7, label: tZh("characters.knight.range.chivalrousSympathy") },
      ],
    },
    items: ['helmet', 'tacticalForesight', 'tacticalForesightAttack', 'tacticalForesightAbility', 'tacticalForesightStalemate', 'chivalrousSympathy'],
  },
  meteorologist: {
    name: tZh("characters.meteorologist.name"),
    camp: 'survivor' as const,
    traits: {
      stratus: { name: tZh("movement.buff.trait.meteorologist.stratus.name"),
                 speedBuff: { aim: 'survivor' as const, levels: [1.33, 1.77] } },
    },
    ranges: {
      key: 'showTrait' as const,
      options: [
        { size_m: 32, label: tZh("characters.meteorologist.range.warmRain") },
      ],
    },
    items: ['stormGlass', 'gale1', 'gale2', 'gale3', 'stratus1', 'stratus2', 'stratus3', 'rainfall', 'stormGlassDecompose'],
  },
  archer: {
    name: tZh("characters.archer.name"),
    camp: 'survivor' as const,
    fearRadius: { mult: 0.76 },
    ranges: {
      key: 'showTrait' as const,
      options: [
        { size_m: 18, label: tZh("characters.archer.range.keelBowHitMax") },
        { size_m: 12, label: tZh("characters.archer.range.keelBowCanHitCore") },
        { size_m: 4.5, label: tZh("characters.archer.range.crossbow") },
      ],
    },
    items: ['keelBow', 'crossBow'],
  },
  escapologist: {
    name: tZh("characters.escapologist.name"),
    camp: 'survivor' as const,
    traits: {
      smokeScreen: { name: tZh("movement.buff.trait.escapologist.smokeScreen.name"),
                     speedBuff: { aim: 'survivor' as const, mult: 1.35, duration: 1 } },
    },
    items: ['thurible', 'escapeAct'],
  },
  lanternist: {
    name: tZh("characters.lanternist.name"),
    camp: 'survivor' as const,
    speeds: [
      { form: 0, group: 'fixed' as const, name: tZh("movement.survivor.lanternist0"), speed: 4.18 },
    ],
    items: ['projectionLanternLivingImage', 'projectionLanternStaticProjection'],
  },
  matador: {
    name: tZh("characters.matador.name"),
    camp: 'survivor' as const,
    ranges: {
      key: 'showTrait' as const,
      options: [
        { size_m: 6, label: tZh("characters.matador.range.muletaDash") },
        { size_m: 2.25, label: tZh("characters.matador.range.muletaSweep") },
      ],
    },
    items: ['muleta', 'gaoneraPass'],
  },
  mimeArtist: {
    name: tZh("characters.mimeArtist.name"),
    camp: 'survivor' as const,
    ranges: {
      key: 'showTrait' as const,
      options: [
        { size_m: 20.3, label: tZh("characters.mimeArtist.range.emotionAccumulation") },
      ],
    },
    items: ['propUmbrella'],
  },
  prodigy: {
    name: tZh("characters.prodigy.name"),
    camp: 'survivor' as const,
    items: ['hamster', 'hamsterCancel', 'dirtball', 'pushingState', 'performanceState'],
    speeds: [
      { form: 0, group: 'role' as const, name: tZh("movement.survivor.prodigy0"), speed: 3.92 },
      { form: 1, group: 'fixed' as const, name: tZh("movement.survivor.prodigy1"), speed: 3.8 },
    ],
  },
};

// 监管者角色数据：名称、移速、范围、道具、头像
const RAW_HUNTER_ROLES = {
  hellEmber: {
    name: tZh("characters.hellEmber.name"),
    camp: 'hunter' as const,
    traits: {
      kindlingWrath: { name: tZh("movement.buff.trait.hellEmber.kindlingWrath.name"),
                       speedBuff: { aim: 'hunter' as const, mult: 1.08, duration: 8 } },
      puppetSwitchPosition: { name: tZh("movement.buff.trait.hellEmber.puppetSwitchPosition.name"),
                              speedBuff: { aim: 'hunter' as const, mult: 1.5, duration: 1.5 } },
    },
    speed: 4.73,
    ranges: {
      key: 'showTrait' as const,
      options: [
        { size_m: 55, label: tZh("characters.hellEmber.range.puppetCastMax") },
      ],
    },
    items: ['phantom', 'puppet1', 'puppet2'],
  },
  smileyFace: {
    name: tZh("characters.smileyFace.name"),
    camp: 'hunter' as const,
    traits: {
      rockerDash: { name: tZh("movement.buff.trait.smileyFace.rockerDash.name"),
                    speedBuff: { aim: 'hunter' as const, levels: [1.55, 1.62, 2] } },
      windWings: { name: tZh("movement.buff.trait.smileyFace.windWings.name"),
                   speedBuff: { aim: 'hunter' as const, mult: 1.2 } },
      propeller: { name: tZh("movement.buff.trait.smileyFace.propeller.name"),
                   speedBuff: { aim: 'hunter' as const, mult: 0.9, postMult: true } },
    },
    speed: 4.56,
    ranges: {
      key: 'showTrait' as const,
      options: [
        { size_m: 19.5, label: tZh("characters.smileyFace.range.rocketDashMaxTier1") },
        { size_m: 26, label: tZh("characters.smileyFace.range.rocketDashMaxTier2") },
        { size_m: 24, label: tZh("characters.smileyFace.range.partSeen") },
      ],
    },
    items: ['windWings', 'drill', 'propeller', 'rocketDash'],
  },
  gameKeeper: {
    name: tZh("characters.gameKeeper.name"),
    camp: 'hunter' as const,
    traits: {
      chainHookSwing: { name: tZh("movement.buff.trait.gameKeeper.chainHookSwing.name"),
                        speedBuff: { aim: 'hunter' as const, mult: 0.95, postMult: true } },
    },
    speed: 4.64,
    items: ['chainHook', 'trap'],
  },
  theRipper: {
    name: tZh("characters.theRipper.name"),
    camp: 'hunter' as const,
    traits: {
      hiddenInMist: { name: tZh("movement.buff.trait.theRipper.hiddenInMist.name"),
                      speedBuff: { aim: 'hunter' as const, mult: 1.15 } },
      fogZone: { name: tZh("movement.buff.trait.theRipper.fogZone.name"),
                 speedBuff: { aim: 'hunter' as const, mult: 1.2 } },
    },
    speed: 4.73,
    items: ['fogZone', 'freezingFog', 'hiddenInMist'],
  },
  soulWeaver: {
    name: tZh("characters.soulWeaver.name"),
    camp: 'hunter' as const,
    traits: {
      entangled: { name: tZh("movement.buff.trait.soulWeaver.entangled.name"),
                   speedBuff: { aim: 'hunter' as const, levels: [1.25, 1.46, 1.675] } },
    },
    speed: 4.56,
    items: ['cocoon', 'webbing', 'spinning'],
  },
  geisha: {
    name: tZh("characters.geisha.name"),
    camp: 'hunter' as const,
    traits: {
      dashHit: { name: tZh("movement.buff.trait.geisha.dashHit.name"),
                 speedBuff: { aim: 'hunter' as const, mult: 3 } },
    },
    fearRadius: { forms: [
      { key: 'beauty', name: tZh("characters.geisha.beautyForm"), mult: 0.8 },
      { key: 'prajna', name: tZh("characters.geisha.prajnaForm"), mult: 1.1 },
    ] },
    speed: { [tZh("characters.geisha.beautyForm")]: 4.73, [tZh("characters.geisha.prajnaForm")]: 4.56 },
    items: ['swallowtailButterfly', 'dashHit', 'soulDeparture'],
  },
  wuchang: {
    name: tZh("characters.wuchang.name"),
    camp: 'hunter' as const,
    traits: {
      withoutUmbrella: { name: tZh("movement.buff.trait.wuchang.withoutUmbrella.name"),
                         speedBuff: { aim: 'hunter' as const, mult: 1.1 } },
      siphonSoul: { name: tZh("movement.buff.trait.wuchang.siphonSoul.name"),
                    speedBuff: { aim: 'hunter' as const, mult: 1.65, forms: [0] } },
    },
    speed: { [tZh("characters.wuchang.xieBiAn")]: 4.73, [tZh("characters.wuchang.fanWuJiu")]: 4.56 },
    items: ['umbrella', 'siphonSoulWaveringSoul'],
  },
  photographer: {
    name: tZh("characters.photographer.name"),
    camp: 'hunter' as const,
    speed: 4.64,
    ranges: {
      key: 'showTrait' as const,
      options: [
        { size_m: 33, label: tZh("characters.photographer.range.locateCamera") },
      ],
    },
    items: ['camera', 'recordedMoment', 'timeJump'],
  },
  madEyes: {
    name: tZh("characters.madEyes.name"),
    camp: 'hunter' as const,
    speed: 4.64,
    items: ['console', 'fence', 'portableConsole', 'overlock'],
  },
  theFeaster: {
    name: tZh("characters.theFeaster.name"),
    camp: 'hunter' as const,
    traits: {
      tentaclesCharged: { name: tZh("movement.buff.trait.theFeaster.tentaclesCharged.name"),
                          speedBuff: { aim: 'hunter' as const, mult: 0.94, postMult: true } },
    },
    speed: 4.64,
    ranges: {
      key: 'showTrait' as const,
      options: [
        { size_m: 42.2, label: tZh("characters.theFeaster.range.tentaclePlacement") },
        { size_m: 21.1, label: tZh("characters.theFeaster.range.tentacleControlHit") },
        { size_m: 21.1, label: tZh("characters.theFeaster.range.nightmareGaze") },
      ],
    },
    items: ['tentacles', 'nightmareAttack', 'nightmareGaze'],
  },
  dreamWitch: {
    name: tZh("characters.dreamWitch.name"),
    camp: 'hunter' as const,
    traits: {
      followerOutOfRadius: { name: tZh("movement.buff.trait.dreamWitch.followerOutOfRadius.name"),
                             speedBuff: { aim: 'hunter' as const, mult: 1.3, postMult: true, forms: [1] } },
    },
    speed: { [tZh("characters.dreamWitch.originalBody")]: 6.08, [tZh("items.dreamWitch.follower.name")]: 4.56 },
    ranges: {
      key: 'showTrait' as const,
      options: [
        { size_m: 20, label: tZh("characters.dreamWitch.range.hiddenDreamsurvivorNotification") },
        { size_m: 42.2, label: tZh("characters.dreamWitch.range.followerControlTier0Tier1") },
        { size_m: 59.1, label: tZh("characters.dreamWitch.range.followerControlTier2") },
      ],
    },
    items: ['follower', 'witchMark', 'hiddenDream', 'preach', 'leech'],
  },
  axeBoy: {
    name: tZh("characters.axeBoy.name"),
    camp: 'hunter' as const,
    traits: {
      restfulRoad: { name: tZh("movement.buff.trait.axeBoy.restfulRoad.name"),
                     speedBuff: { aim: 'hunter' as const, mult: 2 } },
      dispelSouls: { name: tZh("movement.buff.trait.axeBoy.dispelSouls.name"),
                     speedBuff: { aim: 'hunter' as const, mult: 1.4, duration: 2.6 } },
    },
    speed: 4.56,
    items: ['peacefulPine', 'resentfulSoul', 'restfulRoad'],
  },
  evilReptilian: {
    name: tZh("characters.evilReptilian.name"),
    camp: 'hunter' as const,
    speed: 4.64,
    ranges: {
      key: 'showTrait' as const,
      options: [
        { size_m: 3, label: tZh("characters.evilReptilian.range.lethalCrash") },
      ],
    },
    items: ['preyingLeap', 'crash', 'lethalCrash'],
  },
  bloodyQueen: {
    name: tZh("characters.bloodyQueen.name"),
    camp: 'hunter' as const,
    speed: 4.64,
    ranges: {
      key: 'showTrait' as const,
      options: [
        { size_m: 25.3, label: tZh("characters.bloodyQueen.range.aquaMirrorPlacement") },
      ],
    },
    items: ['aquaMirror', 'mirrorRotation'],
  },
  guard26: {
    name: tZh("characters.guard26.name"),
    camp: 'hunter' as const,
    speed: 4.64,
    ranges: {
      key: 'showTrait' as const,
      options: [
        { size_m: 35.5, label: tZh("characters.guard26.range.bombThrowMax") },
      ],
    },
    items: ['timeBomb', 'remoteControlledBomb'],
  },
  disciple: {
    name: tZh("characters.disciple.name"),
    camp: 'hunter' as const,
    speed: 4.73,
    ranges: {
      key: 'showTrait' as const,
      options: [
        { size_m: 30, label: tZh("characters.disciple.range.guidePlacement") },
        { size_m: 10.5, label: tZh("characters.disciple.range.catwalkTier0") },
        { size_m: 12.5, label: tZh("characters.disciple.range.catwalkTier2") },
      ],
    },
    items: ['cat', 'guide', 'catwalk'],
  },
  violinist: {
    name: tZh("characters.violinist.name"),
    camp: 'hunter' as const,
    traits: {
      musicNoteCharged: { name: tZh("movement.buff.trait.violinist.musicNoteCharged.name"),
                          speedBuff: { aim: 'hunter' as const, mult: 0.97, postMult: true } },
    },
    speed: 4.64,
    ranges: {
      key: 'showTrait' as const,
      options: [
        { size_m: 20.5, label: tZh("characters.violinist.range.musicNotePlacement") },
      ],
    },
    items: ['musicNote', 'infiniteMovement', 'terrifyingMelody'],
  },
  sculptor: {
    name: tZh("characters.sculptor.name"),
    camp: 'hunter' as const,
    traits: {
      sculptureCharged: { name: tZh("movement.buff.trait.sculptor.sculptureCharged.name"),
                          speedBuff: { aim: 'hunter' as const, mult: 0.97, postMult: true } },
    },
    speed: 4.64,
    ranges: {
      key: 'showTrait' as const,
      options: [
        { size_m: 22.5, label: tZh("characters.sculptor.range.sculpturePlacement") },
        { size_m: 12, label: tZh("characters.sculptor.range.hieroglyphicGraveyardHint") },
      ],
    },
    items: ['sculpture', 'sculptureOfNobility', 'hieroglyphicGraveyard'],
  },
  undead: {
    name: tZh("characters.undead.name"),
    camp: 'hunter' as const,
    traits: {
      overload: { name: tZh("movement.buff.trait.undead.overload.name"),
                  speedBuff: { aim: 'hunter' as const, mult: 0.92, postMult: true } },
    },
    speed: 4.73,
    items: ['kineticDashHit', 'chargedStrike', 'energyConversion'],
  },
  theBreakingWheel: {
    name: tZh("characters.theBreakingWheel.name"),
    camp: 'hunter' as const,
    speed: { [tZh("characters.theBreakingWheel.humanForm")]: 4.64, [tZh("characters.theBreakingWheel.wheelForm")]: 10.13 },
    ranges: {
      key: 'showTrait' as const,
      options: [
        { size_m: 11.8, label: tZh("characters.theBreakingWheel.range.pessimistic") },
        { size_m: 10.1, label: tZh("characters.theBreakingWheel.range.ridicule") },
      ],
    },
    items: ['wheelForm', 'nailBoard', 'wheelOfImpalement', 'pessimistic', 'ridicule'],
  },
  naiad: {
    name: tZh("characters.naiad.name"),
    camp: 'hunter' as const,
    traits: {
      slipstream: { name: tZh("movement.buff.trait.naiad.slipstream.name"),
                    speedBuff: { aim: 'hunter' as const, mult: 1.3 } },
    },
    speed: 4.64,
    items: ['spearfishing', 'surgingTides'],
  },
  waxArtist: {
    name: tZh("characters.waxArtist.name"),
    camp: 'hunter' as const,
    speed: 4.73,
    ranges: {
      key: 'showTrait' as const,
      options: [
        { size_m: 4.2, label: tZh("characters.waxArtist.range.waxenCoatSplash") },
      ],
    },
    items: ['waxBlock', 'moltenWax', 'waxSculpting'],
  },
  nightmare: {
    name: tZh("characters.nightmare.name"),
    camp: 'hunter' as const,
    traits: {
      poaching: { name: tZh("movement.buff.trait.nightmare.poaching.name"),
                  speedBuff: { aim: 'hunter' as const, mult: 1.13 } },
    },
    speed: 4.64,
    ranges: {
      key: 'showTrait' as const,
      options: [
        { size_m: 6.33, label: tZh("characters.nightmare.range.dive") },
      ],
    },
    items: ['raven', 'spy', 'badOmen'],
  },
  clerk: {
    name: tZh("characters.clerk.name"),
    camp: 'hunter' as const,
    traits: {
      justVerdict: { name: tZh("movement.buff.trait.clerk.justVerdict.name"),
                     speedBuff: { aim: 'hunter' as const, mult: 1.06, duration: 15 } },
    },
    speed: 4.73,
    ranges: {
      key: 'showTrait' as const,
      options: [
        { size_m: 20, label: tZh("characters.clerk.range.replayMax") },
      ],
    },
    items: ['record', 'inspect', 'replay', 'invalid'],
  },
  hermit: {
    name: tZh("characters.hermit.name"),
    camp: 'hunter' as const,
    speed: 4.64,
    items: ['electromagneticFieldN', 'electromagneticFieldS', 'secondDawn', 'reversePolarity', 'meditation'],
  },
  nightWatch: {
    name: tZh("characters.nightWatch.name"),
    camp: 'hunter' as const,
    traits: {
      windwalk: { name: tZh("movement.buff.trait.nightWatch.windwalk.name"),
                  speedBuff: { aim: 'hunter' as const, mult: 1.12, duration: 6 } },
    },
    speed: 4.64,
    ranges: {
      key: 'showTrait' as const,
      options: [
        { size_m: 15.9, label: tZh("characters.nightWatch.range.tempest") },
        { size_m: 11.8, label: tZh("characters.nightWatch.range.tempestCyclone") },
        { size_m: 15.2, label: tZh("characters.nightWatch.range.windwalkCharge") },
      ],
    },
    items: ['tempest', 'windwalk', 'tempestCyclone', 'windwalkCharge', 'windControl'],
  },
  operaSinger: {
    name: tZh("characters.operaSinger.name"),
    camp: 'hunter' as const,
    traits: {
      stealth: { name: tZh("movement.buff.trait.operaSinger.stealth.name"),
                 speedBuff: { aim: 'hunter' as const, mult: 1.08 } },
      anotherShadowRealmBonus: { name: tZh("movement.buff.trait.operaSinger.anotherShadowRealmBonus.name"),
                                 speedBuff: { aim: 'hunter' as const, mult: 1.45 } },
    },
    speed: 4.56,
    ranges: {
      key: 'showTrait' as const,
      options: [
        { size_m: 4.64, label: tZh("characters.operaSinger.range.shadowLeapTier0Tier1") },
        { size_m: 5.568, label: tZh("characters.operaSinger.range.shadowLeapTier2") },
      ],
    },
    items: ['remnant', 'shadowstrike'],
  },
  foolsGold: {
    name: tZh("characters.foolsGold.name"),
    camp: 'hunter' as const,
    speed: 4.64,
    ranges: {
      key: 'showTrait' as const,
      options: [
        { size_m: 40, label: tZh("characters.foolsGold.range.pickaxeThrowMax") },
        { size_m: 60, label: tZh("characters.foolsGold.range.pickaxeReturn") },
        { size_m: 60, label: tZh("characters.foolsGold.range.magneticRockPlacemnt") },
      ],
    },
    items: ['pickaxe', 'magneticRock'],
  },
  theShadow: {
    name: tZh("characters.theShadow.name"),
    camp: 'hunter' as const,
    speed: { [tZh("characters.theShadow.ivy")]: 4.64, [tZh("items.theShadow.yithian.name")]: 7.59 },
    ranges: {
      key: 'showTrait' as const,
      options: [
        { size_m: 15, label: tZh("characters.theShadow.range.corruption") },
      ],
    },
    items: ['yithian', 'ancientVisage', 'psychicIntrusion', 'corruptedOstracon'],
  },
  goatman: {
    name: tZh("characters.goatman.name"),
    camp: 'hunter' as const,
    speed: 4.64,
    items: ['cage', 'backstep'],
  },
  hullabaloo: {
    name: tZh("characters.hullabaloo.name"),
    camp: 'hunter' as const,
    traits: {
      attackMiss: { name: tZh("movement.buff.trait.hullabaloo.attackMiss.name"),
                    speedBuff: { aim: 'hunter' as const, mult: 0.3, postMult: true } },
    },
    speed: 5.10,
    ranges: {
      key: 'showTrait' as const,
      options: [
        { size_m: 3.54, label: tZh("characters.hullabaloo.range.bombsArea") },
      ],
    },
    items: ['cloneHullabaloo', 'encore', 'trapeze'],
  },
  peddler: {
    name: tZh("characters.peddler.name"),
    camp: 'hunter' as const,
    traits: {
      pettyGains: { name: tZh("movement.buff.trait.peddler.pettyGains.name"),
                    speedBuff: { aim: 'hunter' as const, mult: 1.08, duration: 10 } },
      metalAffinity: { name: tZh("movement.buff.trait.peddler.metalAffinity.name"),
                       speedBuff: { aim: 'hunter' as const, mult: 0.5, duration: 1, postMult: true } },
    },
    speed: 4.64,
    items: ['pettyGains', 'natureAffinity', 'mineralAffinity', 'metalAffinity'],
  },
  cueist: {
    name: tZh("characters.cueist.name"),
    camp: 'hunter' as const,
    traits: {
      inertia: { name: tZh("movement.buff.trait.cueist.inertia.name"),
                 speedBuff: { aim: 'hunter' as const, mult: 1.18, duration: 6 } },
    },
    speed: 4.64,
    ranges: {
      key: 'showTrait' as const,
      options: [
        { size_m: 15.2, label: tZh("characters.cueist.range.contactPointFirstPlacement") },
        { size_m: 8, label: tZh("characters.cueist.range.maxwellsDemon") },
        { size_m: { min: 8, max: 11 }, label: tZh("characters.cueist.range.cueBallCapturePlacement") },
      ],
    },
    items: ['contactPoint', 'cueBall', 'maxwellsDemon'],
  },
  queenBee: {
    name: tZh("characters.queenBee.name"),
    camp: 'hunter' as const,
    traits: {
      assimilationEffect: { name: tZh("movement.buff.trait.queenBee.assimilationEffect.name"),
                            speedBuff: { aim: 'hunter' as const, mult: 1.12 } },
    },
    speed: { [tZh("characters.queenBee.name")]: 4.64, [tZh("characters.queenBee.speed.hiveCluster")]: 12 },
    ranges: {
      key: 'showTrait' as const,
      options: [
        { size_m: 28, label: tZh("characters.queenBee.range.swarmOfInsectsControl") },
      ],
    },
    items: ['swarmOfInsects', 'stinger'],
  },
  dentist: {
    name: tZh("characters.dentist.name"),
    camp: 'hunter' as const,
    traits: {
      bacterialSymbiosis: { name: tZh("movement.buff.trait.dentist.bacterialSymbiosis.name"),
                            speedBuff: { aim: 'hunter' as const, mult: 1.05 } },
    },
    speed: 4.73,
    ranges: {
      key: 'showTrait' as const,
      options: [
        { size_m: 6.56, ringInner: 4.56, label: tZh("characters.dentist.range.dentalMirrorLensAngle1") },
        { size_m: 11.4, ringInner: 9.4, label: tZh("characters.dentist.range.dentalMirrorLensAngle2") },
        { size_m: 18.9, ringInner: 16.9, label: tZh("characters.dentist.range.dentalMirrorLensAngle3") },
        { size_m: { min: 12.7, max: 35 }, label: tZh("characters.dentist.range.beamPlacement") },
        { size_m: 32, label: tZh("characters.dentist.range.ultravioletFade") },
      ],
    },
    items: ['beam', 'dentalMirror', 'darkMire'],
  },
  herztier: {
    name: tZh("characters.herztier.name"),
    camp: 'hunter' as const,
    traits: {
      heightenedSenses: { name: tZh("movement.buff.trait.herztier.heightenedSenses.name"),
                          speedBuff: { aim: 'hunter' as const, mult: 1.08, duration: 10 } },
    },
    speed: 4.64,
    ranges: {
      key: 'showTrait' as const,
      options: [
        { size_m: 48, label: tZh("characters.herztier.range.bestialAwakening") },
        { size_m: [7, 14], label: tZh("characters.herztier.range.lunge") },
        { size_m: 25, label: tZh("characters.herztier.range.heightenedSenses") },
      ],
    },
    items: ['bestialAwakening', 'lunge', 'heightenedSenses'],
  },
};

function buildRoles(
  raw: Record<string, Omit<RoleDefinition, 'key' | 'glyph' | 'color' | 'portraitUrl'>>,
  camp: 'survivor' | 'hunter',
): Record<string, RoleDefinition> {
  const out: Record<string, RoleDefinition> = {};
  for (const [key, entry] of Object.entries(raw)) {
    out[key] = {
      ...entry,
      key,
      camp,
      glyph: roleGlyph(entry.name),
      color: camp === 'hunter' ? '#b04a58' : '#6f8fb8',
      portraitUrl: camp === 'hunter' ? localHunterPortrait(entry.name) : null,
    };
  }
  return out;
}

export const TAC_SURVIVOR_ROLES: Readonly<Record<string, RoleDefinition>> = buildRoles(
  RAW_SURVIVOR_ROLES as Record<string, Omit<RoleDefinition, 'key' | 'glyph' | 'color' | 'portraitUrl'>>,
  'survivor',
);

export const TAC_HUNTER_ROLES: Readonly<Record<string, RoleDefinition>> = buildRoles(
  RAW_HUNTER_ROLES as Record<string, Omit<RoleDefinition, 'key' | 'glyph' | 'color' | 'portraitUrl'>>,
  'hunter',
);
