import { defineConfig, loadEnv } from 'vite';
import type { ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  /**
   * Development only: Vite forwards /api/* (app API and QR) to the Node server
   * (`npm run api`), so the browser still sees ONE origin, as in production.
   * The Host header is kept (no changeOrigin): the server's same-origin check and
   * the QR links it builds then see the address the browser actually uses.
   */
  const apiProxy: Record<string, ProxyOptions> = {
    '/api': { target: `http://localhost:${env.PORT || 8787}` },
  };

  return {
    plugins: [
      react(),
      tailwindcss(),
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: ['favicon.svg', 'pwa-192.png', 'pwa-512.png', 'maskable-512.png'],
        manifest: {
          name: 'QR-VCard',
          short_name: 'QR-VCard',
          description: 'Dijital kartvizit · Digital business cards',
          lang: 'tr',
          theme_color: '#191921',
          background_color: '#fbfbfd',
          display: 'standalone',
          start_url: '/',
          icons: [
            { src: '/pwa-192.png', sizes: '192x192', type: 'image/png' },
            { src: '/pwa-512.png', sizes: '512x512', type: 'image/png' },
            { src: '/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },
        workbox: {
          navigateFallback: '/index.html',
          // Never answer an API call with the SPA shell, never cache API answers.
          navigateFallbackDenylist: [/^\/api\//, /^\/healthz$/],
          globPatterns: ['**/*.{js,css,html,png,svg,woff2}'],
        },
      }),
    ],
    server: { proxy: apiProxy },
    preview: { proxy: apiProxy },
  };
});
