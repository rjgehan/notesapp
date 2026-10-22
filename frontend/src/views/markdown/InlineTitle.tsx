// The inline title above a note (DESIGN §6.15): editing it renames the note, keeping the
// extension. Enter or blur commits, Esc reverts, nothing is sent when the name is unchanged, and
// the new-name rules are checked inline before sending. Enter also moves on to the note's text,
// as in Obsidian, so "New note, title, Enter, type" needs no extra tap.
import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { autoGrow, useAutoGrow } from '../../components/autoGrow';
import { activeEditor } from '../../editor/activeEditor';
import { cancelNoteFocus, requestNoteFocus } from '../../features/focus';
import { nameWithExtension, renameEntry, retitleNewNote, validateNewName } from '../../features/fileOps';
import { currentNoteMode, editNote, isEditingMode } from '../../features/noteMode';
import { titleOf } from '../../features/paths';
import { takeTitleHandoff } from '../../state/pendingNote';
import { toast } from '../../state/toasts';
import { toastError } from '../../features/errors';

/**
 * `onEnter`: where Enter continues in a view without a text editor (the spreadsheet's grid), focused
 * inside the key press; without it, the note's editor.
 */
export function InlineTitle({ path, editable, label = 'Note title', onEnter }: { path: string; editable: boolean; label?: string; onEnter?: () => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const reverting = useRef(false);
  const toText = useRef(false);
  const errorId = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Other files (a spreadsheet) are titled without their extension, which a rename keeps.
  const title = titleOf(path);
  useAutoGrow(ref);
  const error = draft !== null && draft.trim() !== title ? validateNewName(nameWithExtension(path, draft.trim(), 'file')) : null;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // A new note whose title was being typed before it existed continues here with the focus.
    const handoff = takeTitleHandoff(path);
    if (handoff !== null) {
      el.value = handoff.title;
      el.focus();
      el.setSelectionRange(handoff.selectionStart, handoff.selectionEnd);
    }
    autoGrow(el);
  }, [path]);

  const revert = () => {
    const el = ref.current;
    if (el) {
      el.value = title;
      autoGrow(el);
    }
    setDraft(null);
  };

  const commit = async () => {
    const el = ref.current;
    const continueInText = toText.current;
    toText.current = false;
    if (!el || busy) return;
    const value = el.value.trim();
    if (value === '' || value === title) {
      revert();
      if (continueInText && !onEnter) {
        // The editor may not exist yet (the note is still loading): it takes the focus on mount.
        const editor = activeEditor();
        if (editor) editor.focus();
        else requestNoteFocus();
      }
      return;
    }
    const invalid = validateNewName(nameWithExtension(path, value, 'file'));
    if (invalid) {
      toast(invalid, { kind: 'error' });
      revert();
      return;
    }
    setBusy(true);
    // The renamed note's view mounts under its new path and takes the focus.
    if (continueInText) requestNoteFocus();
    try {
      const final = await renameEntry(path, value, 'file');
      setDraft(null);
      // A note just created from a template: its {{title}} follows the name.
      void retitleNewNote(path, final);
    } catch (e) {
      if (continueInText) cancelNoteFocus();
      toastError(e);
      revert();
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      // An invalid name stays in the field with its message.
      if (!error) {
        toText.current = true;
        // Focusing the editor inside the key press keeps the iOS keyboard open; the title's blur
        // then commits. A renamed note's editor remounts and takes the focus again.
        const editor = onEnter ? null : activeEditor();
        const editing = isEditingMode(currentNoteMode());
        if (onEnter) onEnter();
        else if (editor && editing) editor.focus();
        else {
          // No editor to write in: the note is locked, shows the reading view, or is still
          // loading. Writing continues in the editor, which takes the focus when it mounts.
          if (!editing) editNote(path);
          requestNoteFocus();
          e.currentTarget.blur();
        }
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      reverting.current = true;
      revert();
      e.currentTarget.blur();
    }
  };

  return (
    <div className="inline-title-wrap">
      <h1 className="inline-title">
        <textarea
          key={path}
          ref={ref}
          className="inline-title-input"
          defaultValue={title}
          rows={1}
          readOnly={!editable || busy}
          aria-label={label}
          aria-invalid={!!error}
          aria-describedby={error ? errorId : undefined}
          spellCheck={false}
          autoCapitalize="sentences"
          enterKeyHint="done"
          onInput={(e) => {
            autoGrow(e.currentTarget);
            setDraft(e.currentTarget.value);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => {
            if (reverting.current) {
              reverting.current = false;
              return;
            }
            void commit();
          }}
        />
      </h1>
      {error && (
        <p id={errorId} className="field-error inline-title-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
