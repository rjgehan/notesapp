// Registers per-note encryption (ROADMAP item 27, DESIGN §6.33): the `.mdenc` view, its palette
// commands, and the commands for inline encrypted sections in Markdown notes. Only this module is
// in the main bundle with the small format/key modules; the view is a lazy chunk.
import { FileLock, KeyRound, Lock, LockOpen } from 'lucide-react';
import { currentTree } from '../../api/hooks';
import { activeEditor } from '../../editor/activeEditor';
import type { EditorKit } from '../../editor/kit';
import { editorKit, loadEditorKit } from '../../editor/kitHandle';
import { installAutoLock } from '../../features/encryption/autoLock';
import { encryptSelection, insertSection } from '../../features/encryption/inline';
import { isUnlocked, lock } from '../../features/encryption/keyring';
import { isEncryptedNotePath } from '../../features/encryption/meld';
import { createEncryptedNote, encryptExistingNote } from '../../features/encryption/notes';
import { registerCommand } from '../../extensions';
import { toast } from '../../state/toasts';
import { documents } from '../../sync/instance';
import { isMarkdownViewPath, registerView } from '../registry';
import { activeEncrypted } from './active';

function noteSession(path: string | null) {
  if (path === null || !isMarkdownViewPath(path)) return null;
  const session = documents.get(path);
  return session && session.isEditable() ? session : null;
}

export function registerEncryption(): void {
  installAutoLock();

  registerView({
    id: 'encrypted',
    match: (e) => (isEncryptedNotePath(e.path) ? 6 : 0),
    icon: FileLock,
    textual: true,
    modes: ['edit'],
    load: () => import('./EncryptedNoteView'),
    // Ciphertext cannot be merged: a conflict offers Keep mine or Take theirs.
    commands: [
      {
        id: 'encryption.changePassphrase',
        name: 'Encrypted note: Change passphrase…',
        icon: KeyRound,
        when: (c) => activeEncrypted(c.activePath)?.unlocked() ?? false,
        run: (c) => activeEncrypted(c.activePath)?.changePassphrase(),
      },
      {
        id: 'encryption.removeFromNote',
        name: 'Encrypted note: Remove encryption…',
        icon: LockOpen,
        when: (c) => activeEncrypted(c.activePath)?.unlocked() ?? false,
        run: (c) => activeEncrypted(c.activePath)?.removeEncryption(),
      },
    ],
  });

  registerCommand({
    id: 'encryption.newNote',
    name: 'Create new encrypted note',
    icon: FileLock,
    run: (c) => createEncryptedNote(c.activePath),
  });
  registerCommand({
    id: 'encryption.lock',
    name: 'Lock encrypted notes',
    icon: Lock,
    when: () => isUnlocked(),
    run: () => {
      lock();
      toast('Encrypted notes locked');
    },
  });
  registerCommand({
    id: 'encryption.encryptNote',
    name: 'Encrypt this note…',
    icon: FileLock,
    when: (c) => c.activePath !== null && isMarkdownViewPath(c.activePath) && currentTree().byPath.has(c.activePath),
    run: (c) => (c.activePath ? encryptExistingNote(c.activePath) : undefined),
  });
  registerCommand({
    id: 'encryption.insertSection',
    name: 'Insert encrypted text…',
    icon: Lock,
    when: (c) => activeEditor() !== null && noteSession(c.activePath) !== null,
    run: (c) => {
      const view = activeEditor();
      const session = noteSession(c.activePath);
      if (!view || !session) return;
      const { from, to } = view.state.selection.main;
      return insertSection(session, { from, to });
    },
  });
  registerCommand({
    id: 'encryption.encryptSelection',
    name: 'Encrypt selection…',
    icon: Lock,
    when: (c) => {
      const view = activeEditor();
      return view !== null && !view.state.selection.main.empty && noteSession(c.activePath) !== null;
    },
    run: (c) => {
      const view = activeEditor();
      const session = noteSession(c.activePath);
      if (!view || !session) return;
      const { from, to } = view.state.selection.main;
      return encryptSelection(session, { from, to });
    },
  });
  registerCommand({
    id: 'encryption.openSection',
    name: 'Open encrypted text at cursor',
    icon: LockOpen,
    when: (c) => activeEditor() !== null && noteSession(c.activePath) !== null,
    run: () => {
      const view = activeEditor();
      if (!view) return;
      // With an editor, its code (the kit) is loaded: the dialog opens inside this gesture.
      const open = (kit: EditorKit) => {
        if (!kit.openSectionIn(view, view.state.selection.main.head)) toast('There is no encrypted text at the cursor');
      };
      const kit = editorKit();
      if (kit) open(kit);
      else void loadEditorKit().then(open);
    },
  });
}
