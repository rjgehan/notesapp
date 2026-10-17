// Excalidraw's fonts are self-hosted (register.ts sets EXCALIDRAW_ASSET_PATH), but every FontFace it
// creates also lists its CDN (esm.sh) as a fallback source. The CSP's `font-src 'self' data:` never
// lets the browser fetch it, yet Chromium reports a violation for each such source when the face is
// created: a couple of hundred console errors per drawing. Cross-origin sources are dropped from
// FontFace sources instead; nothing that could ever load is lost.
//
// The same wrapper remembers each face Excalidraw registers (family, self-hosted URL, unicode
// range): drawing embeds inline the fonts their SVG uses from these (svg.ts), since Excalidraw's own
// inlining needs WebAssembly that the CSP does not allow.

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

/** A font face as Excalidraw registered it, with its same-origin font file. */
export interface FontFaceRecord {
  family: string;
  url: string;
  unicodeRange: string;
}

const records = new Map<string, FontFaceRecord>();

/** The same-origin font files of a CSS `src` list, as absolute URLs. */
export function sameOriginFontUrls(source: string, origin: string): string[] {
  const urls: string[] = [];
  for (const m of source.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/g)) {
    if (m[2].startsWith('data:')) continue;
    try {
      const url = new URL(m[2], origin);
      if (url.origin === origin) urls.push(url.href);
    } catch {
      // Not a URL.
    }
  }
  return urls;
}

/** Remembers a face (the first same-origin file of each family and range). */
export function recordFontFace(family: string, source: string, unicodeRange: string | undefined, origin: string): void {
  const url = sameOriginFontUrls(source, origin)[0];
  if (!url) return;
  const name = family.trim().replace(/^(['"])(.*)\1$/, '$2');
  records.set(url, { family: name, url, unicodeRange: unicodeRange || 'U+0-10FFFF' });
}

/** Every face Excalidraw has registered so far (it registers all of them on first use). */
export function excalidrawFontFaces(): FontFaceRecord[] {
  return [...records.values()];
}

let installed = false;

/** Wraps `window.FontFace` once; call before Excalidraw registers its fonts (it does so lazily). */
export function keepFontsSameOrigin(): void {
  if (installed || typeof window === 'undefined' || typeof window.FontFace !== 'function') return;
  installed = true;
  const Native = window.FontFace;
  window.FontFace = class extends Native {
    constructor(family: string, source: string | BufferSource, descriptors?: FontFaceDescriptors) {
      const origin = window.location.origin;
      super(family, typeof source === 'string' ? sameOriginFontSources(source, origin) : source, descriptors);
      if (typeof source === 'string') recordFontFace(family, source, descriptors?.unicodeRange, origin);
    }
  };
}
