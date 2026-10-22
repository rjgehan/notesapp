// Inline encrypted sections (ROADMAP item 27) show as their lock chip in Live Preview and locked
// notes too, never hidden as a comment and never as their ciphertext.
import { afterEach, describe, expect, it } from 'vitest';
import { destroyEditors, noteEditor } from '../../test/noteEditor';

afterEach(() => destroyEditors());

const B64 = 'QUJDREVGR0hJSktMTU5PUA==';
const NOTE = [`PIN: %%🔐β 💡usual💡${B64} 🔐%% and 🔐β ${B64} 🔐.`, '', `%%🔐β ${B64} 🔐%%`, '', 'After'].join('\n');

describe('encrypted sections in Live Preview', () => {
  for (const mode of ['live', 'locked', 'source'] as const) {
    it(`show as chips (${mode})`, () => {
      const view = noteEditor('‸' + NOTE.replace('After', 'After'), { mode });
      const chips = [...view.contentDOM.querySelectorAll('.encrypted-chip')].map((c) => c.textContent);
      expect(chips).toEqual(['🔒 Encrypted · usual', '🔒 Encrypted', '🔒 Encrypted']);
      expect(view.contentDOM.textContent).not.toContain(B64);
    });
  }
});
