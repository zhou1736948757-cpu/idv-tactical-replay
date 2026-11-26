import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/__tests__/**/*.spec.ts'],
    globals: false,
    restoreMocks: true,
    // Process CSS so `manor.css?raw` returns the real stylesheet for token tests.
    css: { include: [/manor\.css/] },
  },
});
