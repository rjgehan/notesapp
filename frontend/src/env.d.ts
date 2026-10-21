/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Set by the Dockerfile; "dev" otherwise (vite.config.ts). */
  readonly VITE_BUILD_SHA: string;
  /** "1" enables the in-memory mock API (dev only). */
  readonly VITE_MOCK_API?: string;
  /** Where the build serves Excalidraw's fonts, `/assets/excalidraw-<version>/` (vite.config.ts). */
  readonly VITE_EXCALIDRAW_ASSETS: string;
}

interface Window {
  /** Base URL of Excalidraw's self-hosted fonts (views/excalidraw/register.ts). */
  EXCALIDRAW_ASSET_PATH?: string | string[];
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
