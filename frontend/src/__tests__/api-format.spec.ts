import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, fetchAnalytics, fetchMatches, fetchReplay, isZipFile, uploadReplay } from '@/api/client';
import {
  filterEvents,
  formatClock,
  hunterPortraitUrl,
  isHunterWin,
  mapGridUrl,
  matchMapUrl,
  modeKey,
  pidLabel,
  sourceBadge,
  talentLabel,
} from '@/lib/format';
import { installFetch, jsonResponse, makeAnalytics, makeReplay, MATCHES } from './fixtures';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api client (D1 REST contract)', () => {
  it('GET /api/matches, /replay and /analytics parse canonical payloads', async () => {
    const { fn, calls } = installFetch({
      'GET /api/matches': () => jsonResponse({ matches: MATCHES }),
      [`GET /api/matches/${MATCHES[0]!.match_id}/replay`]: () => jsonResponse(makeReplay()),
      [`GET /api/matches/${MATCHES[0]!.match_id}/analytics`]: () => jsonResponse(makeAnalytics()),
    });
    vi.stubGlobal('fetch', fn);
    const list = await fetchMatches();
    expect(list).toHaveLength(3);
    const r = await fetchReplay(MATCHES[0]!.match_id);
    expect(r.schema_version).toBe('1.0');
    const a = await fetchAnalytics(MATCHES[0]!.match_id);
    expect(a.phases.map((p) => p.phase_id)).toEqual(['opening', 'midgame', 'endgame']);
    expect(calls.map((c) => c.url)).toEqual([
      '/api/matches',
      `/api/matches/${MATCHES[0]!.match_id}/replay`,
      `/api/matches/${MATCHES[0]!.match_id}/analytics`,
    ]);
  });

  it('surfaces FastAPI {detail} errors and network failures in Chinese', async () => {
    vi.stubGlobal('fetch', async () => jsonResponse({ detail: 'match not found' }, 404));
    await expect(fetchReplay('deadbeef')).rejects.toMatchObject({ status: 404, message: expect.stringContaining('match not found') });
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(fetchMatches()).rejects.toBeInstanceOf(ApiError);
    await expect(fetchMatches()).rejects.toThrow(/无法连接复盘服务/);
  });

  it('POST /api/replays/upload sends multipart `file` and rejects non-zip files locally', async () => {
    const { fn, calls } = installFetch({
      'POST /api/replays/upload': () => jsonResponse({ uploaded_count: 1, match_ids: ['abc'], matches: [MATCHES[2]] }),
    });
    vi.stubGlobal('fetch', fn);
    const file = new File([new Uint8Array([0x50, 0x4b, 3, 4])], 'replay.zip', { type: 'application/zip' });
    const res = await uploadReplay(file);
    expect(res.uploaded_count).toBe(1);
    expect(res.match_ids).toEqual(['abc']);
    expect(calls[0]!.init?.method).toBe('POST');
    const body = calls[0]!.init?.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect((body.get('file') as File).name).toBe('replay.zip');

    expect(isZipFile({ name: 'A.ZIP' })).toBe(true);
    await expect(uploadReplay(new File(['x'], 'notes.txt'))).rejects.toThrow('仅支持 .zip');
    expect(calls).toHaveLength(1);
  });
});

describe('format helpers (data honesty)', () => {
  it('never applies survivor talent names to hunters and shows raw PIDs', () => {
    expect(talentLabel(1, { talent_id: 24, name: null })).toBe('监管天赋 #24');
    expect(talentLabel(1, { talent_id: 8, name: '飞轮效应' })).toBe('监管天赋 #8');
    expect(talentLabel(2, { talent_id: 8, name: '飞轮效应' })).toBe('飞轮效应');
    expect(talentLabel(2, { talent_id: 99, name: null })).toBe('天赋 #99');
    expect(pidLabel(126)).toBe('PID #126');
  });

  it('maps mode/result/source badges and encodes asset urls', () => {
    expect(modeKey(2)).toBe('rank');
    expect(modeKey(1)).toBe('match');
    expect(modeKey(4)).toBe('custom');
    expect(isHunterWin(MATCHES[0]!)).toBe(true);
    expect(isHunterWin(MATCHES[1]!)).toBe(false);
    expect(sourceBadge(MATCHES[0]!)).toBe('分享录像');
    expect(sourceBadge(MATCHES[1]!)).toBe('预置档案');
    expect(sourceBadge(MATCHES[2]!)).toBe('上传导入');
    expect(mapGridUrl('唐人街')).toBe(encodeURI('/assets/maps/唐人街_grid.jpg'));
    expect(matchMapUrl({ map_asset_url: null, map_name: '军工厂' })).toBe(encodeURI('/assets/maps/军工厂_grid.jpg'));
    expect(hunterPortraitUrl(null)).toBe('/assets/seal.jpg');
    expect(formatClock(482.36)).toBe('08:02');
    expect(formatClock(62.05, true)).toBe('01:02.0');
  });

  it('filters the tactical event feed by group', () => {
    const ev = makeReplay().events;
    expect(filterEvents(ev, 'key').map((e) => e.type)).toEqual(['hit_attack', 'pallet_drop', 'rescue_attempt']);
    expect(filterEvents(ev, 'skill').map((e) => e.id)).toEqual([3]);
    expect(filterEvents(ev, 'all')).toHaveLength(4);
  });
});
