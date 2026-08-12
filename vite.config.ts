import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  // Fixed port: Playwright tests assume 5199, and the installed dev PWA
  // (file-handler testing) points at this origin — failing beats silently
  // coming up on 5200.
  server: { port: 5199, strictPort: true },
});
