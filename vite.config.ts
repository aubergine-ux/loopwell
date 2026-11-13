import { svelte } from '@sveltejs/vite-plugin-svelte';
import { VitePWA } from 'vite-plugin-pwa';
import { defineConfig } from 'vitest/config';

// The desktop app (Tauri sets this while building) loads from disk, so it has no use for a service worker.
const desktop = !!process.env.TAURI_ENV_PLATFORM;

export default defineConfig({
  // relative base, so the build works from any path (GitHub Pages serves it from /loopwell/)
  base: './',
  plugins: [
    svelte(),
    !desktop && VitePWA({
      registerType: 'autoUpdate',
      workbox: {
        // precache everything, drum kits included, so the app works fully offline
        globPatterns: ['**/*.{js,css,html,svg,png,woff2,wav,wasm}'],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        // The neural-network runtime for stem separation is 29 MB and most people never open it, so it is not
        // fetched up front. It is kept the first time it is used, and after that works offline like the rest.
        globIgnores: ['**/ort-wasm*.wasm'],
        runtimeCaching: [{ urlPattern: /ort-wasm.*\.wasm$/, handler: 'CacheFirst', options: { cacheName: 'loopwell-stems-runtime' } }],
      },
      manifest: {
        name: 'Loopwell',
        short_name: 'Loopwell',
        description: 'A tactile beat maker that lives in your browser.',
        categories: ['music', 'entertainment'],
        display: 'standalone',
        start_url: './',
        scope: './',
        theme_color: '#1d1b18',
        background_color: '#d8d2c6',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml' },
        ],
      },
    }),
  ],
  // WebKit on macOS and Linux is the desktop app's browser
  build: { target: desktop ? ['es2022', 'safari15'] : 'es2022' },
  clearScreen: false,
  test: { include: ['tests/**/*.test.ts'] },
});
