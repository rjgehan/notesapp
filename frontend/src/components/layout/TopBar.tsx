// Phone and tablet top bar (DESIGN §6.16): ☰, the note title with the connection dot,
// switcher/search, mode toggle and ⋯ (palette, panels, file actions, template, today, reload).
// On tablets it also toggles the right sidebar overlay.
import { CalendarDays, CloudUpload, Command as CommandIcon, Ellipsis, FileSearch, FolderInput, History, LayoutTemplate, Link2, ListTree, Menu, Moon, PanelRight, Pencil, Plus, RefreshCw, Star, StarOff, Sun, Trash, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { matchPath, useLocation } from 'react-router';
import { useTree } from '../../api/hooks';
import { pageRoute, registeredPages, useExtensionsVersion } from '../../extensions';
import { isFileBookmarked, toggleFileBookmark, useBookmarks } from '../../features/bookmarkStore';
import { getCommand, runCommand, useCommandsVersion } from '../../features/commands';
import { mirrorMisconfigured, pushMirrorNow } from '../../features/mirror';
import { setNoteMode, useNoteMode } from '../../features/noteMode';
import { navigateOverOverlays, useOverlayHistory } from '../../features/overlayHistory';
import { displayName, pathFromLocation } from '../../features/paths';
import { usePendingNote } from '../../state/pendingNote';
import { resolvedTheme, toggleTheme, usePrefs } from '../../state/prefs';
import { useUi } from '../../state/ui';
import { useDocumentSession, useSessionSnapshot } from '../../sync/useTextDocument';
import { ModeToggle } from '../../views/markdown/NoteHeader';
import { isMarkdownViewPath, viewFor } from '../../views/registry';
import { ConnectionIndicator } from '../ConnectionIndicator';
import { SaveStatus } from '../SaveStatus';
import { showPanel } from './showPanel';
import { useBreakpoint } from './useBreakpoint';
import { useHistoryWarning } from './useHistoryWarning';
import { useMirrorWarning } from './useMirrorWarning';

function MoreMenu({ path, onClose }: { path: string | null; onClose(): void }) {
  usePrefs((s) => s.theme);
  const ref = useRef<HTMLDivElement>(null);
  const historyWarning = useHistoryWarning();
  const mirrorWarning = useMirrorWarning();
  const entry = useTree().data?.byPath.get(path ?? '');
  const hasFile = !!entry;
  const starred = isFileBookmarked(useBookmarks().items, path ?? '');
  useOverlayHistory(true, onClose);
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node) && !(e.target as HTMLElement).closest?.('.menu-anchor')) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);
  const item = (label: string, icon: ReactNode, run: () => void) => (
    <button
      key={label}
      type="button"
      role="menuitem"
      className="menu-item"
      onClick={() => {
        onClose();
        run();
      }}
    >
      {icon}
      {label}
    </button>
  );
  const command = (id: string, label: string, icon: ReactNode) => (getCommand(id) ? item(label, icon, () => runCommand(id, { activePath: path })) : null);
  const dark = resolvedTheme() === 'dark';
  // Notes shown by another view (an `.excalidraw.md` drawing) have no outline or template target.
  const note = !!entry && isMarkdownViewPath(entry.path);
  return (
    <div ref={ref} className="menu" role="menu" aria-label="More">
      {historyWarning && (
        <div className="menu-warning" role="note">
          <TriangleAlert size={14} aria-hidden /> {historyWarning}
        </div>
      )}
      {mirrorWarning && (
        <div className="menu-warning" role="note" title={mirrorWarning.mirror.lastError ?? undefined}>
          <TriangleAlert size={14} aria-hidden /> {mirrorWarning.text}
        </div>
      )}
      {mirrorWarning && !mirrorMisconfigured(mirrorWarning.mirror) && item('Push to mirror now', <CloudUpload size={16} />, () => void pushMirrorNow())}
      {command('app.commandPalette', 'Command palette', <CommandIcon size={16} />)}
      {hasFile && item('Backlinks', <Link2 size={16} />, () => showPanel('right', 'backlinks'))}
      {note && item('Outline', <ListTree size={16} />, () => showPanel('right', 'outline'))}
      {hasFile && item('History', <History size={16} />, () => showPanel('right', 'history'))}
      {hasFile && <div className="menu-separator" role="separator" />}
      {hasFile && path !== null && item(starred ? 'Remove bookmark' : 'Bookmark', starred ? <StarOff size={16} /> : <Star size={16} />, () => void toggleFileBookmark(path))}
      {hasFile && command('file.rename', 'Rename', <Pencil size={16} />)}
      {hasFile && command('file.move', 'Move to…', <FolderInput size={16} />)}
      {hasFile && command('file.delete', 'Delete', <Trash size={16} />)}
      {note && command('templates.insert', 'Insert template', <LayoutTemplate size={16} />)}
      {command('daily.today', 'Today', <CalendarDays size={16} />)}
      <div className="menu-separator" role="separator" />
      {item(dark ? 'Light theme' : 'Dark theme', dark ? <Sun size={16} /> : <Moon size={16} />, toggleTheme)}
      {item('Reload', <RefreshCw size={16} />, () => navigateOverOverlays(() => window.location.reload()))}
    </div>
  );
}

/** The open document's save state, compact (phones show it here instead of in the note header). */
function TopBarSaveStatus({ path }: { path: string }) {
  const session = useDocumentSession(path);
  const snapshot = useSessionSnapshot(session);
  return <SaveStatus snapshot={snapshot} compact />;
}

export function TopBar() {
  useCommandsVersion();
  useExtensionsVersion();
  const location = useLocation();
  const path = pathFromLocation(location.pathname);
  const entry = useTree().data?.byPath.get(path ?? '');
  const mode = useNoteMode();
  const pending = usePendingNote((s) => s.pending);
  const setDrawerOpen = useUi((s) => s.setDrawerOpen);
  const sheetOpen = useUi((s) => s.sheetOpen);
  const setSheetOpen = useUi((s) => s.setSheetOpen);
  const [menuOpen, setMenuOpen] = useState(false);
  const closeMenu = useCallback(() => setMenuOpen(false), [setMenuOpen]);
  const descriptor = entry && !pending ? viewFor(entry) : null;
  const phone = useBreakpoint() === 'phone';
  const page = location.pathname.startsWith('/x/') ? registeredPages().find((p) => matchPath(pageRoute(p), location.pathname)) : undefined;
  const title = pending
    ? pending.title || `New ${pending.label}`
    : path
      ? displayName(path)
      : location.pathname.startsWith('/settings')
        ? 'Settings'
        : location.pathname === '/trash'
          ? 'Trash'
          : location.pathname === '/search'
            ? 'Search'
            : (page?.title ?? 'Notes');

  return (
    <header className="top-bar">
      <button type="button" className="icon-button" aria-label="Open sidebar" title="Open sidebar" onClick={() => setDrawerOpen(true)}>
        <Menu size={20} />
      </button>
      <div className="top-bar-title">
        <ConnectionIndicator compact />
        <span className="top-bar-name">{title}</span>
      </div>
      {phone && path && descriptor?.textual && <TopBarSaveStatus key={path} path={path} />}
      {phone && getCommand('capture.quick') && (
        <button type="button" className="icon-button" aria-label="Quick capture" title="Quick capture" onClick={() => runCommand('capture.quick', { activePath: path })}>
          <Plus size={20} />
        </button>
      )}
      {getCommand('app.quickSwitcher') && (
        <button type="button" className="icon-button" aria-label="Quick switcher" title="Quick switcher" onClick={() => runCommand('app.quickSwitcher', { activePath: path })}>
          <FileSearch size={20} />
        </button>
      )}
      {descriptor && descriptor.modes.length > 1 && <ModeToggle mode={mode} onToggle={() => setNoteMode(mode === 'edit' ? 'read' : 'edit')} />}
      {!phone && path && (
        <button type="button" className="icon-button" aria-label="Toggle right sidebar" title="Toggle right sidebar" aria-expanded={sheetOpen} onClick={() => setSheetOpen(!sheetOpen)}>
          <PanelRight size={20} />
        </button>
      )}
      <div className="menu-anchor">
        <button type="button" className="icon-button" aria-label="More" title="More" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>
          <Ellipsis size={20} />
        </button>
        {menuOpen && <MoreMenu path={path} onClose={closeMenu} />}
      </div>
    </header>
  );
}
