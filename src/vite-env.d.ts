/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  readonly VITE_DIRECTUS_URL?: string;
  readonly VITE_QR_PROXY_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
