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
    watch: {
      /**
       * Rust build output and tool caches are not frontend source, and watching them is
       * actively harmful.
       *
       * `cargo` rewrites and locks files under `target/` while it compiles, so on Windows the
       * watcher hits `EBUSY` on a `.pdb` mid-build and takes the whole dev server down with an
       * unhandled error. Anyone running `npm run dev` alongside `npm run tauri:dev` — which is
       * the normal way to work on the desktop build — would hit this.
       *
       * Dot-directories are excluded for the same reason: editor state, browser profiles and
       * assorted caches all keep locked SQLite files open, and none of them are ever served.
       */
      ignored: [
        '**/src-tauri/target/**',
        '**/src-tauri/gen/**',
        '**/dist/**',
        '**/.*/**',
      ],
    },
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
    include: ['src/**/*.test.ts', 'eval/**/*.test.ts', 'server/**/*.test.ts'],
  },
});
