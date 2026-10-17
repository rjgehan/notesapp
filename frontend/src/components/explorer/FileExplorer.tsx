// File explorer (DESIGN §6.15): ARIA tree with roving tabindex over virtualized rows, row menus
// (right-click; ⋯ and long-press on touch), inline rename, drag and drop to move (desktop), and
// OS files dropped on a folder.
import { ArrowDownAZ, ChevronRight, ChevronsDownUp, ClockArrowDown, Ellipsis, FilePlus, Folder, FolderOpen, FolderPlus } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { useLocation } from 'react-router';
import { useTree } from '../../api/hooks';
import { EXPLORER_DRAG_EFFECTS, INTERNAL_PATH_TYPE } from '../../editor/pasteAndDrop';
import { uploadToFolder } from '../../features/attachments';
import { createNote, moveWithUndo, renameEntry, validateNewName, nameWithExtension } from '../../features/fileOps';
import { afterOpen } from '../../features/focus';
import { openPath } from '../../features/navigation';
import { isCoarsePointer, modKey } from '../../features/platform';
import { basenameOf, folderOf, isWithin, joinPath, lastSegment, pathFromLocation } from '../../features/paths';
import { toast } from '../../state/toasts';
import { useUi } from '../../state/ui';
import { viewFor } from '../../views/registry';
import { ContextMenu } from '../overlays/ContextMenu';
import { VirtualList, type VirtualListHandle } from '../VirtualList';
import { useBreakpoint } from '../layout/useBreakpoint';
import { confirmDelete, promptNewFolder, rowFolder, rowMenuItems } from './rowActions';
import { flattenRows, folderChildren, type ExplorerRow } from './tree';
import { toastError } from '../../features/errors';

const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP = 8;

interface MenuState {
  row: ExplorerRow;
  x: number;
  y: number;
}

/** Inline rename field of a row: Enter or blur commits, Esc reverts. */
function RenameField({ row, onDone }: { row: ExplorerRow; onDone(): void }) {
  const input = useRef<HTMLInputElement>(null);
  const initial = row.kind === 'file' ? basenameOf(row.path) : lastSegment(row.path);
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const error = value.trim() === '' || value.trim() === initial ? null : validateNewName(nameWithExtension(row.path, value.trim(), row.kind));

  useLayoutEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  const finish = async (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    onDone();
    const name = value.trim();
    if (!commit || name === '' || name === initial) return;
    if (error) {
      toast(error, { kind: 'error' });
      return;
    }
    try {
      await renameEntry(row.path, name, row.kind);
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <input
      ref={input}
      className="tree-rename"
      value={value}
      aria-label={`Rename ${initial}`}
      aria-invalid={!!error}
      title={error ?? undefined}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
          e.preventDefault();
          if (!error) void finish(true);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          void finish(false);
        }
      }}
      onBlur={() => void finish(true)}
      spellCheck={false}
      autoCapitalize="off"
      enterKeyHint="done"
    />
  );
}

export function FileExplorer() {
  const tree = useTree();
  const expanded = useUi((s) => s.expanded);
  const setExpanded = useUi((s) => s.setExpanded);
  const sort = useUi((s) => s.explorerSort);
  const setSort = useUi((s) => s.setExplorerSort);
  const revealPath = useUi((s) => s.revealPath);
  const setRevealPath = useUi((s) => s.setRevealPath);
  const breakpoint = useBreakpoint();
  const activePath = pathFromLocation(useLocation().pathname);
  const list = useRef<VirtualListHandle>(null);
  const [localFocus, setLocalFocus] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const longPress = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number; fired: boolean } | null>(null);
  // "Reveal current file" selects a row until the user moves the focus themselves.
  const focused = revealPath ?? localFocus;
  const setFocused = (path: string | null) => {
    if (revealPath) setRevealPath(null);
    setLocalFocus(path);
  };
  const focusPending = useRef(false);

  const coarse = isCoarsePointer();
  const rowHeight = breakpoint === 'desktop' && !coarse ? 28 : 44;
  const children = useMemo(() => (tree.data ? folderChildren(tree.data) : null), [tree.data]);
  const rows = useMemo(() => (children ? flattenRows(children, expanded, sort) : []), [children, expanded, sort]);
  const indexOf = useMemo(() => new Map(rows.map((r, i) => [r.path, i])), [rows]);

  const focusedIndex = focused !== null ? (indexOf.get(focused) ?? -1) : -1;
  const tabStop = focusedIndex >= 0 ? focusedIndex : activePath !== null ? (indexOf.get(activePath) ?? 0) : 0;

  useEffect(() => {
    if (focusedIndex >= 0) list.current?.scrollToIndex(focusedIndex);
  }, [focusedIndex]);

  // Move DOM focus once the focused row is rendered (it may have been virtualized away).
  useEffect(() => {
    if (!focusPending.current || focused === null) return;
    const el = list.current?.element()?.querySelector<HTMLElement>(`[data-path="${CSS.escape(focused)}"]`);
    if (el) {
      el.focus();
      focusPending.current = false;
    }
  });

  const moveFocus = (index: number) => {
    const row = rows[Math.max(0, Math.min(rows.length - 1, index))];
    if (!row) return;
    focusPending.current = true;
    setFocused(row.path);
  };

  const activate = (row: ExplorerRow, viaKeyboard: boolean) => {
    if (row.kind === 'folder') setExpanded(row.path, !row.expanded);
    else {
      afterOpen(row.path, viaKeyboard);
      openPath(row.path);
    }
  };

  const startRename = (row: ExplorerRow) => {
    setFocused(row.path);
    setRenaming(row.path);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (renaming) return;
    const index = focusedIndex >= 0 ? focusedIndex : tabStop;
    const row = rows[index];
    if (!row) return;
    if (modKey(e) && e.altKey && e.code === 'KeyN') {
      createNote(rowFolder(row));
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    switch (e.key) {
      case 'ArrowDown':
        moveFocus(index + 1);
        break;
      case 'ArrowUp':
        moveFocus(index - 1);
        break;
      case 'Home':
        moveFocus(0);
        break;
      case 'End':
        moveFocus(rows.length - 1);
        break;
      case 'ArrowRight':
        if (row.kind === 'folder' && !row.expanded) setExpanded(row.path, true);
        else if (row.kind === 'folder') moveFocus(index + 1);
        break;
      case 'ArrowLeft':
        if (row.kind === 'folder' && row.expanded) setExpanded(row.path, false);
        else if (row.parent >= 0) moveFocus(row.parent);
        break;
      case 'Enter':
      case ' ':
        activate(row, true);
        break;
      case 'F2':
        startRename(row);
        break;
      case 'Delete':
        void confirmDelete(row.path, row.kind);
        break;
      case 'ContextMenu': {
        const el = e.currentTarget.querySelector<HTMLElement>(`[data-path="${CSS.escape(row.path)}"]`);
        const rect = el?.getBoundingClientRect();
        setMenu({ row, x: rect ? rect.left + 24 : 40, y: rect ? rect.bottom : 40 });
        break;
      }
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  const collapseAll = () => {
    for (const path of Object.keys(useUi.getState().expanded)) setExpanded(path, false);
  };

  // ---------- drag and drop ----------

  /** The folder a drop on this row lands in: the folder itself, or a file's parent. */
  const dropFolderOf = (row: ExplorerRow | null) => (row ? rowFolder(row) : '');

  const accepts = (e: DragEvent) => {
    const types = e.dataTransfer.types;
    return types.includes(INTERNAL_PATH_TYPE) || types.includes('Files');
  };

  const onDragOver = (e: DragEvent, row: ExplorerRow | null) => {
    if (!accepts(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = e.dataTransfer.types.includes('Files') ? 'copy' : 'move';
    const folder = dropFolderOf(row);
    if (dropTarget !== folder) setDropTarget(folder);
  };

  const onDrop = (e: DragEvent, row: ExplorerRow | null) => {
    if (!accepts(e)) return;
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(null);
    const folder = dropFolderOf(row);
    const from = e.dataTransfer.getData(INTERNAL_PATH_TYPE);
    if (from) {
      const isFolder = tree.data?.folderPaths.has(from) ?? false;
      if (folderOf(from) === folder) return;
      if (isFolder && isWithin(folder, from)) {
        toast('A folder cannot be moved into itself', { kind: 'error' });
        return;
      }
      void moveWithUndo(from, joinPath(folder, lastSegment(from)));
      if (folder) setExpanded(folder, true);
      return;
    }
    const files = [...e.dataTransfer.files];
    if (files.length) void uploadToFolder(folder, files);
  };

  // ---------- long press (touch) ----------

  const cancelLongPress = () => {
    if (longPress.current) clearTimeout(longPress.current.timer);
    longPress.current = null;
  };

  const onPointerDown = (e: ReactPointerEvent, row: ExplorerRow) => {
    if (e.pointerType === 'mouse') return;
    cancelLongPress();
    const { clientX: x, clientY: y } = e;
    const state = {
      x,
      y,
      fired: false,
      timer: setTimeout(() => {
        state.fired = true;
        setMenu({ row, x, y });
      }, LONG_PRESS_MS),
    };
    longPress.current = state;
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    const lp = longPress.current;
    if (lp && !lp.fired && Math.hypot(e.clientX - lp.x, e.clientY - lp.y) > LONG_PRESS_SLOP) cancelLongPress();
  };

  const renderRow = (i: number) => {
    const row = rows[i];
    const Icon = row.kind === 'folder' ? (row.expanded ? FolderOpen : Folder) : viewFor(row.entry!).icon;
    const active = row.path === activePath;
    const isDrop = dropTarget !== null && row.kind === 'folder' && dropTarget === row.path;
    return (
      <div
        role="treeitem"
        aria-level={row.depth + 1}
        aria-setsize={row.size}
        aria-posinset={row.pos}
        aria-expanded={row.kind === 'folder' ? row.expanded : undefined}
        aria-selected={active}
        aria-current={active ? 'page' : undefined}
        tabIndex={i === tabStop ? 0 : -1}
        data-path={row.path}
        className={`tree-row tree-row-${row.kind}${active ? ' is-active' : ''}${row.path === focused ? ' is-focused' : ''}${isDrop ? ' is-drop-target' : ''}`}
        style={{ paddingInlineStart: 8 + row.depth * 16 }}
        title={row.path}
        draggable={!coarse && renaming !== row.path}
        onDragStart={(e) => {
          e.dataTransfer.setData(INTERNAL_PATH_TYPE, row.path);
          e.dataTransfer.setData('text/plain', row.path);
          e.dataTransfer.effectAllowed = EXPLORER_DRAG_EFFECTS;
        }}
        onDragEnd={() => setDropTarget(null)}
        onDragOver={(e) => onDragOver(e, row)}
        onDrop={(e) => onDrop(e, row)}
        onClick={() => {
          if (longPress.current?.fired) {
            cancelLongPress();
            return;
          }
          setFocused(row.path);
          if (renaming !== row.path) activate(row, false);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          cancelLongPress();
          setFocused(row.path);
          setMenu({ row, x: e.clientX, y: e.clientY });
        }}
        onPointerDown={(e) => onPointerDown(e, row)}
        onPointerMove={onPointerMove}
        onPointerUp={() => {
          if (!longPress.current?.fired) cancelLongPress();
        }}
        onPointerCancel={cancelLongPress}
        onFocus={() => setFocused(row.path)}
      >
        {row.depth > 0 && <span className="tree-guides" aria-hidden style={{ width: row.depth * 16 }} />}
        <span className={`tree-chevron${row.kind === 'folder' ? '' : ' is-empty'}${row.expanded ? ' is-open' : ''}`} aria-hidden>
          {row.kind === 'folder' && <ChevronRight size={14} />}
        </span>
        <Icon size={15} className="tree-icon" aria-hidden />
        {renaming === row.path ? (
          <RenameField row={row} onDone={() => setRenaming(null)} />
        ) : (
          <span className="tree-name">{row.name}</span>
        )}
        {row.kind === 'file' && row.entry && row.entry.kind !== 'note' && renaming !== row.path && <span className="tree-ext">{row.entry.extension}</span>}
        {coarse && renaming !== row.path && (
          <button
            type="button"
            className="icon-button tree-more"
            tabIndex={-1}
            aria-label={`Actions for ${row.name}`}
            title="More actions"
            onClick={(e) => {
              e.stopPropagation();
              const rect = e.currentTarget.getBoundingClientRect();
              setMenu({ row, x: rect.right - 200, y: rect.bottom });
            }}
          >
            <Ellipsis size={18} />
          </button>
        )}
      </div>
    );
  };

  const rootFolder = '';
  return (
    <div className="explorer">
      <div className="panel-toolbar" role="toolbar" aria-label="File explorer">
        <button type="button" className="icon-button" aria-label="New note" title="New note" onClick={() => createNote(focused ? rowFolderOfPath(focused, tree.data?.folderPaths) : rootFolder)}>
          <FilePlus size={16} />
        </button>
        <button type="button" className="icon-button" aria-label="New folder" title="New folder" onClick={() => void promptNewFolder(focused ? rowFolderOfPath(focused, tree.data?.folderPaths) : rootFolder)}>
          <FolderPlus size={16} />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label={sort === 'name' ? 'Sort by modified time' : 'Sort by name'}
          title={sort === 'name' ? 'Sort: name (switch to modified)' : 'Sort: modified (switch to name)'}
          onClick={() => setSort(sort === 'name' ? 'mtime' : 'name')}
        >
          {sort === 'name' ? <ArrowDownAZ size={16} /> : <ClockArrowDown size={16} />}
        </button>
        <button type="button" className="icon-button" aria-label="Collapse all" title="Collapse all" onClick={collapseAll}>
          <ChevronsDownUp size={16} />
        </button>
      </div>
      {tree.isPending ? (
        <div className="panel-empty">Loading…</div>
      ) : tree.isError ? (
        <div className="panel-empty">Could not load the vault.</div>
      ) : rows.length === 0 ? (
        <div className={`panel-empty explorer-drop${dropTarget === '' ? ' is-drop-target' : ''}`} onDragOver={(e) => onDragOver(e, null)} onDrop={(e) => onDrop(e, null)}>
          This vault is empty.
        </div>
      ) : (
        <VirtualList
          ref={list}
          role="tree"
          aria-label="Files"
          className={`tree${dropTarget === '' ? ' is-drop-target' : ''}`}
          count={rows.length}
          rowHeight={rowHeight}
          renderRow={renderRow}
          onKeyDown={onKeyDown}
          onDragOver={(e) => onDragOver(e, null)}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropTarget(null);
          }}
          onDrop={(e) => onDrop(e, null)}
        />
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} label={`Actions for ${menu.row.name}`} items={rowMenuItems(menu.row, () => startRename(menu.row))} onClose={() => setMenu(null)} />}
    </div>
  );
}

/** The folder for "new" actions from the toolbar: the focused folder, or a focused file's parent. */
function rowFolderOfPath(path: string, folders: ReadonlySet<string> | undefined): string {
  return folders?.has(path) ? path : folderOf(path);
}
