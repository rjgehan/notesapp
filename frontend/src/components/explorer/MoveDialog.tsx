// "Move to…" (DESIGN §6.15): a folder picker with an editable name, previewed with
// `POST /api/move {dryRun: true}` ("N notes will be updated") before anything moves.
import { Folder, FolderInput, House } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { errorMessage } from '../../api/client';
import { useTree, useVaultSettings } from '../../api/hooks';
import type { MoveResult } from '../../api/types';
import { moveWithUndo, nameWithExtension, previewMove, validateNewName } from '../../features/fileOps';
import { fuzzyRank } from '../../features/fuzzy';
import { basenameOf, displayName, folderOf, isWithin, joinPath, lastSegment } from '../../features/paths';
import { useUi } from '../../state/ui';
import { Modal } from '../overlays/Modal';

const PREVIEW_DEBOUNCE_MS = 250;

type Preview = { key: string } & ({ state: 'loading' } | { state: 'ready'; result: MoveResult } | { state: 'error'; message: string });

const FAILED_REASON: Record<string, string> = {
  'not-utf8': 'not valid UTF-8',
  'not-rewritable': 'a property link that cannot be rewritten',
  'span-mismatch': 'changed meanwhile',
  'io-error': 'storage error',
};

function MoveForm({ path, type, onClose }: { path: string; type: 'file' | 'folder'; onClose(): void }) {
  const tree = useTree().data;
  const settings = useVaultSettings();
  const filterInput = useRef<HTMLInputElement>(null);
  const listId = useId();
  const [filter, setFilter] = useState('');
  const [folder, setFolder] = useState(folderOf(path));
  const [name, setName] = useState(type === 'file' ? basenameOf(path) : lastSegment(path));
  const [updateLinks, setUpdateLinks] = useState(settings.files.autoUpdateLinks);
  const [preview, setPreview] = useState<Preview>({ key: '', state: 'loading' });
  const [moving, setMoving] = useState(false);

  const folders = useMemo(() => {
    const all = ['', ...(tree?.folders.map((f) => f.path) ?? [])].filter((f) => type === 'file' || !isWithin(f, path));
    if (filter.trim() === '') return all;
    return fuzzyRank(filter, all, [(f) => f || '/'], 100).map((r) => r.item);
  }, [tree, filter, type, path]);

  const newName = nameWithExtension(path, name.trim(), type);
  const target = joinPath(folder, newName);
  const nameError = name.trim() === '' ? 'A name is required' : validateNewName(newName);
  const unchanged = target === path;
  const previewKey = `${target}\n${updateLinks}`;

  useLayoutEffect(() => {
    filterInput.current?.focus();
  }, []);

  useEffect(() => {
    if (unchanged || nameError) return;
    let cancelled = false;
    const key = previewKey;
    const timer = setTimeout(() => {
      previewMove(path, target, updateLinks).then(
        (result) => !cancelled && setPreview({ key, state: 'ready', result }),
        (e: unknown) => !cancelled && setPreview({ key, state: 'error', message: errorMessage(e) }),
      );
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [path, target, updateLinks, unchanged, nameError, previewKey]);

  const submit = async () => {
    if (unchanged || nameError || preview.key !== previewKey || preview.state !== 'ready') return;
    setMoving(true);
    const result = await moveWithUndo(path, target, updateLinks);
    setMoving(false);
    if (result) onClose();
  };

  // A preview for another target (or none yet) reads as "checking".
  const shown = unchanged || nameError || preview.key !== previewKey ? null : preview;
  return (
    <form
      className="dialog move-dialog"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h2 className="dialog-title">
        <FolderInput size={18} aria-hidden /> Move “{displayName(path)}”
      </h2>
      <label className="field">
        <span className="field-label">Folder</span>
        <input
          ref={filterInput}
          className="text-input"
          placeholder="Filter folders…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-controls={listId}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
        />
      </label>
      <div id={listId} className="move-folders" role="listbox" aria-label="Destination folder">
        {folders.map((f) => (
          <button
            key={f || '/'}
            type="button"
            role="option"
            aria-selected={f === folder}
            className={`move-folder${f === folder ? ' is-selected' : ''}`}
            onClick={() => setFolder(f)}
          >
            {f === '' ? <House size={15} aria-hidden /> : <Folder size={15} aria-hidden />}
            <span>{f === '' ? 'Vault root' : f}</span>
          </button>
        ))}
        {folders.length === 0 && <div className="panel-empty">No matching folders.</div>}
      </div>
      <label className="field">
        <span className="field-label">Name</span>
        <input className="text-input" value={name} onChange={(e) => setName(e.target.value)} aria-invalid={!!nameError} spellCheck={false} autoCapitalize="off" />
      </label>
      {nameError && <p className="field-error">{nameError}</p>}
      <label className="checkbox-field">
        <input type="checkbox" checked={updateLinks} onChange={(e) => setUpdateLinks(e.target.checked)} />
        Update links to it
      </label>
      <div className="move-preview" aria-live="polite">
        {unchanged ? (
          <span className="muted">Choose another folder or name.</span>
        ) : !shown || shown.state === 'loading' ? (
          <span className="muted">Checking links…</span>
        ) : shown.state === 'error' ? (
          <span className="field-error">{shown.message}</span>
        ) : (
          <>
            <span>
              {shown.result.linkUpdates.length === 0
                ? 'No links need updating.'
                : `${shown.result.linkUpdates.length} ${shown.result.linkUpdates.length === 1 ? 'note' : 'notes'} will be updated.`}
              {shown.result.type === 'folder' && ` ${shown.result.moved.length} ${shown.result.moved.length === 1 ? 'file moves' : 'files move'}.`}
            </span>
            {shown.result.failed.length > 0 && (
              <ul className="move-failed">
                {shown.result.failed.map((f) => (
                  <li key={f.path}>
                    {displayName(f.path)} cannot be updated ({FAILED_REASON[f.reason] ?? f.reason})
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
      <div className="dialog-actions">
        <button type="button" className="button" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="button button-primary" disabled={moving || unchanged || !!nameError || shown?.state !== 'ready'}>
          {moving ? 'Moving…' : 'Move'}
        </button>
      </div>
    </form>
  );
}

export function MoveDialog() {
  const target = useUi((s) => s.moveTarget);
  if (!target) return null;
  const close = () => useUi.getState().setMoveTarget(null);
  return (
    <Modal label="Move to…" onClose={close} className="move-modal">
      <MoveForm key={target.path} path={target.path} type={target.type} onClose={close} />
    </Modal>
  );
}
