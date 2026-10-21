// Detects a deploy while this tab runs an older bundle (DESIGN §6.18). The server build arrives
// through the X-Notes-Build header and SSE hello.buildSha; a mismatch reloads a clean page and
// otherwise raises the "new version" banner (which also blocks settings writes until the reload).
//
// With the service worker (DESIGN §6.26) a reload first lets the new worker take over (see
// pwa/serviceWorker.ts). A page that comes back on the same old bundle anyway (the network was too
// slow and the cached shell answered) does not reload again for the same server build within a
// minute: it shows the banner instead, so a reload can never loop.
import { useUi } from './ui';

export const pageBuild: string = import.meta.env.VITE_BUILD_SHA ?? 'dev';

/** sessionStorage key of the last automatic reload: `{build, at}`. */
const GUARD_KEY = 'notesapp:buildReload';
const GUARD_MS = 60_000;

let anyUnsaved: () => boolean = () => false;
let prepare: (() => Promise<void>) | null = null;
let reloadPage: () => void = () => window.location.reload();
let reloading = false;

/** The document registry tells the check whether a reload would interrupt a save. */
export function setUnsavedProbe(probe: () => boolean): void {
  anyUnsaved = probe;
}

/** Runs before every build reload (the service worker's hand-over); it must not reject. */
export function setReloadPreparer(fn: (() => Promise<void>) | null): void {
  prepare = fn;
}

/** Tests replace the reload; production uses `location.reload()`. Also forgets the loop guard. */
export function setReloader(reload: () => void): void {
  reloadPage = reload;
  reloading = false;
  try {
    sessionStorage.removeItem(GUARD_KEY);
  } catch {
    // Storage blocked: the guard was never written either.
  }
}

function reloadedRecentlyFor(build: string, now: number): boolean {
  try {
    const raw = sessionStorage.getItem(GUARD_KEY);
    const last = raw ? (JSON.parse(raw) as { build?: unknown; at?: unknown }) : null;
    return !!last && last.build === build && typeof last.at === 'number' && now - last.at < GUARD_MS;
  } catch {
    return false;
  }
}

function rememberReload(build: string, now: number): void {
  try {
    sessionStorage.setItem(GUARD_KEY, JSON.stringify({ build, at: now }));
  } catch {
    // Without storage there is no guard; the banner path still works.
  }
}

/** The reload into the new build (also the banner's Reload button). */
export function reloadForNewBuild(): void {
  if (reloading) return;
  reloading = true;
  if (!prepare) {
    reloadPage();
    return;
  }
  void prepare()
    .catch(() => undefined)
    .then(() => reloadPage());
}

export function reportServerBuild(serverBuild: string | null | undefined, ownBuild: string = pageBuild): void {
  if (!serverBuild || serverBuild === ownBuild || reloading) return;
  handleNewBuild(serverBuild);
}

/** `serverBuild` is the build the server reported; unknown for a vanished lazy chunk. */
export function handleNewBuild(serverBuild = 'unknown'): void {
  if (reloading) return;
  const now = Date.now();
  if (!anyUnsaved() && !reloadedRecentlyFor(serverBuild, now)) {
    rememberReload(serverBuild, now);
    reloadForNewBuild();
    return;
  }
  useUi.getState().setNewBuildAvailable(true);
}

/** Called once at startup: a lazy chunk of the old build vanished after a deploy. */
export function installPreloadErrorHandler(): void {
  window.addEventListener('vite:preloadError', (event) => {
    event.preventDefault();
    handleNewBuild();
  });
}
