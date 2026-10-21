// Recent files pane (ROADMAP item 12, DESIGN §6.23): the files opened on this device, newest
// first, with when they were opened. Files no longer in the vault are left out (a delete through
// the app drops them; renames and moves are followed). The row menu bookmarks a file or removes it
// from the list; the toolbar clears the list.
import { Ellipsis, ExternalLink, FileText, Star, StarOff, Trash2, X } from 'lucide-react';
import { useTree } from '../../api/hooks';
import { isFileBookmarked, toggleFileBookmark, useBookmarks } from '../../features/bookmarkStore';
import { afterOpen, isKeyboardClick } from '../../features/focus';
import { openPath } from '../../features/navigation';
import { isCoarsePointer } from '../../features/platform';
import { displayName, folderOf } from '../../features/paths';
import { formatDateTime, formatRelative } from '../../features/format';
import { clearRecent, presentRecent, removeRecent, useRecentEntries, type RecentEntry } from '../../features/recent';
import { confirmAction } from '../../state/dialogs';
import { viewFor } from '../../views/registry';
import { ContextMenu, type MenuEntry } from '../overlays/ContextMenu';
import { useRowMenu } from './useRowMenu';

export default function RecentPanel({ activePath }: { activePath: string | null }) {
  const tree = useTree().data;
  const entries = presentRecent(useRecentEntries(), tree);
  const { items: bookmarks } = useBookmarks();
  const { menu, close, rowHandlers, swallowClick, openAt } = useRowMenu<RecentEntry>();
  const coarse = isCoarsePointer();

  const open = (path: string, viaKeyboard: boolean) => {
    afterOpen(path, viaKeyboard);
    openPath(path);
  };

  const menuItems = (entry: RecentEntry): MenuEntry[] => {
    const starred = isFileBookmarked(bookmarks, entry.path);
    return [
      { id: 'open', label: 'Open', icon: <ExternalLink size={16} />, run: () => open(entry.path, false) },
      { id: 'bookmark', label: starred ? 'Remove bookmark' : 'Bookmark', icon: starred ? <StarOff size={16} /> : <Star size={16} />, run: () => void toggleFileBookmark(entry.path) },
      'separator',
      { id: 'forget', label: 'Remove from recent files', icon: <X size={16} />, run: () => removeRecent(entry.path) },
    ];
  };

  const clear = async () => {
    const ok = await confirmAction({ title: 'Clear recent files?', message: 'The list of files opened on this device will be emptied. No file is deleted.', confirmLabel: 'Clear' });
    if (ok) clearRecent();
  };

  return (
    <div className="recent">
      <div className="panel-toolbar" role="toolbar" aria-label="Recent files">
        <button type="button" className="icon-button" aria-label="Clear recent files" title="Clear recent files" disabled={entries.length === 0} onClick={() => void clear()}>
          <Trash2 size={16} />
        </button>
      </div>
      {!tree ? (
        <div className="panel-empty">Loading…</div>
      ) : entries.length === 0 ? (
        <div className="panel-empty">No recently opened files on this device.</div>
      ) : (
        <ul className="recent-list" aria-label="Recent files">
          {entries.map((entry) => {
            const file = tree.byPath.get(entry.path);
            const Icon = file ? viewFor(file).icon : FileText;
            const folder = folderOf(entry.path);
            const active = entry.path === activePath;
            const starred = isFileBookmarked(bookmarks, entry.path);
            const when = entry.at ? formatRelative(entry.at) : '';
            return (
              <li key={entry.path} className={`tree-row recent-row${active ? ' is-active' : ''}`} {...rowHandlers(entry)}>
                <button
                  type="button"
                  className="recent-open"
                  title={entry.at ? `${entry.path} · opened ${formatDateTime(entry.at)}` : entry.path}
                  aria-current={active ? 'page' : undefined}
                  onClick={(e) => {
                    if (swallowClick()) return;
                    open(entry.path, isKeyboardClick(e));
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'ContextMenu') {
                      e.preventDefault();
                      openAt(entry, e.currentTarget);
                    } else if (e.key === 'Delete') {
                      e.preventDefault();
                      removeRecent(entry.path);
                    }
                  }}
                >
                  <Icon size={15} className="tree-icon" aria-hidden />
                  <span className="recent-text">
                    <span className="tree-name">{displayName(entry.path)}</span>
                    {folder && <span className="recent-folder">{folder}</span>}
                  </span>
                  {starred && <Star size={12} className="recent-star" aria-label="Bookmarked" />}
                  {when && <span className="recent-when">{when}</span>}
                </button>
                {coarse && (
                  <button
                    type="button"
                    className="icon-button tree-more"
                    tabIndex={-1}
                    aria-label={`Actions for ${displayName(entry.path)}`}
                    title="More actions"
                    onClick={(e) => {
                      e.stopPropagation();
                      openAt(entry, e.currentTarget, true);
                    }}
                  >
                    <Ellipsis size={18} />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} label={`Actions for ${displayName(menu.target.path)}`} items={menuItems(menu.target)} onClose={close} />}
    </div>
  );
}
