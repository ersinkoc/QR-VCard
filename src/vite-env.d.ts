/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  readonly VITE_DIRECTUS_URL?: string;
  readonly VITE_QR_API_URL?: string;
  readonly VITE_QR_API_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
