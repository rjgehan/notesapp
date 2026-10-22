// Note header (DESIGN §6.5): inline title (edit = rename), save status and, on desktop, the
// note's ⋯ menu. There are no mode toggles: every note shows in Live Preview, rendered and
// editable (§6.6.1); the ⋯ menu's "Show Markdown source" is the escape hatch for when something
// has gone wrong. On phones only the inline title is shown, because the TopBar already has the
// rest (its ⋯ has the same item); tablets keep the save status here. On desktop the bar also has
// back and forward buttons around a centred breadcrumb, as Obsidian's view header does.
import { ArrowLeft, ArrowRight, Ellipsis } from 'lucide-react';
import type { MouseEvent } from 'react';
import { runCommand } from '../../features/commands';
import { BookmarkToggle } from '../../components/BookmarkToggle';
import { openContextMenu } from '../../components/overlays/openContextMenu';
import { PublishButton } from '../../components/publish/PublishButton';
import { SaveStatus } from '../../components/SaveStatus';
import { useBreakpoint } from '../../components/layout/useBreakpoint';
import { displayName, folderOf } from '../../features/paths';
import { keyHint, useHotkeyOverrides } from '../../features/hotkeyPrefs';
import { keyLabel } from '../../features/platform';
import type { ViewMode } from '../../state/ui';
import type { SessionSnapshot } from '../../sync/DocumentSession';
import { InlineTitle } from './InlineTitle';
import { noteMenuItems } from './noteMenu';

interface Props {
  path: string;
  snapshot: SessionSnapshot | null;
  mode: ViewMode;
  /** The title can be edited (renamed). */
  editable: boolean;
  /** The navigation buttons and the ⋯ menu (false: a Kanban board shows instead of the text, DESIGN §6.8.4). */
  controls?: boolean;
}

function NoteMenuButton({ path, mode }: { path: string; mode: ViewMode }) {
  const open = (e: MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    openContextMenu({ x: r.right - 200, y: r.bottom + 2 }, 'Note actions', noteMenuItems(path, mode));
  };
  return (
    <button type="button" className="icon-button note-menu-button" aria-label="Note actions" title="More" aria-haspopup="menu" onClick={open}>
      <Ellipsis size={17} />
    </button>
  );
}

export function NoteHeader({ path, snapshot, mode, editable, controls = true }: Props) {
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
            {breakpoint === 'desktop' && controls && (
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
            <PublishButton path={path} />
            <BookmarkToggle path={path} />
            {breakpoint === 'desktop' && controls && <NoteMenuButton path={path} mode={mode} />}
          </span>
        </div>
      )}
      <InlineTitle key={path} path={path} editable={editable} />
    </header>
  );
}
