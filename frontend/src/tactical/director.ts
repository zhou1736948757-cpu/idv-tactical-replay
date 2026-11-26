import type { MatchAnalyticsPayload, Replay2DPayload } from '@idv/replay-renderer';

export interface DirectorSegment {
  start: number;
  end: number;
  mode: 'fast' | 'focus' | 'beat' | 'opening60';
  speed: 1 | 4;
  followUid: number | null;
  caption: string;
  pauseMs?: number;
}

export function firstChaseCue(replay: Replay2DPayload, analytics: MatchAnalyticsPayload | null): number {
  return Math.min(replay.time.duration_s, Math.max(0, (
    analytics?.hunter_metrics.first_chase_t ?? analytics?.chase_segments[0]?.start_t ?? replay.markers[0]?.t ?? 0
  ) - 3));
}

export function buildDirectorScript(replay: Replay2DPayload, analytics: MatchAnalyticsPayload | null): DirectorSegment[] {
  const duration = replay.time.duration_s;
  const clamp = (time: number) => Math.max(0, Math.min(duration, time));
  const chases = (analytics?.chase_segments ?? []).map((chase) => ({
    start: clamp(chase.start_t - 2), end: clamp(chase.end_t + 2), chase,
  }));
  const beatTypes = new Set(['hit_attack', 'rescue_complete']);
  const beats = [...replay.markers.map((event) => ({ t: event.t, caption: event.label_zh })),
    ...replay.events.filter((event) => beatTypes.has(event.type)).map((event) => ({ t: event.t, caption: event.label_zh }))];
  const captions = new Map(beats.filter(({ t }) => t >= 0 && t < duration).map(({ t, caption }) => [t, caption]));
  const cuts = [...new Set([0, duration, ...captions.keys(), ...chases.flatMap(({ start, end }) => [start, end])])]
    .sort((a, b) => a - b);
  const script: DirectorSegment[] = [];
  cuts.slice(0, -1).forEach((start, index) => {
    const end = cuts[index + 1]!;
    const caption = captions.get(start);
    if (caption) script.push({ start, end: start, mode: 'beat', speed: 1, followUid: null, caption, pauseMs: 1200 });
    const chase = chases.find((range) => range.start <= start && range.end >= end)?.chase;
    script.push(chase
      ? { start, end, mode: 'focus', speed: 1, followUid: chase.survivor_uid, caption: `追击 · ${chase.survivor_name}` }
      : { start, end, mode: 'fast', speed: 4, followUid: null, caption: '战况快进' });
  });
  return script;
}

export function opening60(replay: Replay2DPayload): DirectorSegment {
  return { start: 0, end: Math.min(60, replay.time.duration_s), mode: 'opening60', speed: 1,
    followUid: null, caption: '高手开局前 60 秒' };
}
