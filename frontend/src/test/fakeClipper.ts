// A stand-in for /clipper/clipper.js in tests (the real one is tested in clipper/).
import type { Clip, NotesClipper } from '../features/clip';

export const CLIP: Clip = {
  title: 'A page',
  url: 'https://site.example.com/a',
  author: null,
  siteName: 'Site',
  published: null,
  description: null,
  markdown: 'Text ![pic](https://cdn.example.com/p.png) more ![pic](https://cdn.example.com/p.png)',
  images: ['https://cdn.example.com/p.png'],
  selection: false,
};

export const fakeClipper: NotesClipper = {
  version: 1,
  defaultFolder: 'Clippings',
  extractHtml: (html, url, options) => ({ ...CLIP, url, title: /<title>(.*?)<\/title>/.exec(html)?.[1] ?? '', markdown: options?.selectionHtml ? `SEL:${options.selectionHtml}` : `HTML:${html.length}`, images: [] }),
  composeNote: (clip, o) => ({ path: `${o?.folder ?? 'Clippings'}/${o?.basename ?? clip.title}.md`, content: `---\ntitle: "${clip.title}"\n---\n\n${clip.markdown}\n`, onConflict: 'rename' }),
  noteBasename: (t) => t.replace(/[:/]/g, '') || 'Clipping',
  notePath: (f, b) => `${f}/${b}.md`,
  replaceImage: (md, url, embed) => md.split(`![pic](${url})`).join(embed),
  localDate: () => '2026-10-21',
};

