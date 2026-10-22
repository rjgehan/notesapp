// The routes of DESIGN §6.4, rendered once per pane (§6.38): each pane passes the location of its
// shown tab, so an inactive pane renders its own route while the URL shows the active pane's.
import { lazy, Suspense, type ComponentType } from 'react';
import { Route, Routes, type Location } from 'react-router';
import { ErrorBoundary } from './components/ErrorBoundary';
import { HomePage } from './components/pages/HomePage';
import { NotFoundPage } from './components/pages/NotFoundPage';
import { PendingNoteView } from './components/pages/PendingNoteView';
import { SearchPage } from './components/pages/SearchPage';
import { TrashPage } from './components/pages/TrashPage';
import { registeredPages, useExtensionsVersion, type PageDescriptor } from './extensions';
import { usePendingNote } from './state/pendingNote';
import { FileView } from './views/FileView';

const SettingsPage = lazy(() => import('./components/pages/SettingsPage'));

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

export function AppRoutes({ location, active = true }: { location?: Location; active?: boolean }) {
  useExtensionsVersion();
  const pending = usePendingNote((s) => s.pending);
  const pages = registeredPages().map((p) => ({ route: p.route, Page: pageComponent(p) }));
  // A note being created shows in the active pane, where New note was asked for.
  if (pending && active) return <PendingNoteView key={pending.id} pending={pending} />;
  return (
    <Routes location={location}>
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
  );
}
