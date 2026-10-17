// Excalidraw's fonts are self-hosted (register.ts sets EXCALIDRAW_ASSET_PATH), but every FontFace it
// creates also lists its CDN (esm.sh) as a fallback source. The CSP's `font-src 'self' data:` never
// lets the browser fetch it, yet Chromium reports a violation for each such source when the face is
// created: a couple of hundred console errors per drawing. Cross-origin sources are dropped from
// FontFace sources instead; nothing that could ever load is lost.

/** A CSS `src` list without the `url()` sources of other origins (all of them, if none would stay). */
export function sameOriginFontSources(source: string, origin: string): string {
  const parts = source.split(/,(?=\s*url\()/);
  const kept = parts.filter((part) => {
    const m = /url\(\s*(['"]?)(.*?)\1\s*\)/.exec(part);
    if (!m || m[2].startsWith('data:')) return true;
    try {
      return new URL(m[2], origin).origin === origin;
    } catch {
      return true;
    }
  });
  return kept.length > 0 ? kept.join(',') : source;
}

let installed = false;

/** Wraps `window.FontFace` once; call before Excalidraw registers its fonts (it does so lazily). */
export function keepFontsSameOrigin(): void {
  if (installed || typeof window === 'undefined' || typeof window.FontFace !== 'function') return;
  installed = true;
  const Native = window.FontFace;
  window.FontFace = class extends Native {
    constructor(family: string, source: string | BufferSource, descriptors?: FontFaceDescriptors) {
      super(family, typeof source === 'string' ? sameOriginFontSources(source, window.location.origin) : source, descriptors);
    }
  };
}
