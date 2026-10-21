// The application shell (DESIGN §6.5, §6.16): a CSS grid with phone, tablet and desktop variants.
// Phone: TopBar + workspace, left panels in a drawer, right panels in a bottom sheet.
// Tablet: icon rail + workspace, both sidebars as overlays. Desktop: ribbon, resizable sidebars,
// workspace and status bar. Touch devices get the editing toolbar as the last grid row. The shell
// also hosts the overlays, the app-level file input and the polite live region.
import { CalendarDays, FilePlus, Moon, RefreshCw, Settings, Sun, Trash, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { setFilePicker } from '../../features/attachments';
import { runCommand } from '../../features/commands';
import { useFocusRequests } from '../../features/focus';
import { registeredPages, useExtensionsVersion } from '../../extensions';
import { activePath } from '../../features/navigation';
import { reloadForNewBuild } from '../../state/buildCheck';
import { resolvedTheme, toggleTheme, usePrefs } from '../../state/prefs';
import { LEFT_WIDTH, RIGHT_WIDTH, useUi } from '../../state/ui';
import { MoveDialog } from '../explorer/MoveDialog';
import { OfflineBanners } from '../OfflineBanners';
import { CommandPalette } from '../overlays/CommandPalette';
import { Dialogs } from '../overlays/Dialogs';
import { QuickSwitcher } from '../overlays/QuickSwitcher';
import { TemplatePicker } from '../overlays/TemplatePicker';
import { Toasts } from '../overlays/Toasts';
import { Overlay } from './Drawer';
import { MobileToolbar } from './MobileToolbar';
import { PanelTabs } from './Panels';
import { Resizer } from './Resizer';
import { Ribbon } from './Ribbon';
import { StatusBar } from './StatusBar';
import { TopBar } from './TopBar';
import { useBreakpoint } from './useBreakpoint';
import { WorkspaceScroll } from './WorkspaceScroll';

function Banners() {
  const newBuild = useUi((s) => s.newBuildAvailable);
  const draftsFailing = useUi((s) => s.draftsFailing);
  const offline = useUi((s) => s.connection === 'offline');
  const breakpoint = useBreakpoint();
  const showDrafts = draftsFailing && breakpoint !== 'desktop';
  return (
    <div className="banners">
      {newBuild && (
        <div className="banner banner-info" role="status">
          A new version is available.
          <button type="button" className="button button-small" onClick={reloadForNewBuild}>
            <RefreshCw size={14} aria-hidden /> Reload
          </button>
        </div>
      )}
      <OfflineBanners offline={offline} />
      {showDrafts && (
        <div className="banner banner-warning" role="status">
          <TriangleAlert size={14} aria-hidden /> Unsaved changes are not protected on this device.
        </div>
      )}
    </div>
  );
}

function Overlays() {
  const overlay = useUi((s) => s.overlay);
  return (
    <>
      {overlay === 'switcher' && <QuickSwitcher />}
      {overlay === 'palette' && <CommandPalette />}
      {overlay === 'templates' && <TemplatePicker mode="insert" />}
      {overlay === 'templates-new' && <TemplatePicker mode="new" />}
      <MoveDialog />
      <Dialogs />
    </>
  );
}

/** The hidden app-level file input (DESIGN §6.16): pickers opened from menus and toolbars. */
function FileInput() {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let pending: ((files: File[]) => void) | null = null;
    const el = input.current;
    if (!el) return;
    const settle = (files: File[]) => {
      pending?.(files);
      pending = null;
    };
    const onChange = () => {
      settle([...(el.files ?? [])]);
      el.value = '';
    };
    const onCancel = () => settle([]);
    el.addEventListener('change', onChange);
    el.addEventListener('cancel', onCancel);
    setFilePicker(({ accept, multiple }) => {
      settle([]);
      el.accept = accept ?? '';
      el.multiple = multiple ?? true;
      return new Promise<File[]>((resolve) => {
        pending = resolve;
        el.click();
      });
    });
    return () => {
      el.removeEventListener('change', onChange);
      el.removeEventListener('cancel', onCancel);
      setFilePicker(null);
    };
  }, []);
  return <input ref={input} type="file" className="visually-hidden" tabIndex={-1} aria-hidden />;
}

function LiveRegion() {
  const message = useFocusRequests((s) => s.message);
  const seq = useFocusRequests((s) => s.seq);
  return (
    <div className="visually-hidden" aria-live="polite" aria-atomic="true">
      <span key={seq}>{message}</span>
    </div>
  );
}

function DrawerActions() {
  useExtensionsVersion();
  const run = (id: string) => runCommand(id, { activePath: activePath() });
  const pages = registeredPages();
  return (
    <>
      <div className="drawer-actions">
        <button type="button" className="button" onClick={() => run('file.newNote')}>
          <FilePlus size={16} aria-hidden /> New note
        </button>
        <button type="button" className="button" onClick={() => run('daily.today')}>
          <CalendarDays size={16} aria-hidden /> Today
        </button>
      </div>
      {pages.length > 0 && (
        <nav className="drawer-pages" aria-label="Pages">
          {pages.map((p) => {
            const Icon = p.icon;
            return (
              <button key={p.route} type="button" className="menu-item" onClick={() => run(`page.${p.route}`)}>
                <Icon size={16} aria-hidden /> {p.title}
              </button>
            );
          })}
        </nav>
      )}
    </>
  );
}

function DrawerFooter() {
  usePrefs((s) => s.theme);
  const dark = resolvedTheme() === 'dark';
  const run = (id: string) => runCommand(id, { activePath: activePath() });
  return (
    <>
      <button type="button" className="icon-button drawer-footer-button" onClick={() => run('settings.open')}>
        <Settings size={18} aria-hidden /> Settings
      </button>
      <button type="button" className="icon-button drawer-footer-button" onClick={() => run('trash.open')}>
        <Trash size={18} aria-hidden /> Trash
      </button>
      <button
        type="button"
        className="icon-button drawer-footer-button"
        aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
        title={dark ? 'Switch to light theme' : 'Switch to dark theme'}
        onClick={toggleTheme}
      >
        {dark ? <Sun size={18} aria-hidden /> : <Moon size={18} aria-hidden />}
      </button>
    </>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const breakpoint = useBreakpoint();
  const ui = useUi();
  const closeDrawer = useCallback(() => useUi.getState().setDrawerOpen(false), []);
  const closeSheet = useCallback(() => useUi.getState().setSheetOpen(false), []);
  const desktop = breakpoint === 'desktop';
  const phone = breakpoint === 'phone';
  const showLeft = desktop && ui.leftOpen;
  const showRight = desktop && ui.rightOpen;

  const left = <PanelTabs side="left" active={ui.leftTab} onSelect={ui.setLeftTab} />;
  const right = <PanelTabs side="right" active={ui.rightTab} onSelect={ui.setRightTab} />;

  return (
    <div
      className={`app-shell is-${breakpoint}${showLeft ? ' has-left' : ''}${showRight ? ' has-right' : ''}`}
      style={{ '--left-width': `${ui.leftWidth}px`, '--right-width': `${ui.rightWidth}px` } as CSSProperties}
    >
      {!phone && <Ribbon />}
      {showLeft && (
        <nav className="sidebar sidebar-left" aria-label="Sidebar">
          {left}
          <Resizer side="left" width={ui.leftWidth} min={LEFT_WIDTH.min} max={LEFT_WIDTH.max} onResize={ui.setLeftWidth} />
        </nav>
      )}
      <main className="workspace">
        {!desktop && <TopBar />}
        <Banners />
        <WorkspaceScroll>{children}</WorkspaceScroll>
      </main>
      {showRight && (
        <aside className="sidebar sidebar-right" aria-label="Note panels">
          <Resizer side="right" width={ui.rightWidth} min={RIGHT_WIDTH.min} max={RIGHT_WIDTH.max} onResize={ui.setRightWidth} />
          {right}
        </aside>
      )}
      {desktop && <StatusBar />}
      <MobileToolbar />
      {!desktop && (
        <>
          <Overlay open={ui.drawerOpen} onClose={closeDrawer} side="left" label="Sidebar" footer={phone ? <DrawerFooter /> : undefined}>
            {phone && <DrawerActions />}
            {left}
          </Overlay>
          <Overlay open={ui.sheetOpen} onClose={closeSheet} side={phone ? 'bottom' : 'right'} label="Note panels" full={phone && ui.rightTab === 'history'}>
            {right}
          </Overlay>
        </>
      )}
      <Overlays />
      <FileInput />
      <LiveRegion />
      <Toasts />
    </div>
  );
}
