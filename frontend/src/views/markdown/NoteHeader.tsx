// Note header (DESIGN §6.5): inline title (edit = rename), save status and the mode controls. On
// phones only the inline title is shown, because the TopBar already has the rest; tablets keep the
// save status here and the lock toggle in the TopBar. On desktop the bar also has back and forward
// buttons around a centred breadcrumb, as Obsidian's view header does.
import { ArrowLeft, ArrowRight, BookOpen, CodeXml, Lock, LockOpen, Pencil } from 'lucide-react';
import { runCommand } from '../../features/commands';
import { SaveStatus } from '../../components/SaveStatus';
import { useBreakpoint } from '../../components/layout/useBreakpoint';
import { toggleNoteMode, toggleSourceMode } from '../../features/noteMode';
import { displayName, folderOf } from '../../features/paths';
import { keyLabel } from '../../features/platform';
import type { ViewMode } from '../../state/ui';
import type { SessionSnapshot } from '../../sync/DocumentSession';
import { InlineTitle } from './InlineTitle';

interface Props {
  path: string;
  snapshot: SessionSnapshot | null;
  mode: ViewMode;
  /** The title can be edited (renamed). */
  editable: boolean;
}

/**
 * Mod-E (DESIGN §6.6.1): a note locks and unlocks editing (Live Preview, read-only); the reading view
 * goes back to editing. Views with `edit` and `read` switch between the two.
 */
export function ModeToggle({ mode }: { mode: ViewMode }) {
  const shortcut = keyLabel('Mod-e');
  if (mode === 'read' || mode === 'edit') {
    const next = mode === 'edit' ? 'reading' : 'editing';
    return (
      <button type="button" className="icon-button mode-toggle" onClick={toggleNoteMode} aria-label={`Switch to ${next} view`} title={`Switch to ${next} view (${shortcut})`}>
        {mode === 'edit' ? <BookOpen size={17} /> : <Pencil size={17} />}
      </button>
    );
  }
  const locked = mode === 'locked';
  return (
    <button
      type="button"
      className="icon-button mode-toggle"
      onClick={toggleNoteMode}
      aria-label="Lock editing"
      aria-pressed={locked}
      title={`${locked ? 'Unlock editing' : 'Lock editing'} (${shortcut})`}
    >
      {locked ? <Lock size={17} /> : <LockOpen size={17} />}
    </button>
  );
}

/** Live Preview or the Markdown source of a note. */
export function SourceToggle({ mode }: { mode: ViewMode }) {
  const source = mode === 'source';
  return (
    <button
      type="button"
      className="icon-button source-toggle"
      onClick={toggleSourceMode}
      aria-label="Source mode"
      aria-pressed={source}
      title={source ? 'Show Live Preview' : 'Show the Markdown source'}
    >
      <CodeXml size={17} />
    </button>
  );
}

export function NoteHeader({ path, snapshot, mode, editable }: Props) {
  const breakpoint = useBreakpoint();
  const phone = breakpoint === 'phone';
  const title = displayName(path);
  const folder = folderOf(path);
  return (
    <header className="note-header">
      {!phone && (
        <div className="note-header-bar" data-covers-top>
          <span className="note-header-nav">
            {breakpoint === 'desktop' && (
              <>
                <button type="button" className="icon-button" aria-label="Navigate back" title={`Navigate back (${keyLabel('Mod-Alt-ArrowLeft')})`} onClick={() => runCommand('nav.back', { activePath: path })}>
                  <ArrowLeft size={16} />
                </button>
                <button type="button" className="icon-button" aria-label="Navigate forward" title={`Navigate forward (${keyLabel('Mod-Alt-ArrowRight')})`} onClick={() => runCommand('nav.forward', { activePath: path })}>
                  <ArrowRight size={16} />
                </button>
              </>
            )}
          </span>
          <span className="note-breadcrumb" title={folder ? `${folder}/${title}` : title}>
            {folder && <span className="note-breadcrumb-folder">{folder.split('/').join(' / ')} / </span>}
            <span>{title}</span>
          </span>
          <span className="note-header-actions">
            {snapshot && <SaveStatus snapshot={snapshot} />}
            {breakpoint === 'desktop' && (
              <>
                {mode !== 'read' && <SourceToggle mode={mode} />}
                <ModeToggle mode={mode} />
              </>
            )}
          </span>
        </div>
      )}
      <InlineTitle key={path} path={path} editable={editable} />
    </header>
  );
}
