// Editing toolbar for touch devices (DESIGN §6.16): the shell's last grid row, so it sits right
// above the on-screen keyboard. It is always mounted, and a class shows it from a debounced
// "editor focused or toolbar in use" state: unmounting it on blur would remove a button before
// its click arrives. Buttons never take focus (tabIndex -1, pointerdown default prevented), so
// the editor keeps the focus and the keyboard stays open while they dispatch to the EditorView.
// It has the formatting tools of Live Preview (DESIGN §6.6.1): bold, italic, heading, list,
// checkbox, link and table. In a table cell being edited it offers Previous and Next cell instead
// of the tools that change whole lines.
import { indentLess, indentMore, redo, undo } from '@codemirror/commands';
import type { EditorView } from '@codemirror/view';
import {
  ArrowLeftToLine,
  ArrowRightToLine,
  Bold,
  Brackets,
  Code,
  Command as CommandIcon,
  Hash,
  Heading,
  ImagePlus,
  Italic,
  KeyboardOff,
  Link,
  List,
  ListIndentDecrease,
  ListIndentIncrease,
  Mic,
  Minus,
  Redo2,
  SquareArrowOutUpRight,
  Slash,
  SquareCheck,
  Table,
  Undo2,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { activeEditor } from '../../editor/activeEditor';
import { insertWikilink } from '../../editor/completion';
import { noteContext } from '../../editor/context';
import { followLinkAtCursor, insertHorizontalRule, insertTagSign, toggleCheckbox } from '../../editor/editorCommands';
import { cycleHeading, toggleBold, toggleBulletList, toggleInlineCode, toggleItalic, toggleLink } from '../../editor/formatting';
import { historyEditor, insertTable, isTableCell, moveToCell } from '../../editor/livePreview/table';
import { revealCaret } from '../../editor/revealCaret';
import { openSlashMenu } from '../../editor/slash';
import { pickAndInsertImages } from '../../features/editorInsertions';
import { startVoiceNote } from '../../features/voice/voiceNotes';
import { runCommand } from '../../features/commands';
import { activePath } from '../../features/navigation';
import { isNotePath } from '../../features/paths';
import { toast } from '../../state/toasts';
import { documents } from '../../sync/instance';

const HIDE_DELAY_MS = 150;

interface Tool {
  id: string;
  label: string;
  icon: LucideIcon;
  /** Only for Markdown notes (the plain-text editor gets the generic tools). */
  markdown?: boolean;
  /** Changes whole lines: not in a table cell. */
  lines?: boolean;
  /** Only in a table cell. */
  cell?: boolean;
  run(view: EditorView): void;
}

const TOOLS: Tool[] = [
  // The `/` menu (DESIGN §6.6.2), docked above the keyboard.
  { id: 'insert', label: 'Insert…', icon: Slash, markdown: true, run: (v) => openSlashMenu(v) },
  { id: 'wikilink', label: 'Insert internal link', icon: Brackets, markdown: true, run: (v) => insertWikilink(v) },
  { id: 'tag', label: 'Insert tag', icon: Hash, markdown: true, run: (v) => insertTagSign(v) },
  { id: 'cell-previous', label: 'Previous cell', icon: ArrowLeftToLine, cell: true, run: (v) => moveToCell(v, -1) },
  { id: 'cell-next', label: 'Next cell', icon: ArrowRightToLine, cell: true, run: (v) => moveToCell(v, 1) },
  { id: 'bold', label: 'Bold', icon: Bold, markdown: true, run: (v) => toggleBold(v) },
  { id: 'italic', label: 'Italic', icon: Italic, markdown: true, run: (v) => toggleItalic(v) },
  // Each tap goes one step: text, heading 1, 2, 3, text.
  { id: 'heading', label: 'Heading', icon: Heading, markdown: true, lines: true, run: (v) => cycleHeading(v) },
  { id: 'list', label: 'Bulleted list', icon: List, markdown: true, lines: true, run: (v) => toggleBulletList(v) },
  { id: 'checkbox', label: 'Toggle checklist', icon: SquareCheck, markdown: true, lines: true, run: (v) => toggleCheckbox(v) },
  { id: 'link', label: 'Link', icon: Link, markdown: true, run: (v) => toggleLink(v) },
  { id: 'table', label: 'Insert table', icon: Table, markdown: true, lines: true, run: (v) => insertTable(v) },
  { id: 'code', label: 'Inline code', icon: Code, markdown: true, run: (v) => toggleInlineCode(v) },
  { id: 'rule', label: 'Horizontal rule', icon: Minus, markdown: true, lines: true, run: (v) => insertHorizontalRule(v) },
  { id: 'outdent', label: 'Outdent', icon: ListIndentDecrease, lines: true, run: (v) => indentLess(v) },
  { id: 'indent', label: 'Indent', icon: ListIndentIncrease, lines: true, run: (v) => indentMore(v) },
  // A cell's undo history is its note's.
  { id: 'undo', label: 'Undo', icon: Undo2, run: (v) => undo(historyEditor(v)) },
  { id: 'redo', label: 'Redo', icon: Redo2, run: (v) => redo(historyEditor(v)) },
  {
    id: 'follow',
    label: 'Follow link',
    icon: SquareArrowOutUpRight,
    markdown: true,
    run: (v) => {
      if (!followLinkAtCursor(v)) toast('Place the cursor on a link or tag to follow it');
    },
  },
  { id: 'palette', label: 'Command palette', icon: CommandIcon, run: () => runCommand('app.commandPalette', { activePath: activePath() }) },
  {
    id: 'image',
    label: 'Insert image',
    icon: ImagePlus,
    markdown: true,
    lines: true,
    // The picker blurs the editor; the session remembers where to insert before it opens.
    run: (v) => pickAndInsertImages(v),
  },
  {
    id: 'voice',
    label: 'Record voice note',
    icon: Mic,
    markdown: true,
    lines: true,
    run: (v) => {
      const ctx = v.state.facet(noteContext);
      // Only into a note: a canvas card editor has no note session of its own.
      const session = ctx && isNotePath(ctx.path()) ? documents.get(ctx.path()) : undefined;
      if (!session) return;
      // The session remembers the cursor; the keyboard goes, so the recording panel has the room.
      startVoiceNote(session);
      v.contentDOM.blur();
    },
  },
  { id: 'hide', label: 'Hide keyboard', icon: KeyboardOff, run: (v) => v.contentDOM.blur() },
];

/** The editor the toolbar works on: the note editor, when it has focus and can be edited. */
function focusedEditor(): EditorView | null {
  const view = activeEditor();
  return view && view.hasFocus && !view.state.readOnly ? view : null;
}

export function MobileToolbar() {
  const [visible, setVisible] = useState(false);
  const [markdown, setMarkdown] = useState(true);
  const [cell, setCell] = useState(false);
  const inUse = useRef(false);
  const update = useRef<() => void>(() => {});

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const evaluate = () => {
      const view = focusedEditor();
      if (view) {
        setMarkdown(view.state.facet(noteContext) !== null);
        setCell(isTableCell(view));
      }
      return view !== null || inUse.current;
    };
    // Shown at once; hidden only once the state has stayed false for a moment, so focus moving
    // between the editor and a toolbar-opened control does not make it flicker.
    update.current = () => {
      clearTimeout(timer);
      if (evaluate()) setVisible(true);
      else timer = setTimeout(() => setVisible(evaluate()), HIDE_DELAY_MS);
    };
    const onFocusChange = () => update.current();
    document.addEventListener('focusin', onFocusChange);
    document.addEventListener('focusout', onFocusChange);
    // The toolbar loads after the shell (a lazy chunk): an editor may have the focus already.
    if (focusedEditor()) update.current();
    return () => {
      clearTimeout(timer);
      document.removeEventListener('focusin', onFocusChange);
      document.removeEventListener('focusout', onFocusChange);
    };
  }, []);

  // Showing the toolbar shortens the workspace; keep the caret above it.
  useEffect(() => {
    if (visible) revealCaret();
  }, [visible]);

  const setInUse = (value: boolean) => {
    inUse.current = value;
    update.current();
  };

  return (
    <div className={`mobile-toolbar${visible ? ' is-visible' : ''}`} role="toolbar" aria-label="Editing tools" aria-hidden={!visible}>
      <div className="mobile-toolbar-scroll" onPointerDown={() => setInUse(true)} onPointerUp={() => setInUse(false)} onPointerCancel={() => setInUse(false)}>
        {TOOLS.filter((t) => (markdown || !t.markdown) && (cell ? !t.lines : !t.cell)).map((tool) => {
          const Icon = tool.icon;
          return (
            <button
              key={tool.id}
              type="button"
              className="mobile-toolbar-button"
              tabIndex={-1}
              aria-label={tool.label}
              title={tool.label}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => {
                const view = activeEditor();
                if (view) tool.run(view);
              }}
            >
              <Icon size={20} aria-hidden />
            </button>
          );
        })}
      </div>
    </div>
  );
}
