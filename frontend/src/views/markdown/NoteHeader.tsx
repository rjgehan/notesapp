// Note header (DESIGN §6.5): inline title (edit = rename), save status and the mode toggle. On
// phones only the inline title is shown, because the TopBar already has the rest; tablets keep the
// save status here and the mode toggle in the TopBar. On desktop the bar also has back and forward
// buttons around a centred breadcrumb, as Obsidian's view header does.
import { ArrowLeft, ArrowRight, BookOpen, Pencil } from 'lucide-react';
import { runCommand } from '../../features/commands';
import { BookmarkToggle } from '../../components/BookmarkToggle';
import { SaveStatus } from '../../components/SaveStatus';
import { useBreakpoint } from '../../components/layout/useBreakpoint';
import { displayName, folderOf } from '../../features/paths';
import { keyHint, useHotkeyOverrides } from '../../features/hotkeyPrefs';
import { keyLabel } from '../../features/platform';
import type { NoteMode } from '../../state/ui';
import type { SessionSnapshot } from '../../sync/DocumentSession';
import { InlineTitle } from './InlineTitle';

interface Props {
  path: string;
  snapshot: SessionSnapshot | null;
  mode: NoteMode;
  modes: NoteMode[];
  onToggleMode(): void;
  /** The title can be edited (renamed). */
  editable: boolean;
}

export function ModeToggle({ mode, onToggle }: { mode: NoteMode; onToggle(): void }) {
  useHotkeyOverrides();
  const next = mode === 'edit' ? 'reading' : 'editing';
  return (
    <button
      type="button"
      className="icon-button mode-toggle"
      onClick={onToggle}
      aria-label={`Switch to ${next} view`}
      title={`Switch to ${next} view${keyHint('editor.toggleMode', keyLabel)}`}
    >
      {mode === 'edit' ? <BookOpen size={17} /> : <Pencil size={17} />}
    </button>
  );
}

export function NoteHeader({ path, snapshot, mode, modes, onToggleMode, editable }: Props) {
  useHotkeyOverrides();
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
                <button type="button" className="icon-button" aria-label="Navigate back" title={`Navigate back${keyHint('nav.back', keyLabel)}`} onClick={() => runCommand('nav.back', { activePath: path })}>
                  <ArrowLeft size={16} />
                </button>
                <button type="button" className="icon-button" aria-label="Navigate forward" title={`Navigate forward${keyHint('nav.forward', keyLabel)}`} onClick={() => runCommand('nav.forward', { activePath: path })}>
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
            <BookmarkToggle path={path} />
            {modes.length > 1 && breakpoint === 'desktop' && <ModeToggle mode={mode} onToggle={onToggleMode} />}
          </span>
        </div>
      )}
      <InlineTitle key={path} path={path} editable={editable} />
    </header>
  );
}
