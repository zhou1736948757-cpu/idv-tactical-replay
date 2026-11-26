import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig, type Plugin, type ResolvedConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

const apiTarget = process.env.VITE_API_PROXY_TARGET || 'http://127.0.0.1:8000';

const WOFF_FALLBACK_TRAILING_RE =
  /,\s*url\(\s*(?:['"]?(?:data:(?:application\/font-woff|font\/woff);base64,[^)'"]+|[^)'"]+\.woff(?:\?[^)'"]*)?)['"]?)\s*\)\s*format\(\s*['"]woff['"]\s*\)/gi;
const WOFF_FALLBACK_LEADING_RE =
  /url\(\s*(?:['"]?(?:data:(?:application\/font-woff|font\/woff);base64,[^)'"]+|[^)'"]+\.woff(?:\?[^)'"]*)?)['"]?)\s*\)\s*format\(\s*['"]woff['"]\s*\)\s*,\s*/gi;

function pruneDistPlugin(): Plugin {
  let resolved: ResolvedConfig | null = null;
  return {
    name: 'idv-prune-dist',
    apply: 'build',
    configResolved(config) {
      resolved = config;
    },
    closeBundle() {
      if (!resolved) return;
      const rootDir = path.resolve(resolved.root);
      const outDir = path.resolve(rootDir, resolved.build.outDir);
      const publicDir = resolved.publicDir ? path.resolve(rootDir, resolved.publicDir) : '';
      if (!fs.existsSync(outDir) || outDir === rootDir || (publicDir && outDir === publicDir)) {
        return;
      }

      const walk = (dir: string): void => {
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(fullPath);
            continue;
          }
          if (!entry.isFile()) continue;
          const lower = entry.name.toLowerCase();
          if (lower.endsWith('.woff')) {
            fs.rmSync(fullPath, { force: true });
            continue;
          }
          if (lower.endsWith('.css')) {
            const css = fs.readFileSync(fullPath, 'utf8');
            let stripped = css
              .replace(WOFF_FALLBACK_TRAILING_RE, '')
              .replace(WOFF_FALLBACK_LEADING_RE, '');
            const base = resolved?.base || '/';
            if (base !== '/' && base.startsWith('/')) {
              stripped = stripped
                .replace(/url\(\s*\/assets\//g, `url(${base}assets/`)
                .replace(/url\(\s*(['"])\/assets\//g, `url($1${base}assets/`);
            }
            if (stripped !== css) {
              fs.writeFileSync(fullPath, stripped, 'utf8');
            }
            continue;
          }
          if (lower.endsWith('.report.json') && path.basename(dir) === 'maps-3d') {
            fs.rmSync(fullPath, { force: true });
          }
        }
      };

      walk(outDir);
    },
  };
}

export default defineConfig({
  base: process.env.VITE_BASE || '/',
  plugins: [vue(), pruneDistPlugin()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
  preview: {
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (
            id.includes('node_modules/three/') ||
            id.includes('node_modules\\three\\') ||
            id.includes('node_modules/three-mesh-bvh/') ||
            id.includes('node_modules\\three-mesh-bvh\\')
          ) {
            return 'three';
          }
          return undefined;
        },
      },
    },
  },
});
