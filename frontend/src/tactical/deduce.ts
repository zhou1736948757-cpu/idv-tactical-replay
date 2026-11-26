/**
 * PIL cipher deduction solver, step tracer, and status helpers (zero DOM).
 */
import { cnNum, tZh } from './locales-zh';
import type {
  CipherPoint,
  DeduceMarkValue,
  DeduceMarksState,
  DeduceStateValue,
  DeductionData,
  DeductionResult,
  DeductionRule,
  DeductionScope,
  DeductionStep,
  MarkKindTuple,
} from './types';

export const STEP_NUMS = [
  '①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩',
  '⑪', '⑫', '⑬', '⑭', '⑮',
] as const;

export function stepNum(n: number): string {
  return n >= 1 && n <= STEP_NUMS.length ? (STEP_NUMS[n - 1] ?? `${n}`) : `${n}`;
}

export const DED_LEGEND = [
  { label: tZh('ui.ded.nav.legend.mark.yes'), dot: 'lg-yes' },
  { label: tZh('ui.ded.nav.legend.mark.no'), dot: 'lg-no' },
  { label: tZh('ui.ded.nav.legend.mark.infer.yes'), dot: 'lg-inf-yes' },
  { label: tZh('ui.ded.nav.legend.mark.infer.no'), dot: 'lg-inf-no' },
] as const;

export function posName(map: Pick<DeductionData, 'ciphers'>, id: number): string {
  return map.ciphers[id] ? map.ciphers[id].name : `#${id}`;
}

export function markKind(
  pos: Pick<CipherPoint, 'locked'>,
  value: DeduceStateValue,
  userMark: DeduceMarkValue | undefined,
): MarkKindTuple {
  if (pos.locked) return ['locked', 'lock', tZh('deduction.status.guaranteed')];
  const inferred = value !== null && userMark === undefined;
  if (value === 'yes') {
    return inferred
      ? ['inf-yes', 'bolt', tZh('ui.ded.cipher.status.infer.yes')]
      : ['user-yes', 'bolt', tZh('ui.ded.cipher.status.mark.yes')];
  }
  if (value === 'no') {
    return inferred
      ? ['inf-no', 'cross', tZh('ui.ded.cipher.status.infer.no')]
      : ['user-no', 'cross', tZh('ui.ded.cipher.status.mark.no')];
  }
  return ['unknown', '', tZh('ui.ded.cipher.status.unknown')];
}

export function deduce(map: DeductionData, marks: DeduceMarksState): DeductionResult {
  const N = map.ciphers.length;
  const state: DeduceStateValue[] = new Array<DeduceStateValue>(N).fill(null);
  const sources: Array<number | null> = new Array<number | null>(N).fill(null);
  const steps: DeductionStep[] = [];
  let contradiction: string | null = null;
  let contraFrozen: string | null = null;

  const set = (id: number, value: DeduceMarkValue): boolean => {
    if (state[id] !== null) return false;
    state[id] = value;
    return true;
  };

  const record = (
    rule: Pick<DeductionRule, 'name' | 'list'>,
    newly: number[],
    value: DeduceMarkValue,
    scope: DeductionScope,
  ): void => {
    const stepNo = steps.length + 1;
    for (const p of newly) sources[p] = stepNo;
    steps.push({
      rule: rule.name,
      detail: rule.list,
      conclusions: newly.map((p) => ({ id: p, value, inferred: true })),
      scope,
    });
  };

  const flush = (
    rule: DeductionRule,
    targets: number[],
    value: DeduceMarkValue,
    scope?: DeductionScope,
  ): boolean => {
    const newly = targets.filter((p) => set(p, value));
    if (newly.length === 0) return false;
    record(rule, newly, value, scope ?? { kind: 'circle', positions: [...rule.positions] });
    return true;
  };

  const pick = (ps: readonly number[], v: DeduceStateValue): number[] => ps.filter((p) => state[p] === v);

  const normalizedMarks: DeduceMarksState = {};
  for (const [k, v] of Object.entries(marks)) {
    const id = Number(k);
    if (Number.isInteger(id) && map.ciphers[id] && !map.ciphers[id].locked && (v === 'yes' || v === 'no')) {
      state[id] = v;
      normalizedMarks[id] = v;
    }
  }

  const runChain = (rule: DeductionRule): boolean => {
    const chain = rule.positions;
    if (!chain || chain.length < 2) return false;
    const edgeCount = rule.cyclic ? chain.length : chain.length - 1;

    for (let k = 0; k < edgeCount; k++) {
      const a = chain[k]!;
      const b = chain[(k + 1) % chain.length]!;
      if (!contraFrozen && rule.mode === 'yes' && state[a] === 'yes' && state[b] === 'yes') {
        contradiction = tZh('ui.ded.contradict.runChain.yes', {
          name: rule.name,
          nameSecondary: posName(map, a),
          nameTertiary: posName(map, b),
        });
      }
      if (!contraFrozen && rule.mode === 'no' && state[a] === 'no' && state[b] === 'no') {
        contradiction = tZh('ui.ded.contradict.runChain.no', {
          name: rule.name,
          nameSecondary: posName(map, a),
          nameTertiary: posName(map, b),
        });
      }
    }

    const want: DeduceMarkValue = rule.mode === 'yes' ? 'yes' : 'no';
    const give: DeduceMarkValue = rule.mode === 'yes' ? 'no' : 'yes';
    const targets = chain.filter((_id, idx) => {
      const prev = chain[(idx - 1 + chain.length) % chain.length]!;
      const next = chain[(idx + 1) % chain.length]!;
      const hitPrev = (Boolean(rule.cyclic) || idx > 0) && state[prev] === want;
      const hitNext = (Boolean(rule.cyclic) || idx < chain.length - 1) && state[next] === want;
      return hitPrev || hitNext;
    });
    const newly = targets.filter((p) => set(p, give));
    if (newly.length === 0) return false;
    record(rule, newly, give, {
      kind: 'chain',
      positions: [...chain],
      cyclic: Boolean(rule.cyclic),
    });
    return true;
  };

  const propagateCount = (
    rule: DeductionRule,
    min: number,
    max: number,
    overNo: (count: number) => string,
    overYes: (count: number) => string,
    yesFirst = false,
  ): boolean => {
    const yesIdx = pick(rule.positions, 'yes');
    const noIdx = pick(rule.positions, 'no');
    const unknown = pick(rule.positions, null);
    const checks: Array<[boolean, (count: number) => string, number]> = [
      [noIdx.length > rule.positions.length - min, overNo, noIdx.length],
      [yesIdx.length > max, overYes, yesIdx.length],
    ];
    if (yesFirst) checks.reverse();
    for (const [hit, msg, count] of checks) {
      if (hit) {
        if (!contraFrozen) contradiction = msg(count);
        return false;
      }
    }
    if (unknown.length === 0) return false;
    if (yesIdx.length === max) return flush(rule, unknown, 'no');
    if (noIdx.length === rule.positions.length - min) return flush(rule, unknown, 'yes');
    return false;
  };

  const propagate = (): boolean => {
    let anyNew = false;
    contraFrozen = contradiction;
    for (const rule of map.rules) {
      let changed = false;
      if (rule.kind === 'fixed') {
        changed = flush(rule, pick(rule.positions, null), 'yes');
      } else if (rule.kind === 'chain') {
        changed = runChain(rule);
      } else if (rule.kind === 'region') {
        const min = rule.min ?? 0;
        const max = rule.max ?? 0;
        changed = propagateCount(
          rule,
          min,
          max,
          (c) => tZh('ui.ded.contradict.region.atLeast', { list: rule.list ?? '', value: cnNum(min), count: c }),
          (c) => tZh('ui.ded.contradict.region.atMost', { list: rule.list ?? '', value: cnNum(max), count: c }),
        );
      } else if (rule.kind === 'exactly') {
        const n = rule.n ?? 0;
        changed = propagateCount(
          rule,
          n,
          n,
          (c) => tZh('ui.ded.contradict.exactly.no', { list: rule.list ?? '', n, count: c }),
          (c) => tZh('ui.ded.contradict.exactly.yes', { list: rule.list ?? '', n, count: c }),
          true,
        );
      } else if (rule.kind === 'atLeast1') {
        const a = rule.positions[0]!;
        const b = rule.positions[1]!;
        if (state[a] === 'no' && state[b] === 'no') {
          if (!contraFrozen) {
            contradiction = tZh('ui.ded.contradict.atLeast.no', {
              list: rule.list ?? '',
              value: cnNum(rule.n ?? 1),
            });
          }
        } else {
          const other = state[a] === 'no' ? b : state[b] === 'no' ? a : null;
          if (other !== null) changed = flush(rule, [other], 'yes');
        }
      } else if (rule.kind === 'same') {
        const a = rule.positions[0]!;
        const b = rule.positions[1]!;
        if (state[a] !== null && state[b] !== null && state[a] !== state[b]) {
          if (!contraFrozen) {
            contradiction = tZh('ui.ded.contradict.same', { list: rule.list ?? '' });
          }
        } else if (state[a] !== null && state[b] === null) {
          changed = flush(rule, [b], state[a]!);
        } else if (state[b] !== null && state[a] === null) {
          changed = flush(rule, [a], state[b]!);
        }
      } else if (rule.kind === 'atMost1') {
        const n = rule.n ?? 1;
        const yesIdx = pick(rule.positions, 'yes');
        if (yesIdx.length > n) {
          if (!contraFrozen) {
            contradiction = tZh('ui.ded.contradict.atMost.yes', {
              list: rule.list ?? '',
              value: cnNum(n),
              count: yesIdx.length,
            });
          }
        } else if (yesIdx.length === n) {
          changed = flush(rule, pick(rule.positions, null), 'no');
        }
      } else if (rule.kind === 'allAbsent') {
        if (rule.pres.every((p) => state[p] === 'no')) {
          changed = flush(
            rule,
            rule.targets.filter((p) => state[p] === null),
            'yes',
          );
        }
      } else if (rule.kind === 'implies') {
        const c = rule.cons[0]!;
        if (state[c] === 'no' && rule.pres.some((p) => state[p] === 'yes')) {
          if (!contraFrozen) {
            contradiction = tZh('ui.ded.contradict.link', { name: rule.name, list: rule.list ?? '' });
          }
        }
        if (rule.pres.some((p) => state[p] === 'yes') && state[c] === null) {
          changed = flush(rule, [c], 'yes');
        }
        if (state[c] === 'no') {
          changed =
            flush(
              rule,
              rule.pres.filter((p) => state[p] === null),
              'no',
            ) || changed;
        }
      } else if (rule.kind === 'chainThree') {
        const ps = rule.positions;
        const chainScope: DeductionScope = { kind: 'chainThree', positions: [...ps] };
        for (let k = 0; k + 2 < ps.length; k++) {
          if (state[ps[k]!] === 'yes' && state[ps[k + 1]!] === 'yes' && state[ps[k + 2]!] === 'yes') {
            if (!contraFrozen) {
              contradiction = tZh('ui.ded.contradict.chainThree', {
                name: rule.name,
                nameSecondary: posName(map, ps[k]!),
                nameTertiary: posName(map, ps[k + 1]!),
                nameQuaternary: posName(map, ps[k + 2]!),
              });
            }
          }
        }
        for (let k = 0; k + 2 < ps.length; k++) {
          if (state[ps[k]!] === 'yes' && state[ps[k + 1]!] === 'yes' && state[ps[k + 2]!] === null) {
            changed = flush(rule, [ps[k + 2]!], 'no', chainScope) || changed;
          }
          if (state[ps[k + 1]!] === 'yes' && state[ps[k + 2]!] === 'yes' && state[ps[k]!] === null) {
            changed = flush(rule, [ps[k]!], 'no', chainScope) || changed;
          }
        }
      } else if (rule.kind === 'link' && rule.marker != null) {
        const m = rule.marker;
        const mIn = rule.region.includes(m);
        const others = rule.region.filter((p) => p !== m);
        const cnt = pick(others, 'yes').length;
        const unknown = pick(others, null);
        if (state[m] !== null) {
          const match = (state[m] === 'yes') === Boolean(rule.positive);
          const target = match ? 3 : 2;
          const need = target - cnt - (mIn && state[m] === 'yes' ? 1 : 0);
          if (unknown.length === 0 && need !== 0 && !contraFrozen) {
            contradiction = tZh('ui.ded.contradict.link', { name: rule.name, list: rule.list ?? '' });
          }
          if (need === 0 && unknown.length > 0) {
            changed = flush(rule, unknown, 'no') || changed;
          } else if (need > 0 && need === unknown.length) {
            changed = flush(rule, unknown, 'yes') || changed;
          }
        } else if (unknown.length === 0) {
          const totalIfYes = cnt + (mIn ? 1 : 0);
          const okYes = (totalIfYes === 3) === Boolean(rule.positive);
          const okNo = (cnt === 3) !== Boolean(rule.positive);
          if (okYes && !okNo) changed = flush(rule, [m], 'yes') || changed;
          else if (okNo && !okYes) changed = flush(rule, [m], 'no') || changed;
        }
      }
      if (changed) anyNew = true;
    }
    return anyNew;
  };

  const consistent = (cfg: readonly number[]): boolean =>
    state.every((s, i) => s === null || (s === 'yes') === cfg.includes(i));

  const runGlobal = (): boolean => {
    if (contradiction) return false;
    const candidates = map.configs.map((_, i) => i).filter((i) => consistent(map.configs[i]!));
    if (candidates.length === 0) return false;
    const groups: { yes: number[]; no: number[] } = { yes: [], no: [] };
    for (let p = 0; p < N; p++) {
      if (state[p] !== null) continue;
      const inAll = candidates.every((ci) => map.configs[ci]!.includes(p));
      const inNone = candidates.every((ci) => !map.configs[ci]!.includes(p));
      if (inAll) groups.yes.push(p);
      else if (inNone) groups.no.push(p);
    }
    let anyNew = false;
    const rule = {
      name: tZh('deduction.rule.type.default'),
      list: tZh('deduction.rule.type.default.list'),
    };
    (['yes', 'no'] as const).forEach((value) => {
      const group = groups[value];
      if (group.length === 0) return;
      for (const p of group) set(p, value);
      record(rule, group, value, { kind: 'circle', positions: [...group] });
      anyNew = true;
    });
    return anyNew;
  };

  let guard = 0;
  while (guard++ < 50) {
    let changed = false;
    while (propagate()) changed = true;
    if (runGlobal()) changed = true;
    if (!changed) break;
  }

  const candidates = map.configs.map((_, i) => i).filter((i) => consistent(map.configs[i]!));
  if (!contradiction && candidates.length === 0) {
    contradiction = tZh('ui.ded.contradict.noLayout', { count: cnNum(map.configs.length) });
  }

  return { state, marks: normalizedMarks, steps, contradiction, candidates, sources };
}
