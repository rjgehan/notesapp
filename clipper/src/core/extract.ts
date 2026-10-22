// Article extraction (DESIGN §6.27.1): Mozilla Readability 0.6.0 on a copy of the page, or the
// selection only, then turndown. Runs wherever the page is: in the extension's content script, in
// the app's /clip page on the HTML a bookmarklet sent, and in the iOS Shortcut's JavaScript step.
// Nothing here fetches anything; images stay links (the extension may download them afterwards).
import { Readability } from '@mozilla/readability';
import { toMarkdown } from './markdown';
import type { Clip, ExtractOptions } from './types';

/** The page's address without its fragment. */
export function pageUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.href;
  } catch {
    return url;
  }
}

function absolute(value: string, base: string): string | null {
  try {
    return new URL(value.trim(), base).href;
  } catch {
    return null;
  }
}

/** The first plausible image of a lazy-loaded `<img>`: `src`, else `data-src` and friends, else `srcset`. */
function imageSource(img: Element): string {
  const src = img.getAttribute('src') ?? '';
  if (src && !src.startsWith('data:')) return src;
  for (const name of ['data-src', 'data-original', 'data-lazy-src', 'data-url']) {
    const v = img.getAttribute(name);
    if (v && !v.startsWith('data:')) return v;
  }
  const srcset = img.getAttribute('srcset') ?? img.getAttribute('data-srcset') ?? '';
  const first = srcset.split(',')[0]?.trim().split(/\s+/)[0];
  return first && !first.startsWith('data:') ? first : '';
}

/**
 * Makes links and images absolute against `base` (so Markdown works away from the page), drops
 * inline `data:` images, and returns the images' URLs, each once.
 */
export function absolutize(root: Element, base: string): string[] {
  const images: string[] = [];
  for (const a of Array.from(root.querySelectorAll('a[href]'))) {
    const href = a.getAttribute('href') ?? '';
    if (href.startsWith('#')) continue;
    const abs = absolute(href, base);
    if (abs) a.setAttribute('href', abs);
    else a.removeAttribute('href');
  }
  for (const img of Array.from(root.querySelectorAll('img'))) {
    const src = imageSource(img);
    const abs = src ? absolute(src, base) : null;
    if (!abs || !/^https?:/i.test(abs)) {
      img.remove();
      continue;
    }
    img.setAttribute('src', abs);
    if (!images.includes(abs)) images.push(abs);
  }
  for (const el of Array.from(root.querySelectorAll('iframe[src], video[src], audio[src], source[src]'))) {
    const abs = absolute(el.getAttribute('src') ?? '', base);
    if (abs) el.setAttribute('src', abs);
  }
  return images;
}

function metaContent(doc: Document, ...keys: string[]): string | null {
  for (const key of keys) {
    const el = doc.querySelector(`meta[property="${key}"], meta[name="${key}"], meta[itemprop="${key}"]`);
    const v = el?.getAttribute('content')?.trim();
    if (v) return v;
  }
  return null;
}

/** A `<base>` with an absolute address, so Readability (which reads `baseURI`) resolves links against the page. */
function pinBase(doc: Document, url: string): void {
  let base = doc.querySelector('base[href]');
  const href = base ? (absolute(base.getAttribute('href') ?? '', url) ?? url) : url;
  if (!base) {
    base = doc.createElement('base');
    (doc.head ?? doc.documentElement).prepend(base);
  }
  base.setAttribute('href', href);
}

function nonEmpty(s: string | null | undefined): string | null {
  const v = s?.replace(/\s+/g, ' ').trim();
  return v ? v : null;
}

/** The page's body without its chrome, for pages Readability finds nothing readable in. */
function wholeBody(doc: Document): Element {
  const body = (doc.body ?? doc.documentElement).cloneNode(true) as Element;
  for (const el of Array.from(body.querySelectorAll('nav, header, footer, aside, script, style, noscript, [role="navigation"], [aria-hidden="true"]'))) {
    el.remove();
  }
  return body;
}

/**
 * Extracts a clip from `doc`, which is never changed (Readability works on a copy). With
 * `selectionHtml`, only that HTML becomes the body; the page still provides the metadata.
 */
export function extractDocument(doc: Document, options: ExtractOptions = {}): Clip {
  const url = pageUrl(options.url ?? doc.URL);
  const copy = doc.cloneNode(true) as Document;
  pinBase(copy, url);
  const base = copy.querySelector('base')?.getAttribute('href') ?? url;
  const article = new Readability(copy, { keepClasses: true, serializer: (el: Node) => el as Element }).parse();

  let body: Element;
  const selection = !!options.selectionHtml?.trim();
  if (selection) {
    body = copy.createElement('div');
    body.innerHTML = options.selectionHtml ?? '';
  } else if (article?.content) {
    body = article.content;
  } else {
    body = wholeBody(copy);
  }
  const images = absolutize(body, base);
  const markdown = toMarkdown(body);

  return {
    title: nonEmpty(article?.title) ?? nonEmpty(doc.title) ?? nonEmpty(metaContent(doc, 'og:title')) ?? '',
    url,
    author: nonEmpty(article?.byline) ?? nonEmpty(metaContent(doc, 'author', 'article:author')),
    siteName: nonEmpty(article?.siteName) ?? nonEmpty(metaContent(doc, 'og:site_name')),
    published: nonEmpty(article?.publishedTime) ?? nonEmpty(metaContent(doc, 'article:published_time', 'datePublished')),
    description: nonEmpty(metaContent(doc, 'description', 'og:description')) ?? nonEmpty(article?.excerpt),
    markdown,
    images: images.filter((src) => markdown.includes(src.replace(/[ ()]/g, (c) => encodeURIComponent(c)))),
    selection,
  };
}

/**
 * Extracts a clip from a page's HTML (what the bookmarklet sends to the /clip page). The HTML is
 * parsed into an inert document: its scripts never run and its images never load.
 */
export function extractHtml(html: string, url: string, options: Omit<ExtractOptions, 'url'> = {}): Clip {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return extractDocument(doc, { ...options, url });
}
