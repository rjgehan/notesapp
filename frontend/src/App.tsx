// Routes (DESIGN §6.4) inside the application shell.
import { lazy, Suspense, useEffect, useRef, type ComponentType } from 'react';
import { Route, Routes, useLocation, useNavigate } from 'react-router';
import { CapturePage } from './components/capture/CapturePage';
import { AppShell } from './components/layout/AppShell';
import { ErrorBoundary } from './components/ErrorBoundary';
import { HomePage } from './components/pages/HomePage';
import { NotFoundPage } from './components/pages/NotFoundPage';
import { PendingNoteView } from './components/pages/PendingNoteView';
import { SearchPage } from './components/pages/SearchPage';
import { TrashPage } from './components/pages/TrashPage';
import { registeredPages, useExtensionsVersion, type PageDescriptor } from './extensions';
import { setNavigator } from './features/navigation';
import { navigateOverOverlays } from './features/overlayHistory';
import { clearPendingNote, usePendingNote } from './state/pendingNote';
import { FileView } from './views/FileView';

const SettingsPage = lazy(() => import('./components/pages/SettingsPage'));

/**
 * Lets non-React code (links in the editor, sessions, commands) navigate through the router.
 * On touch devices a navigation first steps back over the history entries of open overlays.
 */
function NavigationBridge() {
  const navigate = useNavigate();
  useEffect(() => {
    setNavigator((to, opts) => navigateOverOverlays(() => void navigate(to, opts)));
  }, [navigate]);
  return null;
}

/** Navigating elsewhere while a new note is being created leaves that note where it is. */
function usePendingNoteGuard(): void {
  const location = useLocation();
  const seen = useRef(location.key);
  useEffect(() => {
    if (seen.current !== location.key) {
      seen.current = location.key;
      clearPendingNote();
    }
  }, [location.key]);
}

const lazyPages = new Map<string, ComponentType>();

function pageComponent(p: PageDescriptor): ComponentType {
  let c = lazyPages.get(p.route);
  if (!c) {
    c = lazy(p.load);
    lazyPages.set(p.route, c);
  }
  return c;
}

const pageFallback = <div className="view-loading" aria-busy="true" />;

export default function App() {
  useExtensionsVersion();
  usePendingNoteGuard();
  const pending = usePendingNote((s) => s.pending);
  const { pathname } = useLocation();
  const pages = registeredPages().map((p) => ({ route: p.route, Page: pageComponent(p) }));
  // Quick capture (DESIGN §6.22) is a page of its own, outside the app shell: the share target,
  // the home-screen shortcut and the desktop app's capture window open it.
  if (pathname === '/capture') {
    return (
      <>
        <NavigationBridge />
        <CapturePage />
      </>
    );
  }
  return (
    <AppShell>
      <NavigationBridge />
      {pending ? (
        <PendingNoteView key={pending.id} pending={pending} />
      ) : (
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/n/*" element={<FileView />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/trash" element={<TrashPage />} />
          <Route
            path="/settings/*"
            element={
              <ErrorBoundary label="page">
                <Suspense fallback={pageFallback}>
                  <SettingsPage />
                </Suspense>
              </ErrorBoundary>
            }
          />
          {pages.map(({ route, Page }) => (
            <Route
              key={route}
              path={`/x/${route}`}
              element={
                <ErrorBoundary label="page">
                  <Suspense fallback={pageFallback}>
                    <Page />
                  </Suspense>
                </ErrorBoundary>
              }
            />
          ))}
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      )}
    </AppShell>
  );
}
