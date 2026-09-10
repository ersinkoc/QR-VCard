import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const proxyUrl = (env.VITE_QR_PROXY_URL ?? '').trim();

  // Not an error — a same-origin reverse-proxy route on /api/qr is a valid
  // production setup, and that is what the default assumes. But it IS a
  // requirement: without either the route or VITE_QR_PROXY_URL, the built app
  // has nothing to talk to, so say it at build time rather than at first scan.
  if (mode === 'production' && !proxyUrl) {
    console.warn(
      '[vite] VITE_QR_PROXY_URL is not set, so the app will POST to the same-origin path /api/qr.\n' +
        '       The host serving this build MUST route /api/qr to server/qr-proxy.mjs (see README, "QR proxy"),\n' +
        '       otherwise QR generation fails at runtime.',
    );
  }

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
          description: 'Share contact cards via QR codes',
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
          // Never let the service worker answer an API call with the SPA shell:
          // a 200 text/html for POST /api/qr would look like a success to the
          // app and hide the fact that the proxy route is missing.
          navigateFallbackDenylist: [/^\/api\//],
          globPatterns: ['**/*.{js,css,html,png,svg,woff2}'],
        },
      }),
    ],
    server: {
      // Dev-only convenience: the app calls the same-origin path /api/qr and Vite
      // forwards it to the local proxy (npm run qr:proxy), so the browser never
      // makes a cross-origin request and the provider's ApiKey stays on the
      // server. Production needs an equivalent route (see the warning above).
      proxy: {
        '/api/qr': {
          target: 'http://localhost:8787',
          changeOrigin: true,
        },
      },
    },
  };
});
