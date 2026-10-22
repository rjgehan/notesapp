// Vim mode's lazy chunk (ROADMAP item 36, DESIGN §6.36): `@replit/codemirror-vim` (MIT) plus the
// app's ex commands, its mode indicator and the key order that keeps the app's keys working.
import { closeCompletion, completionStatus } from '@codemirror/autocomplete';
import { Prec, type Extension } from '@codemirror/state';
import { EditorView, ViewPlugin } from '@codemirror/view';
import { CodeMirror, getCM, Vim, vim } from '@replit/codemirror-vim';
import { eventSpec } from '../features/hotkeys';
import { isCustomized, normalizeSpec } from '../features/hotkeyPrefs';
import { clearVimMode, editorCommandKeys, publishVimMode, vimModeLabel } from './vimMode';

/** Runs the editor's own command bound to `id` (`editor.save`), if this editor has one. */
function runCommand(view: EditorView, id: string): boolean {
  const binding = view.state.facet(editorCommandKeys).find((b) => b.id === id);
  return binding ? binding.run(view) : false;
}

/** After the ex prompt closes (it focuses the editor again once the command has run). */
function leaveEditor(view: EditorView): void {
  setTimeout(() => view.contentDOM.blur(), 0);
}

let exCommandsDefined = false;

/**
 * `:w` saves now, `:q` leaves the editor (there are no tabs or panes to close; the note autosaves
 * anyway, so `:q!` discards nothing), `:wq` and `:x` do both. Vim's ex commands are global, so each
 * finds its editor through the CodeMirror adapter.
 */
function defineExCommands(): void {
  if (exCommandsDefined) return;
  exCommandsDefined = true;
  CodeMirror.commands.save = (cm: CodeMirror) => {
    runCommand(cm.cm6, 'editor.save');
  };
  const saveAndLeave = (cm: CodeMirror) => {
    runCommand(cm.cm6, 'editor.save');
    leaveEditor(cm.cm6);
  };
  Vim.defineEx('quit', 'q', (cm) => leaveEditor(cm.cm6));
  Vim.defineEx('wq', 'wq', saveAndLeave);
  Vim.defineEx('xit', 'x', saveAndLeave);
}

/**
 * Runs before vim: the app's editor keys (bold, save, find, …) win over vim's Ctrl keys, as
 * Obsidian's hotkeys do; a key whose command has another key on this device is left to vim.
 * Escape also closes the completion list and arms CodeMirror's tab escape, which vim would
 * otherwise prevent, so `Esc` then `Tab` still leaves the editor.
 */
const appKeysFirst = EditorView.domEventHandlers({
  keydown(event, view) {
    if (event.key === 'Escape') {
      if (completionStatus(view.state) !== null) closeCompletion(view);
      view.setTabFocusMode(2000);
      return false;
    }
    const spec = eventSpec(event);
    if (!spec) return false;
    for (const b of view.state.facet(editorCommandKeys)) {
      if (normalizeSpec(b.key) !== spec || isCustomized(b.id)) continue;
      if (b.run(view)) {
        event.preventDefault();
        return true;
      }
    }
    return false;
  },
});

/** Publishes the editor's mode to the status bar. */
const modeIndicator = ViewPlugin.fromClass(
  class {
    readonly view: EditorView;
    private readonly cm: CodeMirror | null;
    private readonly onModeChange = (e: { mode?: string; subMode?: string }) => publishVimMode(this.view, vimModeLabel(e.mode, e.subMode));

    constructor(view: EditorView) {
      this.view = view;
      this.cm = getCM(view);
      this.cm?.on('vim-mode-change', this.onModeChange);
      publishVimMode(view, this.label());
    }

    label() {
      const state = this.cm?.state.vim as { insertMode?: boolean; visualMode?: boolean; visualLine?: boolean; visualBlock?: boolean } | undefined;
      if (state?.insertMode) return vimModeLabel('insert');
      if (state?.visualMode) return vimModeLabel('visual', state.visualLine ? 'linewise' : state.visualBlock ? 'blockwise' : undefined);
      return vimModeLabel('normal');
    }

    destroy() {
      this.cm?.off('vim-mode-change', this.onModeChange);
      clearVimMode(this.view);
    }
  },
  {
    eventHandlers: {
      // Another editor may have published since: this one is the one being used again.
      focus() {
        publishVimMode(this.view, this.label());
      },
    },
  },
);

export function vimExtension(): Extension {
  defineExCommands();
  // Vim must see keys before CodeMirror's keymaps (its README), and the app's keys before vim.
  return Prec.highest([appKeysFirst, vim(), modeIndicator]);
}
