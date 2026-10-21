/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Set by the Dockerfile; "dev" otherwise (vite.config.ts). */
  readonly VITE_BUILD_SHA: string;
  /** "1" enables the in-memory mock API (dev only). */
  readonly VITE_MOCK_API?: string;
}

/** Glide Data Grid's lazily loaded cell editor (vite.config.ts), loaded ahead by the spreadsheet view. */
declare module 'glide-overlay-editor';

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
