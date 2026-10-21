// The root font size stays the browser's 16px (DESIGN §6.8.1, §6.16): Excalidraw's CSS is sized in
// rem for that root, so a smaller root shrinks every drawing control (phone tool buttons became
// 20 × 26 px). The app sets its UI size on body and sizes its own styles in px and em.
import { beforeAll, describe, expect, it } from 'vitest';
import { sourceFiles } from '../test/sources';

let sheets: Record<string, string> = {};

beforeAll(async () => {
  sheets = await sourceFiles('.css');
});

/** `selector { declarations }` of every innermost rule (inside @media too), comments removed. */
function rules(css: string): Array<{ selectors: string[]; body: string }> {
  const out: Array<{ selectors: string[]; body: string }> = [];
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    out.push({ selectors: m[1].split(',').map((s) => s.trim()), body: m[2] });
  }
  return out;
}

describe('the root font size', () => {
  it('reads the app stylesheets', () => {
    expect(Object.keys(sheets)).toEqual(expect.arrayContaining(['styles/app.css', 'styles/tokens.css', 'views/excalidraw/excalidraw.css']));
  });

  it('is not set by the app: the UI size goes on body', () => {
    const rootSizes = Object.entries(sheets).flatMap(([file, css]) =>
      rules(css)
        .filter((r) => r.selectors.some((s) => s === 'html' || s === ':root') && /(^|;|\s)font(-size)?\s*:/.test(r.body))
        .map((r) => `${file}: ${r.selectors.join(', ')}`),
    );
    expect(rootSizes).toEqual([]);
    const body = rules(sheets['styles/app.css']).filter((r) => r.selectors.includes('body') && /font-size\s*:/.test(r.body));
    expect(body.map((r) => r.body.trim())).toEqual(['font-size: var(--font-ui-small);']);
  });

  it('sizes the app’s own styles without rem', () => {
    const rem = Object.entries(sheets).flatMap(([file, css]) => [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/[\d.]+rem\b/g)].map((m) => `${file}: ${m[0]}`));
    expect(rem).toEqual([]);
  });
});
