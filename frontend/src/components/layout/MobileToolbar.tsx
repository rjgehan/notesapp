// Editing toolbar for touch devices (DESIGN §6.16): the shell's last grid row, so it sits right
// above the on-screen keyboard. It is always mounted, and a class shows it from a debounced
// "editor focused or toolbar in use" state: unmounting it on blur would remove a button before
// its click arrives. Buttons never take focus (tabIndex -1, pointerdown default prevented), so
// the editor keeps the focus and the keyboard stays open while they dispatch to the EditorView.
import { indentLess, indentMore, redo, undo } from '@codemirror/commands';
import type { EditorView } from '@codemirror/view';
import { Brackets, Code, Command as CommandIcon, Hash, ImagePlus, KeyboardOff, ListIndentDecrease, ListIndentIncrease, Mic, Minus, Redo2, SquareArrowOutUpRight, SquareCheck, Undo2, type LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { activeEditor } from '../../editor/activeEditor';
import { insertWikilink } from '../../editor/completion';
import { noteContext } from '../../editor/context';
import { followLinkAtCursor, insertHorizontalRule, insertTagSign, toggleCheckbox, toggleInlineCode } from '../../editor/editorCommands';
import { revealCaret } from '../../editor/mobileViewport';
import { startVoiceNote } from '../../features/voice/voiceNotes';
import { pickAndInsertAttachments } from '../../features/attachments';
import { runCommand } from '../../features/commands';
import { activePath } from '../../features/navigation';
import { toast } from '../../state/toasts';
import { documents } from '../../sync/instance';

const HIDE_DELAY_MS = 150;

interface Tool {
  id: string;
  label: string;
  icon: LucideIcon;
  /** Only for Markdown notes (the plain-text editor gets the generic tools). */
  markdown?: boolean;
  run(view: EditorView): void;
}

const TOOLS: Tool[] = [
  { id: 'wikilink', label: 'Insert internal link', icon: Brackets, markdown: true, run: (v) => insertWikilink(v) },
  { id: 'tag', label: 'Insert tag', icon: Hash, markdown: true, run: (v) => insertTagSign(v) },
  { id: 'checkbox', label: 'Toggle checklist', icon: SquareCheck, markdown: true, run: (v) => toggleCheckbox(v) },
  { id: 'code', label: 'Inline code', icon: Code, markdown: true, run: (v) => toggleInlineCode(v) },
  { id: 'rule', label: 'Horizontal rule', icon: Minus, markdown: true, run: (v) => insertHorizontalRule(v) },
  { id: 'outdent', label: 'Outdent', icon: ListIndentDecrease, run: (v) => indentLess(v) },
  { id: 'indent', label: 'Indent', icon: ListIndentIncrease, run: (v) => indentMore(v) },
  { id: 'undo', label: 'Undo', icon: Undo2, run: (v) => undo(v) },
  { id: 'redo', label: 'Redo', icon: Redo2, run: (v) => redo(v) },
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
    run: (v) => {
      // The picker blurs the editor; the session remembers where to insert before it opens.
      const ctx = v.state.facet(noteContext);
      const session = ctx ? documents.get(ctx.path()) : undefined;
      if (session) pickAndInsertAttachments(session, 'image/*');
    },
  },
  {
    id: 'voice',
    label: 'Record voice note',
    icon: Mic,
    markdown: true,
    run: (v) => {
      const ctx = v.state.facet(noteContext);
      const session = ctx ? documents.get(ctx.path()) : undefined;
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
  const inUse = useRef(false);
  const update = useRef<() => void>(() => {});

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const evaluate = () => {
      const view = focusedEditor();
      if (view) setMarkdown(view.state.facet(noteContext) !== null);
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
        {TOOLS.filter((t) => markdown || !t.markdown).map((tool) => {
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
