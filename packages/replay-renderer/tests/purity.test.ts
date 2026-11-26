import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as api from '../src/index';
import { MockCanvas2DContext } from './helpers/mockCanvas';
import { makePayload } from './helpers/fixtures';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcRoot = join(pkgRoot, 'src');

function listTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listTs(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** Remove comments and string/template literals so only code identifiers remain. */
function stripCommentsAndStrings(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/.*$/gm, ' ')
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, '``')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""');
}

describe('AC-1 zero-DOM purity', () => {
  const files = listTs(srcRoot);

  it('src contains the expected modules', () => {
    const names = files.map((f) => f.slice(srcRoot.length + 1).replace(/\\/g, '/')).sort();
    expect(names).toEqual(['index.ts', 'projection.ts', 'renderer.ts', 'ruler.ts', 'state.ts', 'types.ts']);
  });

  it('has zero DOM / framework identifiers in src/**/*.ts code', () => {
    const banned = [/\bwindow\b/, /\bdocument\b/, /\bHTMLElement\b/, /\bHTMLCanvasElement\b/, /\bnew\s+Image\b/, /\bImage\s*\(/, /\bvue\b/i, /\breact\b/i, /\bCanvasRenderingContext2D\b/, /\bglobalThis\b/, /\brequire\s*\(/];
    const hits: string[] = [];
    for (const f of files) {
      const code = stripCommentsAndStrings(readFileSync(f, 'utf8'));
      for (const re of banned) if (re.test(code)) hits.push(`${f}: ${re}`);
    }
    expect(hits).toEqual([]);
  });

  it('has zero raw occurrences of hard DOM tokens even in comments/strings', () => {
    const banned = [/HTMLElement/, /HTMLCanvasElement/, /new Image/, /document\./, /window\./, /from ['"]vue['"]/, /from ['"]react['"]/];
    const hits: string[] = [];
    for (const f of files) {
      const raw = readFileSync(f, 'utf8');
      for (const re of banned) if (re.test(raw)) hits.push(`${f}: ${re}`);
    }
    expect(hits).toEqual([]);
  });

  it('only imports relative modules (no external runtime deps)', () => {
    for (const f of files) {
      const raw = readFileSync(f, 'utf8');
      const specs = [...raw.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((m) => m[1] as string);
      for (const s of specs) expect(s.startsWith('./')).toBe(true);
    }
  });

  it('tsconfig enforces strict + ES2022 lib without DOM; package has empty dependencies', () => {
    const ts = JSON.parse(readFileSync(join(pkgRoot, 'tsconfig.json'), 'utf8'));
    expect(ts.compilerOptions.strict).toBe(true);
    expect(ts.compilerOptions.lib).toEqual(['ES2022']);
    expect(JSON.stringify(ts).toLowerCase()).not.toContain('"dom');
    const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
    expect(pkg.name).toBe('@idv/replay-renderer');
    expect(pkg.dependencies).toEqual({});
    expect(Object.keys(pkg.devDependencies).sort()).toEqual(['typescript', 'vitest']);
  });

  it('runs end-to-end in pure Node with no DOM globals present', () => {
    const g = globalThis as Record<string, unknown>;
    expect(g['window']).toBeUndefined();
    expect(g['document']).toBeUndefined();
    const ctx = new MockCanvas2DContext();
    const r = new api.TacticalReplayRenderer(ctx, { width: 800, height: 600, dpr: 2 });
    r.setPayload(makePayload());
    r.fitToWorld();
    r.setCamera({ pitchDeg: 50, yawDeg: 30, yScale: 2 });
    expect(() => r.render(42)).not.toThrow();
    expect(ctx.calls.length).toBeGreaterThan(100);
  });
});
