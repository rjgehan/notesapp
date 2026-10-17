// Detects a deploy while this tab runs an older bundle (DESIGN §6.18). The server build arrives
// through the X-Notes-Build header and SSE hello.buildSha; a mismatch reloads a clean page and
// otherwise raises the "new version" banner (which also blocks settings writes until the reload).
import { useUi } from './ui';

export const pageBuild: string = import.meta.env.VITE_BUILD_SHA ?? 'dev';

let anyUnsaved: () => boolean = () => false;
let reloadPage: () => void = () => window.location.reload();
let reloading = false;

/** The document registry tells the check whether a reload would interrupt a save. */
export function setUnsavedProbe(probe: () => boolean): void {
  anyUnsaved = probe;
}

/** Tests replace the reload; production uses `location.reload()`. */
export function setReloader(reload: () => void): void {
  reloadPage = reload;
  reloading = false;
}

export function reportServerBuild(serverBuild: string | null | undefined, ownBuild: string = pageBuild): void {
  if (!serverBuild || serverBuild === ownBuild || reloading) return;
  handleNewBuild();
}

export function handleNewBuild(): void {
  if (reloading) return;
  if (!anyUnsaved()) {
    reloading = true;
    reloadPage();
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
