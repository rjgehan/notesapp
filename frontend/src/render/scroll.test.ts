import { describe, expect, it } from 'vitest';
import { findBlockElement } from './scroll';

describe('findBlockElement (item 20)', () => {
  it('finds a block by id, ignoring case and blocks inside embeds', () => {
    const el = document.createElement('div');
    el.innerHTML =
      '<div data-embed-root=""><p data-block-id="abc">embedded</p></div><p data-block-id="other">x</p><table data-block-id="ABC"></table>';
    expect(findBlockElement(el, 'abc')?.tagName).toBe('TABLE');
    expect(findBlockElement(el, 'missing')).toBeNull();
  });
});
