/**
 * All PIL tactical prop & skill & talent item definitions with vector glyphs (zero external URLs, zero DOM).
 */
import { tZh } from './locales-zh';
import { TAC_CUSTOM_KEYS } from './roles';
import { TAC_TALENT_TYPES } from './talents';
import type { ItemDefinition } from './types';

export { TAC_CUSTOM_KEYS };

const COMMON_GLYPHS: Readonly<Record<string, { glyph: string; color: string }>> = {
  customSurvivor: { glyph: '求', color: '#6f8fb8' },
  customHunter: { glyph: '监', color: '#b04a58' },
  customEscapeDoor: { glyph: '门', color: '#c9a25f' },
  customCipherMachine: { glyph: '机', color: '#c9a25f' },
  customDungeon: { glyph: '窖', color: '#a855f7' },
  customRocketChair: { glyph: '椅', color: '#b04a58' },
  customLocker: { glyph: '柜', color: '#9a8f7a' },
  customBox: { glyph: '箱', color: '#c9a25f' },
  customPhoneBooth: { glyph: '电', color: '#6f8fb8' },
};

function itemGlyph(key: string, name: string): string {
  const mapped = COMMON_GLYPHS[key]?.glyph;
  if (mapped) return mapped;
  const clean = name.replace(/["“”()（）\s]/g, '');
  return clean.slice(0, 2) || '物';
}

// 通用地图图标 URL：出生点、逃生门、地窖、狂欢之椅、柜子、箱子、电话亭共用


// 通用自定义造物：出生点、逃生门、密码机、地窖、狂欢之椅、柜子、箱子，图标引用 COMMON_ICON_URL
const RAW_COMMON_ITEM_TYPES = {
  customSurvivor: {
    name: tZh("common.survivor"),
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: { min: 0, max: null }, label: tZh("common.survivor") },
      ],
    },
  },
  customHunter: {
    name: tZh("common.hunter"),
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: { min: 0, max: null }, label: tZh("common.hunter") },
      ],
    },
  },
  customEscapeDoor: {
    name: tZh("common.escapeDoor"),
  },
  customCipherMachine: {
    name: tZh("common.cipherMachine"),
  },
  customDungeon: {
    name: tZh("common.dungeon"),
  },
  customRocketChair: {
    name: tZh("common.rocketChair"),
  },
  customLocker: {
    name: tZh("common.locker"),
  },
  customBox: {
    name: tZh("common.box"),
  },
  customPhoneBooth: {
    name: tZh("common.phoneBooth"),
  },
};

export const TAC_COMMON_ITEM_TYPES: Readonly<Record<string, ItemDefinition>> = Object.fromEntries(
  Object.entries(RAW_COMMON_ITEM_TYPES).map(([key, entry]) => [
    key,
    {
      ...entry,
      key,
      glyph: itemGlyph(key, entry.name),
      color: COMMON_GLYPHS[key]?.color ?? '#c9a25f',
    } as ItemDefinition,
  ]),
);

const RAW_ITEM_TYPES = {
  luckyParcel: {
    name: tZh("items.luckyGuy.luckyParcel.name"),
  },
  syringe: {
    name: tZh("items.doctor.syringe.name"),
  },
  map: {
    name: tZh("items.lawyer.map.name"),
  },
  flashlight: {
    name: tZh("items.thief.flashlight.name"),
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: 8, label: tZh("items.thief.flashlight.name") },
      ],
    },
  },
  toolkit: {
    name: tZh("items.gardener.toolkit.name"),
  },
  wand: {
    name: tZh("items.magician.wand.name"),
  },
  gulliversTravels: {
    name: tZh("items.explorer.gulliversTravels.name"),
  },
  passwordPage: {
    name: tZh("items.explorer.passwordPage.name"),
  },
  elbowPads: {
    name: tZh("items.mercenary.elbowPads.name"),
  },
  elbowPadsOff: {
    name: tZh("items.mercenary.elbowPadsOff.name"),
  },
  flareGun: {
    name: tZh("items.coordinator.flareGun.name"),
  },
  mechanicsDoll: {
    name: tZh("items.mechanic.mechanicsDoll.name"),
  },
  mechanicsDollControl: {
    name: tZh("items.mechanic.mechanicsDollControl.name"),
  },
  football: {
    name: tZh("items.forward.football.name"),
  },
  cane: {
    name: tZh("items.theMindsEye.cane.name"),
  },
  straightPassage: {
    name: tZh("items.priestess.straightPassage.name"),
    render: 'link' as const,
    linkColor: '#f8fafc',
    linkWidth: 2,
  },
  ultralongPassage: {
    name: tZh("items.priestess.ultralongPassage.name"),
    render: 'link' as const,
    linkColor: '#f8fafc',
    linkWidth: 2,
  },
  euphoriaPerfume: {
    name: tZh("items.perfumer.euphoriaPerfume.name"),
  },
  lasso: {
    name: tZh("items.cowboy.lasso.name"),
    linkToRole: 'cowboy',
    linkMaxM: 15.2,
    linkColor: '#f8fafc',
    linkWidth: 2,
  },
  fastMusicbox: {
    name: tZh("items.femaleDancer.fastMusicbox.name"),
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: { min: 6.3, max: 9 }, label: tZh("items.femaleDancer.fastMusicbox.name") },
      ],
    },
    render: 'circle' as const,
    color: '#f472b6',
    fill: 'rgba(244, 114, 182, 0.22)',
    glow: 'rgba(244, 114, 182, 0.45)',
  },
  slowMusicbox: {
    name: tZh("items.femaleDancer.slowMusicbox.name"),
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: { min: 6.3, max: 9 }, label: tZh("items.femaleDancer.slowMusicbox.name") },
      ],
    },
    render: 'circle' as const,
    color: '#60a5fa',
    fill: 'rgba(96, 165, 250, 0.22)',
    glow: 'rgba(96, 165, 250, 0.45)',
  },
  musicboxSwitch: {
    name: tZh("items.femaleDancer.musicboxSwitch.name"),
  },
  owl: {
    name: tZh("items.seer.owl.name"),
  },
  makeupBox: {
    name: tZh("items.embalmer.makeupBox.name"),
  },
  coffin: {
    name: tZh("items.embalmer.coffin.name"),
  },
  meteoriteMagnetN: {
    name: tZh("items.prospector.meteoriteMagnetN.name"),
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: 4.5, label: tZh("items.prospector.meteoriteMagnetN.name") },
      ],
    },
    render: 'circle' as const,
    color: '#ef4444',
    fill: 'rgba(239, 68, 68, 0.22)',
    glow: 'rgba(239, 68, 68, 0.45)',
  },
  meteoriteMagnetS: {
    name: tZh("items.prospector.meteoriteMagnetS.name"),
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: 4.5, label: tZh("items.prospector.meteoriteMagnetS.name") },
      ],
    },
    render: 'circle' as const,
    color: '#1d4ed8',
    fill: 'rgba(29, 78, 216, 0.22)',
    glow: 'rgba(29, 78, 216, 0.45)',
  },
  cursedEmblem: {
    name: tZh("items.enchantress.cursedEmblem.name"),
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: 5.1, label: tZh("items.enchantress.cursedEmblem.range.apeCurseParalyze") },
      ],
    },
  },
  cursedEmblemSpecial: {
    name: tZh("items.enchantress.cursedEmblemSpecial.name"),
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: 5.1, label: tZh("items.enchantress.cursedEmblem.range.apeCurseParalyze") },
      ],
    },
  },
  wildlingPartner: {
    name: tZh("items.wildling.wildlingPartner.name"),
  },
  wildlingPartnerRide: {
    name: tZh("items.wildling.wildlingPartnerRide.name"),
  },
  wildlingPartnerFollowingState: {
    name: tZh("items.wildling.wildlingPartnerFollowingState.name"),
  },
  wildlingPartnerRidingState: {
    name: tZh("items.wildling.wildlingPartnerRidingState.name"),
  },
  wildlingPartnerRidingStateCross: {
    name: tZh("items.wildling.wildlingPartnerRidingStateCross.name"),
  },
  stickyBomb: {
    name: tZh("items.acrobat.stickyBomb.name"),
  },
  nitroBomb: {
    name: tZh("items.acrobat.nitroBomb.name"),
  },
  fireBomb: {
    name: tZh("items.acrobat.fireBomb.name"),
  },
  stickyBombThrow: {
    name: tZh("items.acrobat.stickyBombThrow.name"),
  },
  nitroBombThrow: {
    name: tZh("items.acrobat.nitroBombThrow.name"),
  },
  fireBombThrow: {
    name: tZh("items.acrobat.fireBombThrow.name"),
  },
  poseidonWatch: {
    name: tZh("items.firstOfficer.poseidonWatch.name"),
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: 27, label: tZh("items.firstOfficer.poseidonWatch.range.hypnotize1") },
        { size_m: 8.4, label: tZh("items.firstOfficer.poseidonWatch.range.hypnotize2") },
      ],
    },
  },
  duphrin: {
    name: tZh("items.barmaid.duphrin.name"),
  },
  strongDovlin: {
    name: tZh("items.barmaid.strongDovlin.name"),
  },
  mixDovlin: {
    name: tZh("items.barmaid.mixDovlin.name"),
  },
  letter: {
    name: tZh("items.postman.letter.name"),
  },
  postDog: {
    name: tZh("items.postman.postDog.name"),
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: 1.27, label: tZh("items.postman.postDog.range.postDogPounce") },
      ],
    },
  },
  shovel: {
    name: tZh("items.graveKeeper.shovel.name"),
  },
  shovelEmerge: {
    name: tZh("items.graveKeeper.shovelEmerge.name"),
  },
  insulatingGloves: {
    name: tZh("items.prisoner.insulatingGloves.name"),
  },
  severeElectricCurrent: {
    name: tZh("items.prisoner.severeElectricCurrent.name"),
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: 5.9, label: tZh("items.prisoner.severeElectricCurrent.range.severeElectricCurrentStun") },
      ],
    },
  },
  electricalArea: {
    name: tZh("items.prisoner.electricalArea.name"),
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: 9.5, label: tZh("items.prisoner.electricalArea.name") },
      ],
    },
  },
  swarmNet: {
    name: tZh("items.entomologist.swarmNet.name"),
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: 1.2, label: tZh("items.entomologist.swarmNet.name") },
      ],
    },
    render: 'circle' as const,
    color: '#d4a373',
    fill: 'rgba(212, 163, 115, 0.22)',
    glow: 'rgba(212, 163, 115, 0.45)',
    pushes: true,
  },
  swarmNetWave: {
    name: tZh("items.entomologist.swarmNetWave.name"),
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: 1.2, label: tZh("items.entomologist.swarmNetWave.name") },
      ],
    },
    render: 'circle' as const,
    color: '#d4a373',
    fill: 'rgba(212, 163, 115, 0.22)',
    glow: 'rgba(212, 163, 115, 0.45)',
    pushes: true,
  },
  paintBruahAndDrawingBoard: {
    name: tZh("items.painter.paintBruahAndDrawingBoard.name"),
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: 12, label: tZh("items.painter.paintBruahAndDrawingBoard.name") },
      ],
    },
    render: 'circle' as const,
    color: '#60a5fa',
    fill: 'rgba(96, 165, 250, 0.22)',
    glow: 'rgba(96, 165, 250, 0.45)',
  },
  drawingBoard: {
    name: tZh("items.painter.drawingBoard.name"),
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: 12, label: tZh("items.painter.drawingBoard.name") },
      ],
    },
    render: 'circle' as const,
    color: '#60a5fa',
    fill: 'rgba(96, 165, 250, 0.22)',
    glow: 'rgba(96, 165, 250, 0.45)',
  },
  cricketBat: {
    name: tZh("items.batter.cricketBat.name"),
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: { min: 3.73, max: 7.45 }, label: tZh("items.batter.cricketBat.range.cricketBatKnockBack") },
      ],
    },
  },
  rampage: {
    name: tZh("items.batter.rampage.name"),
  },
  catapult: {
    name: tZh("items.toyMerchant.catapult.name"),
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: 21.9, label: tZh("items.toyMerchant.catapult.name") },
      ],
    },
  },
  woodenWings: {
    name: tZh("items.toyMerchant.woodenWings.name"),
  },
  toyBox: {
    name: tZh("items.toyMerchant.toyBox.name"),
  },
  toyContainer: {
    name: tZh("items.toyMerchant.toyContainer.name"),
  },
  whistle: {
    name: tZh("items.psychologist.whistle.name"),
  },
  subjectiveAnchor: {
    name: tZh("items.psychologist.subjectiveAnchor.name"),
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: 13, label: tZh("items.psychologist.subjectiveAnchor.name") },
      ],
    },
  },
  bonded: {
    name: tZh("items.psychologist.bonded.name"),
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: 13, label: tZh("items.psychologist.bonded.name") },
      ],
    },
  },
  grapplingHook: {
    name: tZh("items.patient.grapplingHook.name"),
  },
  sketchBook: {
    name: tZh("items.novelist.sketchBook.name"),
  },
  memoryFragment: {
    name: tZh("items.littleGirl.memoryFragment.name"),
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: 6.1, label: tZh("items.littleGirl.memoryFragment.range.impact") },
        { size_m: 10.3, label: tZh("items.littleGirl.memoryFragment.range.impactAddLaunchMax") },
      ],
    },
  },
  memorySync: {
    name: tZh("items.littleGirl.memorySync.name"),
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: 3.4, label: tZh("items.littleGirl.memorySync.name") },
      ],
    },
  },
  pity: {
    name: tZh("items.littleGirl.pity.name"),
  },
  rocket: {
    name: tZh("items.weepingClown.rocket.name"),
  },
  scale: {
    name: tZh("items.professor.scale.name"),
  },
  injection: {
    name: tZh("items.professor.injection.name"),
  },
  mechanicalFlute: {
    name: tZh("items.antiquarian.mechanicalFlute.name"),
  },
  tuningFork: {
    name: tZh("items.composer.tuningFork.name"),
  },
  cameraJournalist: {
    name: tZh("items.journalist.cameraJournalist.name"),
  },
  jetpack: {
    name: tZh("items.aeroplanist.jetpack.name"),
  },
  jetpackPropel: {
    name: tZh("items.aeroplanist.jetpackPropel.name"),
  },
  pompoms: {
    name: tZh("items.cheerleader.pompoms.name"),
  },
  inspire: {
    name: tZh("items.cheerleader.inspire.name"),
  },
  inspireIcon: {
    name: tZh("items.cheerleader.inspireIcon.name"),
  },
  encourage1: {
    name: tZh("items.cheerleader.encourage1.name"),
  },
  encourage2: {
    name: tZh("items.cheerleader.encourage2.name"),
  },
  encourageCheerful: {
    name: tZh("items.cheerleader.encourageCheerful.name"),
  },
  encourageExcited: {
    name: tZh("items.cheerleader.encourageExcited.name"),
  },
  louis: {
    name: tZh("items.puppeteer.louis.name"),
  },
  airbag: {
    name: tZh("items.fireInvestigator.airbag.name"),
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: 4.2, label: tZh("items.fireInvestigator.airbag.name") },
      ],
    },
    render: 'circle' as const,
    color: '#f8fafc',
    fill: 'rgba(248, 250, 252, 0.22)',
    glow: 'rgba(248, 250, 252, 0.45)',
  },
  aromatherapyCane: {
    name: tZh("items.faroLady.aromatherapyCane.name"),
  },
  dexterous: {
    name: tZh("items.faroLady.dexterous.name"),
  },
  helmet: {
    name: tZh("items.knight.helmet.name"),
  },
  tacticalForesight: {
    name: tZh("items.knight.tacticalForesight.name"),
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: 13, label: tZh("items.knight.tacticalForesight.name") },
      ],
    },
  },
  tacticalForesightAttack: {
    name: tZh("items.knight.tacticalForesightAttack.name"),
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: 13, label: tZh("items.knight.tacticalForesight.name") },
      ],
    },
  },
  tacticalForesightAbility: {
    name: tZh("items.knight.tacticalForesightAbility.name"),
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: 13, label: tZh("items.knight.tacticalForesight.name") },
      ],
    },
  },
  tacticalForesightStalemate: {
    name: tZh("items.knight.tacticalForesightStalemate.name"),
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: 13, label: tZh("items.knight.tacticalForesight.name") },
      ],
    },
  },
  chivalrousSympathy: {
    name: tZh("items.knight.chivalrousSympathy.name"),
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: 7, label: tZh("items.knight.chivalrousSympathy.name") },
      ],
    },
  },
  stormGlass: {
    name: tZh("items.meteorologist.stormGlass.name"),
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: 4, label: tZh("items.meteorologist.stormGlass.range.rainfall") },
      ],
    },
    render: 'circle' as const,
    color: '#f8fafc',
    fill: 'rgba(248, 250, 252, 0.22)',
    glow: 'rgba(248, 250, 252, 0.45)',
  },
  gale1: {
    name: tZh("items.meteorologist.gale1.name"),
  },
  gale2: {
    name: tZh("items.meteorologist.gale2.name"),
  },
  gale3: {
    name: tZh("items.meteorologist.gale3.name"),
  },
  stratus1: {
    name: tZh("items.meteorologist.stratus1.name"),
  },
  stratus2: {
    name: tZh("items.meteorologist.stratus2.name"),
  },
  stratus3: {
    name: tZh("items.meteorologist.stratus3.name"),
  },
  rainfall: {
    name: tZh("items.meteorologist.rainfall.name"),
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: 4, label: tZh("items.meteorologist.stormGlass.range.rainfall") },
      ],
    },
    render: 'circle' as const,
    color: '#f8fafc',
    fill: 'rgba(248, 250, 252, 0.22)',
    glow: 'rgba(248, 250, 252, 0.45)',
  },
  stormGlassDecompose: {
    name: tZh("items.meteorologist.stormGlassDecompose.name"),
  },
  keelBow: {
    name: tZh("items.archer.keelBow.name"),
  },
  crossBow: {
    name: tZh("items.archer.crossBow.name"),
  },
  thurible: {
    name: tZh("items.escapologist.thurible.name"),
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: 16.9, label: tZh("items.escapologist.thurible.name") },
      ],
    },
  },
  escapeAct: {
    name: tZh("items.escapologist.escapeAct.name"),
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: 47, label: tZh("items.escapologist.escapeAct.name") },
      ],
    },
  },
  projectionLanternLivingImage: {
    name: tZh("items.lanternist.projectionLanternLivingImage.name"),
  },
  projectionLanternStaticProjection: {
    name: tZh("items.lanternist.projectionLanternStaticProjection.name"),
  },
  muleta: {
    name: tZh("items.matador.muleta.name"),
  },
  gaoneraPass: {
    name: tZh("items.matador.gaoneraPass.name"),
  },
  propUmbrella: {
    name: tZh("items.mimeArtist.propUmbrella.name"),
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: 12.7, label: tZh("items.mimeArtist.propUmbrella.range.anxiousRoutine") },
      ],
    },
  },
  hamster: {
    name: tZh("items.prodigy.hamster.name"),
  },
  hamsterCancel: {
    name: tZh("items.prodigy.hamsterCancel.name"),
  },
  dirtball: {
    name: tZh("items.prodigy.dirtball.name"),
  },
  pushingState: {
    name: tZh("items.prodigy.pushingState.name"),
  },
  performanceState: {
    name: tZh("items.prodigy.performanceState.name"),
  },

  phantom: {
    name: tZh("items.hellEmber.phantom.name"),
  },
  puppet1: {
    name: tZh("items.hellEmber.puppet1.name"),
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: 12, label: tZh("items.hellEmber.puppet.range.showSurvivor") },
      ],
    },
  },
  puppet2: {
    name: tZh("items.hellEmber.puppet2.name"),
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: 12, label: tZh("items.hellEmber.puppet.range.showSurvivor") },
      ],
    },
  },
  windWings: {
    name: tZh("items.smileyFace.windWings.name"),
    iconSize: 1.7,
  },
  drill: {
    name: tZh("items.smileyFace.drill.name"),
    iconSize: 1.7,
  },
  propeller: {
    name: tZh("items.smileyFace.propeller.name"),
    iconSize: 1.7,
  },
  rocketDash: {
    name: tZh("items.smileyFace.rocketDash.name"),
  },
  chainHook: {
    name: tZh("items.gameKeeper.chainHook.name"),
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: 4.2, label: tZh("items.gameKeeper.chainHook.range.shockwave") },
        { size_m: 1, label: tZh("items.gameKeeper.chainHook.range.autoCorrection") },
      ],
    },
    linkToRole: 'gameKeeper',
    linkMaxM: 16.9,
    linkColor: '#f8fafc',
    linkWidth: 2,
  },
  trap: {
    name: tZh("items.gameKeeper.trap.name"),
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: 20, label: tZh("items.gameKeeper.trap.range.destroyedByRocketChair") },
      ],
    },
  },
  fogZone: {
    name: tZh("items.theRipper.fogZone.name"),
  },
  freezingFog: {
    name: tZh("items.theRipper.freezingFog.name"),
  },
  hiddenInMist: {
    name: tZh("items.theRipper.hiddenInMist.name"),
  },
  cocoon: {
    name: tZh("items.soulWeaver.cocoon.name"),
  },
  webbing: {
    name: tZh("items.soulWeaver.webbing.name"),
  },
  spinning: {
    name: tZh("items.soulWeaver.spinning.name"),
  },
  swallowtailButterfly: {
    name: tZh("items.geisha.swallowtailButterfly.name"),
  },
  dashHit: {
    name: tZh("items.geisha.dashHit.name"),
  },
  soulDeparture: {
    name: tZh("items.geisha.soulDeparture.name"),
  },
  umbrella: {
    name: tZh("items.wuchang.umbrella.name"),
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: 9.3, label: tZh("items.wuchang.umbrella.name") },
      ],
    },
    linkToRole: 'wuchang',
    linkMaxM: 84.4,
    linkColor: '#f8fafc',
    linkWidth: 2,
    render: 'circle' as const,
    color: '#22c55e',
    fill: 'rgba(34, 197, 94, 0.22)',
    glow: 'rgba(34, 197, 94, 0.45)',
  },
  siphonSoulWaveringSoul: {
    name: tZh("items.wuchang.siphonSoulWaveringSoul.name"),
  },
  camera: {
    name: tZh("items.photographer.camera.name"),
  },
  recordedMoment: {
    name: tZh("items.photographer.recordedMoment.name"),
  },
  timeJump: {
    name: tZh("items.photographer.timeJump.name"),
  },
  console: {
    name: tZh("items.madEyes.console.name"),
  },
  fence: {
    name: tZh("items.madEyes.fence.name"),
  },
  portableConsole: {
    name: tZh("items.madEyes.portableConsole.name"),
  },
  overlock: {
    name: tZh("items.madEyes.overlock.name"),
  },
  tentacles: {
    name: tZh("items.theFeaster.tentacles.name"),
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: 4.25, label: tZh("items.theFeaster.tentacles.range.tentacleHit") },
      ],
    },
  },
  nightmareAttack: {
    name: tZh("items.theFeaster.nightmareAttack.name"),
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: 4.25, label: tZh("items.theFeaster.nightmareAttack.range.tentacleHit") },
      ],
    },
  },
  nightmareGaze: {
    name: tZh("items.theFeaster.nightmareGaze.name"),
    ranges: {
      key: 'showTrait' as const,
      options: [
        { size_m: 21.1, label: tZh("items.theFeaster.nightmareGaze.range.nightmareGaze") },
      ],
    },
  },
  follower: {
    name: tZh("items.dreamWitch.follower.name"),
  },
  witchMark: {
    name: tZh("items.dreamWitch.witchMark.name"),
  },
  hiddenDream: {
    name: tZh("items.dreamWitch.hiddenDream.name"),
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: 20, label: tZh("items.dreamWitch.hiddenDream.range.hiddenDreamsurvivorNotification") },
      ],
    },
  },
  preach: {
    name: tZh("items.dreamWitch.preach.name"),
    ranges: {
      key: 'showTrait' as const,
      options: [
        { size_m: 42.2, label: tZh("items.dreamWitch.preach.range.followerControlTier0Tier1") },
        { size_m: 59.1, label: tZh("items.dreamWitch.preach.range.followerControlTier2") },
      ],
    },
  },
  leech: {
    name: tZh("items.dreamWitch.leech.name"),
  },
  peacefulPine: {
    name: tZh("items.axeBoy.peacefulPine.name"),
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: 20.5, label: tZh("items.axeBoy.peacefulPine.name") },
      ],
    },
  },
  resentfulSoul: {
    name: tZh("items.axeBoy.resentfulSoul.name"),
    linkToRole: 'axeBoy',
    linkMaxM: 27,
    linkColor: '#f8fafc',
    linkWidth: 2,
  },
  restfulRoad: {
    name: tZh("items.axeBoy.restfulRoad.name"),
  },
  preyingLeap: {
    name: tZh("items.evilReptilian.preyingLeap.name"),
  },
  crash: {
    name: tZh("items.evilReptilian.crash.name"),
  },
  lethalCrash: {
    name: tZh("items.evilReptilian.lethalCrash.name"),
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: 3, label: tZh("items.evilReptilian.lethalCrash.name") },
      ],
    },
  },
  aquaMirror: {
    name: tZh("items.bloodyQueen.aquaMirror.name"),
    linkToRole: 'bloodyQueen',
  },
  mirrorImage: {
    name: tZh("items.bloodyQueen.mirrorImage.name"),
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: 8.4, label: tZh("items.bloodyQueen.mirrorImage.range.showSurvivor") },
        { size_m: 4.2, label: tZh("items.bloodyQueen.mirrorImage.range.mirrorRotationTier1") },
        { size_m: 21.1, label: tZh("items.bloodyQueen.mirrorImage.range.mirrorImageSurvivorTier2") },
      ],
    },
  },
  mirrorRotation: {
    name: tZh("items.bloodyQueen.mirrorRotation.name"),
  },
  timeBomb: {
    name: tZh("items.guard26.timeBomb.name"),
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: 10.5, crossWidth: 2.53, label: tZh("items.guard26.timeBomb.range.explosionTierZeroOne") },
        { size_m: 13, crossWidth: 2.53, label: tZh("items.guard26.timeBomb.range.explosionTierTwo") },
      ],
    },
  },
  remoteControlledBomb: {
    name: tZh("items.guard26.remoteControlledBomb.name"),
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: 10.5, crossWidth: 2.53, label: tZh("items.guard26.remoteControlledBomb.range.explosionTierZeroOne") },
        { size_m: 13, crossWidth: 2.53, label: tZh("items.guard26.remoteControlledBomb.range.explosionTierTwo") },
      ],
    },
  },
  cat: {
    name: tZh("items.disciple.cat.name"),
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: 3.38, label: tZh("items.disciple.cat.range.alertRadius") },
        { size_m: 6.33, label: tZh("items.disciple.cat.range.paralysisArea") },
        { size_m: 10.5, label: tZh("items.disciple.cat.range.locateSurvivor") },
        { size_m: 33.8, label: tZh("items.disciple.cat.range.seenBySurvivor") },
      ],
    },
  },
  guide: {
    name: tZh("items.disciple.guide.name"),
    linkToRole: 'disciple',
    linkMaxM: 30,
    linkColor: '#f8fafc',
    linkWidth: 2,
  },
  catwalk: {
    name: tZh("items.disciple.catwalk.name"),
  },
  musicNote: {
    name: tZh("items.violinist.musicNote.name"),
    render: 'link' as const,
    linkMaxM: 23,
    linkColor: '#f8fafc',
    linkWidth: 2,
  },
  infiniteMovement: {
    name: tZh("items.violinist.infiniteMovement.name"),
  },
  terrifyingMelody: {
    name: tZh("items.violinist.terrifyingMelody.name"),
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: 12, label: tZh("items.violinist.terrifyingMelody.range.meditationCalmDownSurvivorAlone") },
      ],
    },
  },
  sculpture: {
    name: tZh("items.sculptor.sculpture.name"),
    render: 'link' as const,
    linkMaxM: 11,
    linkColor: '#f8fafc',
    linkWidth: 2,
  },
  sculptureOfNobility: {
    name: tZh("items.sculptor.sculptureOfNobility.name"),
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: 36, label: tZh("items.sculptor.sculptureOfNobility.range.chargeTowardSurvivor") },
      ],
    },
  },
  hieroglyphicGraveyard: {
    name: tZh("items.sculptor.hieroglyphicGraveyard.name"),
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: 26, label: tZh("items.sculptor.hieroglyphicGraveyard.name") },
      ],
    },
  },
  kineticDashHit: {
    name: tZh("items.undead.kineticDashHit.name"),
  },
  chargedStrike: {
    name: tZh("items.undead.chargedStrike.name"),
  },
  energyConversion: {
    name: tZh("items.undead.energyConversion.name"),
  },
  wheelForm: {
    name: tZh("items.theBreakingWheel.wheelForm.name"),
  },
  nailBoard: {
    name: tZh("items.theBreakingWheel.nailBoard.name"),
  },
  wheelOfImpalement: {
    name: tZh("items.theBreakingWheel.wheelOfImpalement.name"),
  },
  pessimistic: {
    name: tZh("items.theBreakingWheel.pessimistic.name"),
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: 11.8, label: tZh("items.theBreakingWheel.pessimistic.name") },
      ],
    },
  },
  ridicule: {
    name: tZh("items.theBreakingWheel.ridicule.name"),
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: 10.1, label: tZh("items.theBreakingWheel.ridicule.name") },
      ],
    },
  },
  spearfishing: {
    name: tZh("items.naiad.spearfishing.name"),
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: 4, label: tZh("items.naiad.spearfishing.name") },
      ],
    },
    linkToRole: 'naiad',
    linkMaxM: 57.5,
  },
  surgingTides: {
    name: tZh("items.naiad.surgingTides.name"),
  },
  waxBlock: {
    name: tZh("items.waxArtist.waxBlock.name"),
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: 4.2, label: tZh("items.waxArtist.waxBlock.name") },
      ],
    },
  },
  moltenWax: {
    name: tZh("items.waxArtist.moltenWax.name"),
  },
  waxSculpting: {
    name: tZh("items.waxArtist.waxSculpting.name"),
  },
  raven: {
    name: tZh("items.nightmare.raven.name"),
  },
  spy: {
    name: tZh("items.nightmare.spy.name"),
  },
  badOmen: {
    name: tZh("items.nightmare.badOmen.name"),
  },
  record: {
    name: tZh("items.clerk.record.name"),
  },
  inspect: {
    name: tZh("items.clerk.inspect.name"),
  },
  replay: {
    name: tZh("items.clerk.replay.name"),
  },
  invalid: {
    name: tZh("items.clerk.invalid.name"),
  },
  electromagneticFieldN: {
    name: tZh("items.hermit.electromagneticFieldN.name"),
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: 2.3, label: tZh("items.hermit.electromagneticFieldN.name") },
      ],
    },
    render: 'circle' as const,
    color: '#ef4444',
    fill: 'rgba(239, 68, 68, 0.22)',
    glow: 'rgba(239, 68, 68, 0.45)',
  },
  electromagneticFieldS: {
    name: tZh("items.hermit.electromagneticFieldS.name"),
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: 2.3, label: tZh("items.hermit.electromagneticFieldS.name") },
      ],
    },
    render: 'circle' as const,
    color: '#1d4ed8',
    fill: 'rgba(29, 78, 216, 0.22)',
    glow: 'rgba(29, 78, 216, 0.45)',
  },
  secondDawn: {
    name: tZh("items.hermit.secondDawn.name"),
  },
  reversePolarity: {
    name: tZh("items.hermit.reversePolarity.name"),
  },
  meditation: {
    name: tZh("items.hermit.meditation.name"),
  },
  tempest: {
    name: tZh("items.nightWatch.tempest.name"),
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: 15.9, label: tZh("items.nightWatch.tempest.name") },
      ],
    },
  },
  windwalk: {
    name: tZh("items.nightWatch.windwalk.name"),
  },
  tempestCyclone: {
    name: tZh("items.nightWatch.tempestCyclone.name"),
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: 11.8, label: tZh("items.nightWatch.tempestCyclone.name") },
      ],
    },
  },
  windwalkCharge: {
    name: tZh("items.nightWatch.windwalkCharge.name"),
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: 15.2, label: tZh("items.nightWatch.windwalkCharge.name") },
      ],
    },
  },
  windControl: {
    name: tZh("items.nightWatch.windControl.name"),
  },
  remnant: {
    name: tZh("items.operaSinger.remnant.name"),
  },
  shadowstrike: {
    name: tZh("items.operaSinger.shadowstrike.name"),
  },
  pickaxe: {
    name: tZh("items.foolsGold.pickaxe.name"),
  },
  magneticRock: {
    name: tZh("items.foolsGold.magneticRock.name"),
  },
  yithian: {
    name: tZh("items.theShadow.yithian.name"),
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: 15, label: tZh("items.theShadow.yithian.name") },
      ],
    },
  },
  ancientVisage: {
    name: tZh("items.theShadow.ancientVisage.name"),
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: 15, label: tZh("items.theShadow.ancientVisage.name") },
      ],
    },
  },
  psychicIntrusion: {
    name: tZh("items.theShadow.psychicIntrusion.name"),
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: 5.1, label: tZh("items.theShadow.psychicIntrusion.name") },
      ],
    },
  },
  corruptedOstracon: {
    name: tZh("items.theShadow.corruptedOstracon.name"),
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: 9, label: tZh("items.theShadow.corruptedOstracon.name") },
      ],
    },
  },
  cage: {
    name: tZh("items.goatman.cage.name"),
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: [9, 12, 15], label: tZh("items.goatman.cage.name") },
      ],
    },
  },
  backstep: {
    name: tZh("items.goatman.backstep.name"),
  },
  cloneHullabaloo: {
    name: tZh("items.hullabaloo.cloneHullabaloo.name"),
  },
  encore: {
    name: tZh("items.hullabaloo.encore.name"),
  },
  trapeze: {
    name: tZh("items.hullabaloo.trapeze.name"),
  },
  pettyGains: {
    name: tZh("items.peddler.pettyGains.name"),
  },
  natureAffinity: {
    name: tZh("items.peddler.natureAffinity.name"),
  },
  mineralAffinity: {
    name: tZh("items.peddler.mineralAffinity.name"),
  },
  metalAffinity: {
    name: tZh("items.peddler.metalAffinity.name"),
  },
  contactPoint: {
    name: tZh("items.cueist.contactPoint.name"),
    render: 'hittingPoint' as const,
    linkColor: '#f8fafc',
    linkWidth: 2,
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: 3, label: tZh("items.cueist.contactPoint.name") },
      ],
    },
  },
  cueBall: {
    name: tZh("items.cueist.cueBall.name"),
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: 4, label: tZh("items.cueist.cueBall.name") },
      ],
    },
  },
  maxwellsDemon: {
    name: tZh("items.cueist.maxwellsDemon.name"),
  },
  swarmOfInsects: {
    name: tZh("items.queenBee.swarmOfInsects.name"),
  },
  stinger: {
    name: tZh("items.queenBee.stinger.name"),
  },
  beam: {
    name: tZh("items.dentist.beam.name"),
  },
  dentalMirror: {
    name: tZh("items.dentist.dentalMirror.name"),
  },
  darkMire: {
    name: tZh("items.dentist.darkMire.name"),
  },
  bestialAwakening: {
    name: tZh("items.herztier.bestialAwakening.name"),
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: 48, label: tZh("items.herztier.bestialAwakening.name") },
      ],
    },
  },
  lunge: {
    name: tZh("items.herztier.bestialAwakening.name"),
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: [7, 14], label: tZh("items.herztier.lunge.name") },
      ],
    },
  },
  heightenedSenses: {
    name: tZh("items.herztier.heightenedSenses.name"),
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: 25, label: tZh("items.herztier.heightenedSenses.name") },
      ],
    },
  },

  ...TAC_COMMON_ITEM_TYPES,

  listen: {
    name: tZh("items.skill.listen.name"),
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: 11, label: tZh("items.skill.listen.name") },
      ],
    },
  },
  abnormal: {
    name: tZh("items.skill.abnormal.name"),
  },
  excitement: {
    name: tZh("items.skill.excitement.name"),
  },
  patroller: {
    name: tZh("items.skill.patroller.name"),
  },
  teleport: {
    name: tZh("items.skill.teleport.name"),
  },
  peeper: {
    name: tZh("items.skill.peeper.name"),
    ranges: {
      key: 'showItem' as const,
      options: [
        { size_m: 13, label: tZh("items.skill.peeper.name") },
      ],
    },
  },
  blink: {
    name: tZh("items.skill.blink.name"),
  },
  warp: {
    name: tZh("items.skill.warp.name"),
    render: 'link' as const,
    linkMaxM: 60,
    linkColor: '#f8fafc',
    linkWidth: 2,
  },

  ...TAC_TALENT_TYPES,

};

export const TAC_ITEM_TYPES: Readonly<Record<string, ItemDefinition>> = Object.fromEntries(
  Object.entries(RAW_ITEM_TYPES).map(([key, entry]) => {
    const e = entry as Partial<ItemDefinition> & { name: string };
    return [
      key,
      {
        ...e,
        key,
        glyph: e.glyph ?? itemGlyph(key, e.name),
      } as ItemDefinition,
    ];
  }),
);
