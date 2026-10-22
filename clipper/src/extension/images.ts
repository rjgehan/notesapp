// Downloading a clip's images (DESIGN §6.27.1), in the extension's background, which may fetch
// any site once the user granted access to all sites. The bytes go to the /clip page as base64,
// and the page stores each one as an attachment (POST /api/attachments, API.md §9.3).
import type { ClipImage } from '../core/protocol';

export interface ImageLimits {
  /** At most this many images. */
  count: number;
  /** Bigger images stay links. */
  maxBytes: number;
  /** Once the downloads reach this, the rest stay links. */
  totalBytes: number;
  timeoutMs: number;
}

export const LIMITS: ImageLimits = { count: 40, maxBytes: 10 * 1024 * 1024, totalBytes: 40 * 1024 * 1024, timeoutMs: 20_000 };

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
};

/** The image types the app shows (DESIGN §4.2); anything else stays a link. */
export function imageExtension(mime: string): string | null {
  return EXTENSIONS[mime.split(';')[0].trim().toLowerCase()] ?? null;
}

/** A file name from the URL's last path segment, with the extension its type calls for. */
export function imageName(url: string, mime: string, index: number): string {
  const ext = imageExtension(mime) ?? 'png';
  let base = '';
  try {
    const seg = new URL(url).pathname.split('/').filter(Boolean).pop() ?? '';
    base = decodeURIComponent(seg);
  } catch {
    base = '';
  }
  base = base.replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/[^\p{L}\p{N} _.-]+/gu, '-').replace(/^[-. ]+|[-. ]+$/g, '').slice(0, 80);
  if (!base) base = `image ${index + 1}`;
  return `${base}.${ext}`;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Downloads what it can of `urls` within `limits`; an image that fails, is too big or is not an
 * image the app shows is left out (its Markdown keeps the remote link).
 */
export async function downloadImages(urls: string[], limits: ImageLimits = LIMITS, fetchFn: typeof fetch = fetch): Promise<ClipImage[]> {
  const out: ClipImage[] = [];
  let total = 0;
  for (const [i, url] of urls.slice(0, limits.count).entries()) {
    if (!/^https?:\/\//i.test(url)) continue;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), limits.timeoutMs);
    try {
      const res = await fetchFn(url, { credentials: 'omit', redirect: 'follow', signal: controller.signal });
      if (!res.ok) continue;
      const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      if (!imageExtension(type)) continue;
      const declared = Number(res.headers.get('content-length') ?? '0');
      if (declared > limits.maxBytes || total + declared > limits.totalBytes) continue;
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length > limits.maxBytes || total + bytes.length > limits.totalBytes) continue;
      total += bytes.length;
      out.push({ url, name: imageName(url, type, i), type, data: toBase64(bytes) });
    } catch {
      // Left as a link.
    } finally {
      clearTimeout(timer);
    }
  }
  return out;
}
