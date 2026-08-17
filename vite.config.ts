import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { claudeProxy } from './server/claudeProxy.ts';

export default defineConfig({
  plugins: [react(), claudeProxy()],
  clearScreen: false,
  server: {
    port: 1430,
    strictPort: true,
  },
  resolve: {
    alias: {
      '@domain': fileURLToPath(new URL('./src/domain', import.meta.url)),
      '@claude': fileURLToPath(new URL('./src/claude', import.meta.url)),
      '@store': fileURLToPath(new URL('./src/store', import.meta.url)),
      '@ui': fileURLToPath(new URL('./src/ui', import.meta.url)),
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'eval/**/*.test.ts'],
  },
});
