/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Set by the Dockerfile; "dev" otherwise (vite.config.ts). */
  readonly VITE_BUILD_SHA: string;
  /** "1" enables the in-memory mock API (dev only). */
  readonly VITE_MOCK_API?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
