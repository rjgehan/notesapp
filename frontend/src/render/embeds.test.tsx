import { act, waitFor } from '@testing-library/react';
import { Shapes } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import type { FileEntry } from '../api/types';
import { registerView, type EmbedProps } from '../views/registry';
import { hydrateEmbeds, playAudioOnlyAsAudio, unmountEmbeds, type EmbedContext } from './embeds';
import { renderNote, type RenderContext } from './render';

function entry(path: string, kind: FileEntry['kind']): FileEntry {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return { path, name, basename: name, extension: name.slice(name.lastIndexOf('.') + 1), kind, size: 1, mtime: '2026-10-17T10:00:00.000Z', version: 'v', aliases: [] };
}

const FILES = [entry('Shapes/House.fake', 'text'), entry('Shapes/Map.fake.md', 'note'), entry('Plan.md', 'note'), entry('Docs/Manual.pdf', 'pdf')];
const byPath = new Map(FILES.map((f) => [f.path, f]));

function Fake(props: EmbedProps) {
  return <span data-testid="fake">{`${props.path} ${props.width ?? '-'}x${props.height ?? '-'}${props.display ? ' ' + props.display : ''} depth ${props.depth}`}</span>;
}

// A view like the drawings': it claims a file kind and a note name, and embeds through loadEmbed.
registerView({ id: 'markdown', match: (e) => (e.path.endsWith('.md') ? 3 : 0), icon: Shapes, textual: true, modes: ['edit'], load: async () => ({ default: () => null }) });
for (const [id, suffix, score] of [
  ['fake', '.fake', 5],
  ['fake-md', '.fake.md', 8],
] as const) {
  registerView({
    id,
    match: (e) => (e.path.endsWith(suffix) ? score : 0),
    icon: Shapes,
    textual: true,
    modes: ['edit'],
    load: async () => ({ default: () => null }),
    loadEmbed: async () => ({ default: Fake }),
  });
}

// PDFs embed through their view (PDF.js, ROADMAP item 32), not an iframe.
function PdfFake(props: EmbedProps) {
  return <span data-testid="pdf">{`${props.path} #${props.subpath ?? ''} ${props.height ?? '-'}`}</span>;
}
registerView({ id: 'pdf', match: (e) => (e.kind === 'pdf' ? 2 : 0), icon: Shapes, textual: false, modes: ['read'], load: async () => ({ default: () => null }), loadEmbed: async () => ({ default: PdfFake }) });

function renderCtx(depth: number): RenderContext {
  return {
    sourcePath: 'Plan.md',
    resolve: (t) => FILES.find((f) => f.path === t || f.path.endsWith('/' + t) || f.path === t + '.md' || f.path.endsWith('/' + t + '.md')) ?? null,
    rawUrl: (e) => `/raw/${e.path}`,
    strictLineBreaks: false,
    loadRemoteImages: true,
    depth,
  };
}

const embedCtx = (depth: number): EmbedContext => ({ sourcePath: 'Plan.md', depth, entry: (p) => byPath.get(p), rawUrl: (e) => `/raw/${e.path}` });

describe('embeds of files another view shows (drawings)', () => {
  it('pass |W and |WxH to the view’s embed', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    container.appendChild(renderNote('![[House.fake|400]]\n\n![[House.fake|300x200]]\n\n![[House.fake|A house]]', renderCtx(0)).fragment);
    act(() => hydrateEmbeds(container, embedCtx(0)));
    await waitFor(() => expect(container.querySelectorAll('[data-testid="fake"]')).toHaveLength(3));
    expect([...container.querySelectorAll('[data-testid="fake"]')].map((e) => e.textContent)).toEqual([
      'Shapes/House.fake 400x- depth 1',
      'Shapes/House.fake 300x200 depth 1',
      'Shapes/House.fake -x- A house depth 1',
    ]);
    act(() => unmountEmbeds(container));
    container.remove();
  });

  it('embed a note another view shows at any depth, unlike a transclusion', async () => {
    const nested = renderNote('![[Map.fake]]\n\n![[Plan]]', renderCtx(1)).fragment;
    expect(nested.querySelector('[data-embed-kind]')?.getAttribute('data-embed-path')).toBe('Shapes/Map.fake.md');
    expect(nested.querySelectorAll('[data-embed-kind]')).toHaveLength(1);
    const container = document.createElement('div');
    document.body.appendChild(container);
    container.appendChild(nested);
    act(() => hydrateEmbeds(container, embedCtx(1)));
    await waitFor(() => expect(container.querySelector('[data-testid="fake"]')?.textContent).toBe('Shapes/Map.fake.md -x- depth 2'));
    act(() => unmountEmbeds(container));
    container.remove();
  });
});

describe('PDF embeds', () => {
  it('mount the PDF view’s embed with the page and height of the subpath, at any depth', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    container.appendChild(renderNote('![[Manual.pdf#page=3]]\n\n![[Manual.pdf#height=300]]\n\n![[Manual.pdf|200]]', renderCtx(1)).fragment);
    expect(container.querySelector('iframe')).toBeNull();
    act(() => hydrateEmbeds(container, embedCtx(1)));
    await waitFor(() => expect(container.querySelectorAll('[data-testid="pdf"]')).toHaveLength(3));
    expect([...container.querySelectorAll('[data-testid="pdf"]')].map((e) => e.textContent)).toEqual(['Docs/Manual.pdf #page=3 -', 'Docs/Manual.pdf #height=300 -', 'Docs/Manual.pdf # -']);
    act(() => unmountEmbeds(container));
    container.remove();
  });
});

describe('audio-only video embeds', () => {
  function video(width: number) {
    const v = document.createElement('video');
    v.src = '/raw/Recording.webm';
    Object.defineProperty(v, 'videoWidth', { value: width });
    Object.defineProperty(v, 'videoHeight', { value: width ? 360 : 0 });
    const box = document.createElement('span');
    box.appendChild(v);
    document.body.appendChild(box);
    return { v, box };
  }

  it('play a voice note recorded as WebM in an audio player', () => {
    const { v, box } = video(0);
    playAudioOnlyAsAudio(v);
    v.dispatchEvent(new Event('loadedmetadata'));
    const audio = box.querySelector('audio');
    expect(box.querySelector('video')).toBeNull();
    expect(audio?.controls).toBe(true);
    expect(audio?.src.endsWith('/raw/Recording.webm')).toBe(true);
    box.remove();
  });

  it('keep a real video a video', () => {
    const { v, box } = video(640);
    playAudioOnlyAsAudio(v);
    v.dispatchEvent(new Event('loadedmetadata'));
    expect(box.querySelector('video')).toBe(v);
    box.remove();
  });
});
