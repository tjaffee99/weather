import { defineConfig } from 'vite';

export default defineConfig({
  // relative base so the build works on GitHub Pages project sites and any sub-path
  base: './',
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
});
