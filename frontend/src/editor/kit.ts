// The editor's code that the always-loaded app code runs: the palette's editor commands
// (extensions/builtins.ts, views/encrypted/register.ts) and the shell's (the caret kept above the
// keyboard). Part of the editor's chunk, not the main one: every editor (NoteEditor, a canvas
// card's editor) imports this module, so by the time there is an editor to run a command on, the
// kit is here and the command runs synchronously, inside the key press or tap (DESIGN §6.13).
import { copyLineDown, moveLineDown, moveLineUp } from '@codemirror/commands';
import { openSearchPanel } from '@codemirror/search';
import { promptRenameHeading } from '../features/headingRename';
import { insertWikilink } from './completion';
import { followLinkAtCursor, toggleCheckbox } from './editorCommands';
import { openSectionIn } from './encryptedSections';
import {
  setHeading,
  toggleBold,
  toggleBulletList,
  toggleHeading,
  toggleHighlight,
  toggleInlineCode,
  toggleItalic,
  toggleLink,
  toggleNumberedList,
  toggleQuote,
  toggleStrikethrough,
} from './formatting';
import { foldAllHeadings, foldHeading, unfoldAllHeadings, unfoldHeading } from './headingFold';
import { provideEditorKit } from './kitHandle';
import { renumberList } from './listRenumber';
import { insertTable } from './livePreview/table';
import { headingsFromState } from './outline';
import { revealCaret } from './revealCaret';
import { openSlashMenu } from './slash';
import { insertBlock } from './slashItems';

export const editorKit = {
  insertWikilink,
  followLinkAtCursor,
  toggleCheckbox,
  setHeading,
  toggleBold,
  toggleBulletList,
  toggleHeading,
  toggleHighlight,
  toggleInlineCode,
  toggleItalic,
  toggleLink,
  toggleNumberedList,
  toggleQuote,
  toggleStrikethrough,
  foldAllHeadings,
  foldHeading,
  unfoldAllHeadings,
  unfoldHeading,
  renumberList,
  insertTable,
  openSlashMenu,
  insertBlock,
  openSearchPanel,
  moveLineUp,
  moveLineDown,
  copyLineDown,
  headingsFromState,
  promptRenameHeading,
  openSectionIn,
  revealCaret,
};

export type EditorKit = typeof editorKit;

provideEditorKit(editorKit);
