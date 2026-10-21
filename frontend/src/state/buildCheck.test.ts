import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleNewBuild, reloadForNewBuild, reportServerBuild, setReloader, setReloadPreparer, setUnsavedProbe } from './buildCheck';
import { useUi } from './ui';

describe('build check with the service worker', () => {
  beforeEach(() => {
    useUi.getState().setNewBuildAvailable(false);
    setUnsavedProbe(() => false);
  });

  afterEach(() => {
    setReloadPreparer(null);
  });

  it('lets the new worker take over before reloading', async () => {
    const order: string[] = [];
    let release!: () => void;
    setReloadPreparer(() => {
      order.push('prepare');
      return new Promise<void>((r) => (release = r));
    });
    setReloader(() => order.push('reload'));
    reportServerBuild('build-2', 'build-1');
    expect(order).toEqual(['prepare']);
    release();
    await vi.waitFor(() => expect(order).toEqual(['prepare', 'reload']));
  });

  it('reloads even when preparing fails', async () => {
    const reload = vi.fn();
    setReloadPreparer(() => Promise.reject(new Error('offline')));
    setReloader(reload);
    reportServerBuild('build-2', 'build-1');
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });

  it('does not reload twice in a row for the same server build: the banner shows instead', () => {
    const reload = vi.fn();
    setReloader(reload);
    reportServerBuild('build-2', 'build-1');
    expect(reload).toHaveBeenCalledTimes(1);
    // The page came back on the old bundle (the cached shell answered a slow navigation).
    setReloaderKeepingGuard(reload);
    reportServerBuild('build-2', 'build-1');
    expect(reload).toHaveBeenCalledTimes(1);
    expect(useUi.getState().newBuildAvailable).toBe(true);
    // The banner's Reload still works.
    reloadForNewBuild();
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('a newer server build reloads again', () => {
    const reload = vi.fn();
    setReloader(reload);
    reportServerBuild('build-2', 'build-1');
    setReloaderKeepingGuard(reload);
    handleNewBuild('build-3');
    expect(reload).toHaveBeenCalledTimes(2);
  });
});

/** A fresh page load: the module state resets, sessionStorage (the guard) survives. */
function setReloaderKeepingGuard(reload: () => void): void {
  const saved = sessionStorage.getItem('notesapp:buildReload');
  setReloader(reload);
  if (saved !== null) sessionStorage.setItem('notesapp:buildReload', saved);
}
