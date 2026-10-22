// The `/` menu's script and Dataview items (ROADMAP items 40 and 17, DESIGN §6.43).
import { afterEach, describe, expect, it } from 'vitest';
import { slashItems } from '../editor/slash';
import { destroyEditors, marked, noteEditor } from '../test/noteEditor';
import { registerScripts } from './register';

afterEach(() => destroyEditors());

describe('slash items', () => {
  it('insert a script block and a Dataview query with the caret on their first line', () => {
    registerScripts();
    const items = slashItems();
    const script = items.find((i) => i.id === 'script')!;
    const dataview = items.find((i) => i.id === 'dataview')!;
    expect(script.label).toBe('Script block');
    expect(dataview.label).toBe('Dataview query');
    const view = noteEditor('‸', { mode: 'source' });
    script.run(view);
    expect(marked(view)).toBe('```script\n‸show("Today is " + today().format("dddd D MMMM"))\n```');
    const other = noteEditor('‸', { mode: 'source' });
    dataview.run(other);
    expect(marked(other)).toBe('```dataview\n‸TABLE file.mtime AS "Modified"\nSORT file.mtime DESC\nLIMIT 10\n```');
  });
});
