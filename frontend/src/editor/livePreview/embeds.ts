// Live Preview images and embeds (DESIGN §6.6.1, ROADMAP 10b): `![[file]]` and `![alt](file)`
// show the file as the reading of the note does (an image, audio, video, a PDF, a note one level
// deep, a file chip), through `NoteContext.renderEmbed`; web images load unless the per-device
// preference says to wait for a click. Everything is built with DOM calls from the note's text,
// never from HTML strings, so nothing in a note can inject markup.
import { WidgetType, type EditorView } from '@codemirror/view';
import type { FileEntry } from '../../api/types';
import { resolve } from '../../features/links';
import type { NoteContext } from '../context';
import type { EmbedSpec } from './model';

const cleanups = new WeakMap<HTMLElement, () => void>();

/** Images load and notes fetch their text after the widget is drawn: the editor measures again. */
export function remeasureOnChange(view: EditorView, el: HTMLElement): () => void {
  const measure = () => view.requestMeasure();
  // `load` does not bubble; a capturing listener hears every image inside.
  el.addEventListener('load', measure, true);
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
  observer?.observe(el);
  return () => {
    el.removeEventListener('load', measure, true);
    observer?.disconnect();
  };
}

function sameSpec(a: EmbedSpec, b: EmbedSpec): boolean {
  return a.target === b.target && a.subpath === b.subpath && a.display === b.display && a.url === b.url && a.size?.width === b.size?.width && a.size?.height === b.size?.height;
}

function applySize(img: HTMLImageElement, size: EmbedSpec['size']): void {
  if (!size) return;
  img.width = size.width;
  if (size.height !== null) {
    // An explicit WxH keeps its box; the image is letterboxed rather than distorted.
    img.height = size.height;
    img.style.height = `${size.height}px`;
    img.style.objectFit = 'contain';
  }
}

/** A vault file, shown as the reading of the note shows it. */
class FileEmbedWidget extends WidgetType {
  readonly entry: FileEntry;
  readonly spec: EmbedSpec;
  readonly note: NoteContext;
  constructor(entry: FileEntry, spec: EmbedSpec, note: NoteContext) {
    super();
    this.entry = entry;
    this.spec = spec;
    this.note = note;
  }
  override eq(other: FileEmbedWidget): boolean {
    // The same file at the same version: an edit elsewhere in the note redraws nothing.
    return other.entry.path === this.entry.path && other.entry.size === this.entry.size && other.entry.mtime === this.entry.mtime && sameSpec(other.spec, this.spec);
  }
  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement('span');
    el.className = `cm-lp-embed cm-lp-embed-${this.entry.kind}`;
    const unmount = this.note.renderEmbed(el, { entry: this.entry, subpath: this.spec.subpath, display: this.spec.display, size: this.spec.size });
    const unmeasure = remeasureOnChange(view, el);
    cleanups.set(el, () => {
      unmeasure();
      unmount();
    });
    return el;
  }
  override destroy(dom: HTMLElement): void {
    cleanups.get(dom)?.();
    cleanups.delete(dom);
  }
  override ignoreEvent(): boolean {
    // A click on an image places the caret by it; media, PDFs and notes take their own clicks.
    return this.entry.kind !== 'image';
  }
}

/** An image from the web, or (with remote images off) a placeholder that loads it on a click. */
class WebImageWidget extends WidgetType {
  readonly spec: EmbedSpec;
  readonly load: boolean;
  constructor(spec: EmbedSpec, load: boolean) {
    super();
    this.spec = spec;
    this.load = load;
  }
  override eq(other: WebImageWidget): boolean {
    return other.load === this.load && sameSpec(other.spec, this.spec);
  }
  private image(view: EditorView): HTMLImageElement {
    const img = document.createElement('img');
    img.src = this.spec.url ?? '';
    img.alt = this.spec.display ?? '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    applySize(img, this.spec.size);
    img.addEventListener('load', () => view.requestMeasure());
    return img;
  }
  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement('span');
    el.className = 'cm-lp-embed cm-lp-embed-image cm-lp-web-image';
    // `data:` images are part of the note: nothing to fetch.
    if (this.load || this.spec.url?.toLowerCase().startsWith('data:')) {
      el.appendChild(this.image(view));
      return el;
    }
    const placeholder = document.createElement('span');
    placeholder.className = 'cm-lp-remote-image';
    placeholder.setAttribute('role', 'button');
    placeholder.title = this.spec.url ?? '';
    placeholder.textContent = this.spec.display || 'Remote image';
    placeholder.addEventListener('mousedown', (e) => e.preventDefault());
    placeholder.addEventListener('click', (e) => {
      e.preventDefault();
      placeholder.replaceWith(this.image(view));
      view.requestMeasure();
    });
    el.appendChild(placeholder);
    return el;
  }
  override ignoreEvent(event: Event): boolean {
    return event.target instanceof Element && event.target.closest('.cm-lp-remote-image') !== null;
  }
}

/**
 * An embed shown as a link: an embed whose file is not in the vault (dimmed, a click creates or
 * finds it as a link does), a note embedding itself, or a block reference (ROADMAP 20).
 */
class EmbedLinkWidget extends WidgetType {
  readonly text: string;
  readonly unresolved: boolean;
  constructor(text: string, unresolved: boolean) {
    super();
    this.text = text;
    this.unresolved = unresolved;
  }
  override eq(other: EmbedLinkWidget): boolean {
    return other.text === this.text && other.unresolved === this.unresolved;
  }
  toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = this.unresolved ? 'cm-lp-link cm-lp-embed-link cm-unresolved' : 'cm-lp-link cm-lp-embed-link';
    el.textContent = this.text;
    return el;
  }
}

/** The text a link to an embed shows: its display text, else "Note > Heading". */
function linkText(spec: EmbedSpec): string {
  if (spec.display) return spec.display;
  const target = spec.target ?? '';
  if (!spec.subpath) return target;
  return target ? `${target} > ${spec.subpath.replace(/#/g, ' > ')}` : spec.subpath;
}

/**
 * An image in a table cell (a cell holds a line of text, so other embeds show as typed there): a
 * vault image through the app's renderer, or a web image. Null when it is not an image.
 */
export function cellImage(view: EditorView, spec: EmbedSpec, note: NoteContext, remoteImages: boolean): HTMLElement | null {
  if (spec.url !== null) return new WebImageWidget(spec, remoteImages).toDOM(view);
  if (spec.target === null) return null;
  const tree = note.tree();
  const path = resolve(spec.target, note.path(), tree.links);
  const entry = path ? tree.byPath.get(path) : undefined;
  if (!entry || entry.kind !== 'image') return null;
  const el = document.createElement('span');
  el.className = 'cm-lp-embed cm-lp-embed-image';
  // An image needs no unmounting: it goes with the cell's content.
  note.renderEmbed(el, { entry, subpath: spec.subpath, display: spec.display, size: spec.size });
  el.addEventListener('load', () => view.requestMeasure(), true);
  return el;
}

/** The widget for an embed: the file, a web image, or a link. */
export function embedWidget(spec: EmbedSpec, note: NoteContext | null, remoteImages: boolean): WidgetType {
  if (spec.url !== null) return new WebImageWidget(spec, remoteImages);
  if (!note || spec.target === null) return new EmbedLinkWidget(linkText(spec), true);
  const tree = note.tree();
  const path = resolve(spec.target, note.path(), tree.links);
  const entry = path ? tree.byPath.get(path) : undefined;
  if (!entry) return new EmbedLinkWidget(linkText(spec), true);
  // Transclusion is one level deep and never of the note itself; block references are ROADMAP 20.
  if (entry.kind === 'note' && (entry.path === note.path() || spec.subpath?.startsWith('^'))) return new EmbedLinkWidget(linkText(spec), false);
  return new FileEmbedWidget(entry, spec, note);
}
