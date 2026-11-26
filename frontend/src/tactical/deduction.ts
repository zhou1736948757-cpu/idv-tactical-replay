/**
 * PIL cipher deduction rule builders & rulebook generator (zero DOM).
 */
import { cnNum, tZh } from './locales-zh';
import type {
  CipherPoint,
  DeductionData,
  DeductionRule,
  DeductionRuleBookItem,
  DeductionRuleKind,
} from './types';

export const DED_EMPTY_HINT = tZh('ui.ded.basis.note');

export interface DedRuleInput {
  name?: string;
  text?: string | null;
  list?: string | null;
  cipherNames?: string[];
  n?: number;
  min?: number;
  max?: number;
  mode?: 'yes' | 'no';
  cyclic?: boolean;
  pres?: string[];
  cons?: string[];
  targets?: string[];
  region?: string[];
  marker?: string | null;
  positive?: boolean;
}

export interface DedHelpersApi {
  fixed(o?: DedRuleInput): DeductionRule;
  region(o?: DedRuleInput): DeductionRule;
  exactly(o?: DedRuleInput): DeductionRule;
  either(o?: DedRuleInput): DeductionRule;
  same(o?: DedRuleInput): DeductionRule;
  implies(o?: DedRuleInput): DeductionRule;
  atLeast1(o?: DedRuleInput): DeductionRule;
  atMost1(o?: DedRuleInput): DeductionRule;
  chain(o?: DedRuleInput): DeductionRule;
  chainThree(o?: DedRuleInput): DeductionRule;
  allAbsent(o?: DedRuleInput): DeductionRule;
  link(o?: DedRuleInput): DeductionRule;
}

export function dedHelpers(positions: readonly CipherPoint[]): DedHelpersApi {
  const ids = (...cipherNames: string[]): number[] =>
    cipherNames.map((n) => positions.findIndex((p) => p.name === n));

  const sep = tZh('ui.ded.basis.separator.list');
  const join = (cipherNames: readonly string[]): string => cipherNames.join(sep);

  const build = (kind: DeductionRuleKind, o: DedRuleInput & { name: string }): DeductionRule => {
    const pres = o.pres ? ids(...o.pres) : [];
    const cons = o.cons ? ids(...o.cons) : [];
    const targets = o.targets ? ids(...o.targets) : [];
    const region = o.region ? ids(...o.region) : [];
    const marker = o.marker == null ? null : (ids(o.marker)[0] ?? null);
    // Preserve intentional duplicates (e.g. closed loop in chainThree / marker inside region).
    const rulePositions = [
      ...ids(...(o.cipherNames ?? [])),
      ...pres,
      ...cons,
      ...targets,
      ...region,
      ...(marker == null ? [] : [marker]),
    ];
    return {
      kind,
      name: o.name,
      text: o.text ?? null,
      list: o.list !== undefined ? o.list : o.cipherNames ? join(o.cipherNames) : null,
      positions: rulePositions,
      n: o.n ?? null,
      min: o.min ?? null,
      max: o.max ?? null,
      mode: o.mode ?? null,
      cyclic: o.cyclic ?? null,
      pres,
      cons,
      targets,
      region,
      marker,
      positive: o.positive ?? null,
    };
  };

  const withDefaults = (o: DedRuleInput, defaults: Partial<DedRuleInput> & { name: string }): DedRuleInput & { name: string } => ({
    ...defaults,
    ...o,
    name: o.name ?? defaults.name,
  });

  const fixed = (o: DedRuleInput = {}): DeductionRule =>
    build('fixed', withDefaults(o, { name: tZh('deduction.rule.type.fixed') }));

  const region = (o: DedRuleInput = {}): DeductionRule =>
    build('region', withDefaults(o, { name: tZh('deduction.rule.type.region') }));

  const exactly = (o: DedRuleInput = {}): DeductionRule =>
    build(
      'exactly',
      withDefaults(o, {
        name: tZh('deduction.rule.type.exactly', { n: cnNum(o.n ?? 0) }),
      }),
    );

  const either = (o: DedRuleInput = {}): DeductionRule =>
    exactly({ n: 1, name: tZh('deduction.rule.type.either'), ...o });

  const same = (o: DedRuleInput = {}): DeductionRule =>
    build('same', withDefaults(o, { name: tZh('deduction.rule.type.same') }));

  const implies = (o: DedRuleInput = {}): DeductionRule =>
    build(
      'implies',
      withDefaults(
        { list: [...(o.pres ?? []), ...(o.cons ?? [])].join(sep), ...o },
        { name: tZh('deduction.rule.type.same') },
      ),
    );

  const atLeast1 = (o: DedRuleInput = {}): DeductionRule =>
    build('atLeast1', withDefaults(o, { name: tZh('deduction.rule.type.atLeast1'), n: 1 }));

  const atMost1 = (o: DedRuleInput = {}): DeductionRule =>
    build('atMost1', withDefaults(o, { name: tZh('deduction.rule.type.atMost1'), n: 1 }));

  const chain = (o: DedRuleInput = {}): DeductionRule =>
    build(
      'chain',
      withDefaults(
        { list: (o.cipherNames ?? []).join(' - '), ...o },
        { name: tZh('deduction.rule.type.chain') },
      ),
    );

  const chainThree = (o: DedRuleInput = {}): DeductionRule =>
    build(
      'chainThree',
      withDefaults(
        { list: (o.cipherNames ?? []).join(' - '), ...o },
        { name: tZh('deduction.rule.type.chain') },
      ),
    );

  const allAbsent = (o: DedRuleInput = {}): DeductionRule =>
    build(
      'allAbsent',
      withDefaults(
        { list: [...(o.pres ?? []), ...(o.targets ?? [])].join(sep), ...o },
        { name: tZh('deduction.rule.type.allAbsent') },
      ),
    );

  const link = (o: DedRuleInput = {}): DeductionRule =>
    build(
      'link',
      withDefaults(
        { list: o.marker ?? null, ...o },
        { name: tZh('deduction.rule.type.region') },
      ),
    );

  return {
    fixed,
    region,
    exactly,
    either,
    same,
    implies,
    atLeast1,
    atMost1,
    chain,
    chainThree,
    allAbsent,
    link,
  };
}

export function dedRuleBook(rules: readonly DeductionRule[]): DeductionRuleBookItem[] {
  const sep = tZh('ui.ded.basis.separator.list');
  const slash = (r: DeductionRule): string => (r.list ?? '').split(sep).join(' / ');

  return rules.map((r) => {
    switch (r.kind) {
      case 'fixed':
        return { title: r.name, text: tZh('deduction.rule.type.fixed.text', { list: r.list ?? '' }) };
      case 'region': {
        const min = r.min ?? 0;
        const max = r.max ?? 0;
        const text =
          min === max
            ? tZh('deduction.rule.type.region.text1', { value: cnNum(min) })
            : tZh('deduction.rule.type.region.text2', { value: cnNum(min), valueSecondary: cnNum(max) });
        return {
          title: r.name,
          text: tZh('deduction.rule.type.region.text', { ciphersName: slash(r), text }),
        };
      }
      case 'exactly':
        return {
          title: `${r.name} · ${slash(r)}`,
          text: tZh('deduction.rule.type.exactly.text', {
            count: cnNum(r.positions.length),
            value: cnNum(r.n ?? 0),
          }),
        };
      case 'same':
        return { title: `${r.name} · ${slash(r)}`, text: tZh('deduction.rule.type.same.text') };
      case 'implies':
        return { title: `${r.name} · ${slash(r)}`, text: r.text };
      case 'atLeast1':
        return { title: `${r.name} · ${slash(r)}`, text: tZh('deduction.rule.type.atLeast1.text') };
      case 'atMost1':
        return { title: `${r.name} · ${slash(r)}`, text: tZh('deduction.rule.type.atMost1.text') };
      case 'chain':
      case 'chainThree':
      case 'allAbsent':
      case 'link':
      default:
        return { title: r.name, text: r.text };
    }
  });
}

export interface MakeDeductionOptions {
  mapImage: string;
  mapSize: [number, number];
  ciphers: CipherPoint[];
  cipherCombinations: string[][];
  rules: DeductionRule[];
  hints?: string[];
}

export function makeDeduction(opts: MakeDeductionOptions): DeductionData {
  const { mapImage, mapSize, ciphers, cipherCombinations, rules, hints } = opts;
  return {
    mapImage,
    mapSize,
    ciphers,
    configs: cipherCombinations.map((g) => g.map((cid) => ciphers.findIndex((p) => p.id === cid))),
    rules,
    hints,
    ruleBook: dedRuleBook(rules),
    emptyHint: DED_EMPTY_HINT,
  };
}
