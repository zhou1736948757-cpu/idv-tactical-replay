/**
 * REST client for the Workflow/PLAN.md D1 API contract.
 * Defaults to root-relative (`/api/...`) so Vite's dev/preview proxy or a
 * same-origin deployment both work, while honoring `VITE_API_BASE` when configured.
 */
import type { MatchAnalyticsPayload, MatchSummary, Replay2DPayload } from '@idv/replay-renderer';
import { appBaseUrl, withBaseUrl } from '@/lib/assetUrl';

export interface UploadResult {
  uploaded_count: number;
  match_ids: string[];
  matches: MatchSummary[];
}

export type UploadProgressCallback = (pct: number) => void;

export interface UploadReplayOptions {
  onProgress?: UploadProgressCallback;
  signal?: AbortSignal;
}

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

const rawEnvBase = (import.meta.env?.VITE_API_BASE as string | undefined)?.trim();
export const API_BASE = (rawEnvBase || '/api').replace(/\/+$/, '') || '/api';
const STATIC_DEMO_MODE = (import.meta.env?.VITE_STATIC_DEMO as string | undefined) === '1';

function rewriteAssetUrls<T>(data: T): T {
  if (!data || typeof data !== 'object') return data;
  const obj = data as Record<string, unknown>;
  if (typeof obj.map_asset_url === 'string' && obj.map_asset_url.startsWith('/assets/')) {
    obj.map_asset_url = withBaseUrl(obj.map_asset_url);
  }
  if (obj.matches && Array.isArray(obj.matches)) {
    for (const m of obj.matches) rewriteAssetUrls(m);
  }
  if (obj.match && typeof obj.match === 'object') {
    rewriteAssetUrls(obj.match);
  }
  const world = obj.world as Record<string, unknown> | undefined;
  const underlay = world?.map_underlay as Record<string, unknown> | undefined;
  if (underlay && typeof underlay.asset_url === 'string' && underlay.asset_url.startsWith('/assets/')) {
    underlay.asset_url = withBaseUrl(underlay.asset_url);
  }
  return data;
}

function staticFallbackUrl(path: string): string {
  const base = `${appBaseUrl()}static-api`;
  const clean = path.startsWith('/') ? path : `/${path}`;
  return `${base}${clean}.json`;
}

const NETWORK_ERROR_MSG = '无法连接复盘服务，请检查网络或稍后重试';

function formatStatusError(status: number, detail: string): ApiError {
  const base =
    status === 404 ? '档案不存在 (404)' : status === 413 ? '文件过大 (413)' : `请求失败 (HTTP ${status})`;
  return new ApiError(detail ? `${base}：${detail}` : base, status);
}

function extractDetail(parsed: unknown): string {
  if (!parsed || typeof parsed !== 'object') return '';
  const body = parsed as { detail?: unknown };
  if (typeof body.detail === 'string') return body.detail;
  if (body.detail !== undefined) return JSON.stringify(body.detail);
  return '';
}

async function readError(res: Response): Promise<ApiError> {
  let detail = '';
  try {
    detail = extractDetail(await res.json());
  } catch {
    /* non-JSON body */
  }
  return formatStatusError(res.status, detail);
}

function normalizeUploadResult(body: Partial<UploadResult> | null | undefined): UploadResult {
  return {
    uploaded_count: Number(body?.uploaded_count ?? 0),
    match_ids: Array.isArray(body?.match_ids) ? body.match_ids : [],
    matches: Array.isArray(body?.matches) ? body.matches : [],
  };
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  if (STATIC_DEMO_MODE) {
    let staticRes: Response;
    try {
      staticRes = await fetch(staticFallbackUrl(path), { headers: { Accept: 'application/json' }, signal });
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') throw err;
      throw new ApiError(NETWORK_ERROR_MSG, 0);
    }
    if (!staticRes.ok) throw await readError(staticRes);
    return rewriteAssetUrls((await staticRes.json()) as T);
  }

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { headers: { Accept: 'application/json' }, signal });
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') throw err;
    throw new ApiError(NETWORK_ERROR_MSG, 0);
  }
  if (!res.ok) throw await readError(res);
  return rewriteAssetUrls((await res.json()) as T);
}

export async function fetchMatches(signal?: AbortSignal): Promise<MatchSummary[]> {
  const body = await getJson<{ matches: MatchSummary[] }>('/matches', signal);
  return Array.isArray(body?.matches) ? body.matches : [];
}

export function fetchReplay(matchId: string, signal?: AbortSignal): Promise<Replay2DPayload> {
  return getJson<Replay2DPayload>(`/matches/${encodeURIComponent(matchId)}/replay`, signal);
}

export function fetchAnalytics(matchId: string, signal?: AbortSignal): Promise<MatchAnalyticsPayload> {
  return getJson<MatchAnalyticsPayload>(`/matches/${encodeURIComponent(matchId)}/analytics`, signal);
}

export function isZipFile(file: { name: string }): boolean {
  return /\.zip$/i.test(file.name);
}

/**
 * POST /api/replays/upload (multipart `file` field).
 * Uses XMLHttpRequest for upload progress reporting when `onProgress` is provided
 * and `XMLHttpRequest` is available; falls back cleanly to `fetch` otherwise.
 */
export async function uploadReplayZip(
  file: File,
  opts?: UploadProgressCallback | UploadReplayOptions,
): Promise<UploadResult> {
  if (STATIC_DEMO_MODE) {
    throw new ApiError('当前为 GitHub Pages 纯静态演示版（内置 7 场复盘 + 9 图 2D/3D 沙盘），上传自定义 .zip 录像请使用本地/Docker 后端版', 501);
  }
  if (!isZipFile(file)) throw new ApiError('仅支持 .zip 录像压缩包', 400);
  const onProgress = typeof opts === 'function' ? opts : opts?.onProgress;
  const signal = typeof opts === 'function' ? undefined : opts?.signal;

  const form = new FormData();
  form.append('file', file, file.name);

  if (onProgress && typeof XMLHttpRequest !== 'undefined') {
    return new Promise<UploadResult>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${API_BASE}/replays/upload`);
      xhr.setRequestHeader('Accept', 'application/json');

      let cleanupAbort: (() => void) | undefined;
      if (signal) {
        if (signal.aborted) {
          reject(new DOMException('Aborted', 'AbortError'));
          return;
        }
        const onAbort = () => xhr.abort();
        signal.addEventListener('abort', onAbort, { once: true });
        cleanupAbort = () => signal.removeEventListener('abort', onAbort);
      }

      if (xhr.upload) {
        xhr.upload.onprogress = (ev: ProgressEvent) => {
          if (ev.lengthComputable && ev.total > 0) {
            onProgress(Math.min(100, Math.max(0, Math.round((ev.loaded / ev.total) * 100))));
          }
        };
      }

      xhr.onload = () => {
        cleanupAbort?.();
        let parsed: unknown = null;
        try {
          parsed = xhr.responseText ? JSON.parse(xhr.responseText) : null;
        } catch {
          parsed = null;
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          onProgress(100);
          resolve(normalizeUploadResult(parsed as Partial<UploadResult> | null));
        } else {
          reject(formatStatusError(xhr.status || 500, extractDetail(parsed)));
        }
      };

      xhr.onerror = () => {
        cleanupAbort?.();
        reject(new ApiError(`上传失败：${NETWORK_ERROR_MSG}`, 0));
      };

      xhr.onabort = () => {
        cleanupAbort?.();
        reject(new DOMException('Aborted', 'AbortError'));
      };

      xhr.send(form);
    });
  }

  let res: Response;
  try {
    res = await fetch(`${API_BASE}/replays/upload`, { method: 'POST', body: form, signal });
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') throw err;
    throw new ApiError(`上传失败：${NETWORK_ERROR_MSG}`, 0);
  }
  if (!res.ok) throw await readError(res);
  const body = (await res.json()) as UploadResult;
  return normalizeUploadResult(body);
}

export function uploadReplay(
  file: File,
  opts?: UploadProgressCallback | UploadReplayOptions,
): Promise<UploadResult> {
  return uploadReplayZip(file, opts);
}
