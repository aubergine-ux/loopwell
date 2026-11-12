import { svelte } from '@sveltejs/vite-plugin-svelte';
import { VitePWA } from 'vite-plugin-pwa';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // relative base, so the build works from any path (GitHub Pages serves it from /loopwell/)
  base: './',
  plugins: [
    svelte(),
    VitePWA({
      registerType: 'autoUpdate',
      workbox: {
        // precache everything, drum kits included, so the app works fully offline
        globPatterns: ['**/*.{js,css,html,svg,png,woff2,wav}'],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
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
  build: { target: 'es2022' },
  test: { include: ['tests/**/*.test.ts'] },
});
