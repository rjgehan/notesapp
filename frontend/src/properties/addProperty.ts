// "Add property" (Mod-;, ROADMAP item 13, DESIGN §6.41): loaded with the command, not at startup,
// since it needs the editor's Live Preview code (./register.ts is always loaded).
import { EditorSelection } from '@codemirror/state';
import { activeEditor } from '../editor/activeEditor';
import { editingProperties, editProperties, hasPropertiesBlock } from '../editor/livePreview/blocks';
import { splitFrontmatter } from '../features/frontmatter';
import { toast } from '../state/toasts';
import { addRequests } from './requests';

/** "Add property": opens the new-property row of the open note, creating its frontmatter if it has none. */
export function addPropertyToActiveNote(path: string): void {
  const view = activeEditor();
  if (!view || view.state.readOnly) {
    toast('Open the note for editing to add a property');
    return;
  }
  const text = view.state.doc.toString();
  const split = splitFrontmatter(text);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  if (hasPropertiesBlock(view.state)) {
    if (split.yaml === null) view.dispatch({ changes: { from: 0, insert: `---${eol}---${eol}` }, userEvent: 'properties.edit' });
    // Properties shown as YAML text go back to the editor, whose new-property row opens.
    else if (editingProperties(view.state)) view.dispatch({ effects: editProperties.of(false) });
    addRequests.request(path, view.dom);
    return;
  }
  // Source mode: the caret goes on a new line at the end of the frontmatter.
  if (split.yaml === null) {
    view.dispatch({ changes: { from: 0, insert: `---${eol}${eol}---${eol}` }, selection: EditorSelection.cursor(4 + eol.length - 1), scrollIntoView: true, userEvent: 'input' });
  } else {
    const yamlEnd = text.indexOf('\n') + 1 + split.yaml.length;
    view.dispatch({ changes: { from: yamlEnd, insert: eol }, selection: EditorSelection.cursor(yamlEnd), scrollIntoView: true, userEvent: 'input' });
  }
  view.focus();
}
