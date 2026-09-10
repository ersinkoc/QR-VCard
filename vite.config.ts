import { defineConfig, loadEnv } from 'vite';
import type { ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const proxyUrl = (env.VITE_QR_PROXY_URL ?? '').trim();

  // Not an error — the same-origin path is what the single-port server answers, and a
  // reverse-proxy route on /api/qr is equally valid. But something must answer it:
  // without one of the three ways below the built app has nothing to talk to, so say
  // it at build time rather than at first scan.
  if (mode === 'production' && !proxyUrl) {
    console.warn(
      '[vite] VITE_QR_PROXY_URL is not set, so the app will POST to the same-origin path /api/qr.\n' +
        '       Something must answer that path: the single-port server (`npm run start`, or the root\n' +
        '       Dockerfile) answers it itself; a reverse proxy may route /api/qr to server/qr-proxy.mjs;\n' +
        '       or set VITE_QR_PROXY_URL to the proxy absolute URL. Otherwise QR generation fails at\n' +
        '       runtime (see README, "Single port").',
    );
  }

  /**
   * The hop from the Vite dev/preview server to the QR proxy.
   *
   * The browser's `Origin` header is dropped here. A request between our own
   * two servers is not a browser request, so CORS has no meaning on this hop —
   * but forwarding that header made `server/qr-proxy.mjs` reject every origin
   * missing from `QR_ALLOWED_ORIGINS`, which defaults to `http://localhost:5173`
   * alone. A browser sends `Origin` on every POST, even a same-origin one, so
   * the dev server reached through `127.0.0.1` and the preview server on :4173
   * both got a 403 from the proxy while the provider itself was healthy.
   */
  const qrProxy: Record<string, ProxyOptions> = {
    '/api/qr': {
      target: 'http://localhost:8787',
      changeOrigin: true,
      configure(proxy) {
        proxy.on('proxyReq', (proxyReq) => proxyReq.removeHeader('origin'));
      },
    },
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
      // The app calls the same-origin path /api/qr and Vite forwards it to the
      // local proxy (npm run qr:proxy), so the browser never makes a
      // cross-origin request and the provider's ApiKey stays on the server.
      // Production needs an equivalent route (see the warning above).
      proxy: qrProxy,
    },
    preview: {
      // Vite's preview server inherits server.proxy by default, but say it
      // explicitly: `npm run preview` is how the built app is checked locally,
      // and it must reach the proxy exactly like dev does.
      proxy: qrProxy,
    },
  };
});
