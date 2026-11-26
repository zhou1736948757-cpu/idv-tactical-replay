/**
 * Subpath-aware static asset URL helper for GitHub Pages (`VITE_BASE=/<repo>/`).
 * When `import.meta.env.BASE_URL` is `'/'` (local dev, Docker, Vitest), returns `path` unchanged.
 */
export function appBaseUrl(): string {
  const raw = (import.meta.env?.BASE_URL as string | undefined) || '/';
  return raw.endsWith('/') ? raw : `${raw}/`;
}

export function withBaseUrl(path: string): string {
  if (!path) return path;
  const base = appBaseUrl();
  if (base === '/' || !path.startsWith('/')) return path;
  if (path.startsWith(base)) return path;
  return `${base}${path.slice(1)}`;
}
