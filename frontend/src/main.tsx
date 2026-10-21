import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import App from './App';
import { queryClient } from './api/queryClient';
import { currentBreakpoint } from './components/layout/useBreakpoint';
import { installViewportVars } from './editor/mobileViewport';
import { registerBuiltins } from './extensions/builtins';
import { installInputModality } from './features/focus';
import { clearStaleOverlayEntry } from './features/overlayHistory';
import { installCaptureSync } from './features/captureSync';
import { installHotkeys } from './features/hotkeys';
import { prepareReload, registerServiceWorker, setOfflineMedia } from './pwa/serviceWorker';
import { installPreloadErrorHandler, setReloadPreparer } from './state/buildCheck';
import { installOnlineListener } from './state/connection';
import { applyTheme, installThemeListener, usePrefs } from './state/prefs';
import { documents } from './sync/instance';
import { startLiveSync } from './sync/liveSync';
import './styles/tokens.css';
import './styles/app.css';
import './styles/editor.css';
import './styles/reading.css';
import './styles/features.css';
import './styles/bookmarks.css';
import './styles/hotkeys.css';
import './styles/mobile.css';

async function boot(): Promise<void> {
  // The in-memory mock replaces the HTTP endpoints before anything fetches (dev only).
  if (import.meta.env.DEV && import.meta.env.VITE_MOCK_API === '1') {
    const { installMockApi } = await import('./api/mock');
    installMockApi();
  }

  clearStaleOverlayEntry();
  applyTheme();
  installThemeListener();
  registerBuiltins();
  installViewportVars();
  installHotkeys();
  installInputModality();
  installPreloadErrorHandler();
  // The installable app (DESIGN §6.26): a build reload first lets the new service worker take over.
  setReloadPreparer(() => prepareReload());
  registerServiceWorker();
  setOfflineMedia(usePrefs.getState().offlineNotes);
  installOnlineListener();
  documents.installLifecycle(() => currentBreakpoint() === 'desktop');
  void startLiveSync();
  installCaptureSync();

  // Navigations render synchronously (no transitions), so an input shown by a tap or key handler
  // can take focus within the same user gesture, which iOS needs to open the keyboard (§6.13).
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter useTransitions={false}>
          <App />
        </BrowserRouter>
      </QueryClientProvider>
    </StrictMode>,
  );
}

void boot();
