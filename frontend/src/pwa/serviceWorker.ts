// Service worker registration and its part in the build reload (DESIGN §6.18, §6.21).
//
// The worker (src/sw/sw.ts) installs a new build's shell in the background and takes over as soon
// as it is complete; navigations are network-first, so a page reloaded after a deploy gets the new
// index.html from the server whichever worker is active. Before that reload the page also asks
// for the new worker and waits (briefly) for it to take over, so the reload lands on the new
// shell even when the network is too slow for the navigation and the cached shell answers.

const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const RELOAD_WAIT_MS = 10_000;

let registration: ServiceWorkerRegistration | null = null;
let lastUpdateCheck = 0;

function supported(): boolean {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator && typeof window !== 'undefined' && window.isSecureContext;
}

/** Registers /sw.js (production builds only). A development page removes any worker a preview left behind. */
export function registerServiceWorker(): void {
  if (!supported()) return;
  if (!import.meta.env.PROD) {
    void navigator.serviceWorker.getRegistrations().then((list) => list.forEach((r) => void r.unregister()));
    return;
  }
  navigator.serviceWorker
    .register('/sw.js', { scope: '/', updateViaCache: 'none' })
    .then((r) => {
      registration = r;
      lastUpdateCheck = Date.now();
    })
    .catch((e: unknown) => console.warn('[notesapp] service worker registration failed', e));
  // An installed app can stay open for weeks without navigating: look for a new worker when it
  // comes back to the foreground, at most once an hour (the build check covers deploys sooner).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - lastUpdateCheck > UPDATE_CHECK_INTERVAL_MS) void checkForUpdate();
  });
}

export async function checkForUpdate(): Promise<void> {
  if (!registration) return;
  lastUpdateCheck = Date.now();
  try {
    await registration.update();
  } catch {
    // Offline or the server is restarting: the next check finds it.
  }
}

function settled(worker: ServiceWorker, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      if (worker.state !== 'activated' && worker.state !== 'redundant') return;
      clearTimeout(timer);
      worker.removeEventListener('statechange', done);
      resolve();
    };
    const timer = setTimeout(() => {
      worker.removeEventListener('statechange', done);
      resolve();
    }, timeoutMs);
    worker.addEventListener('statechange', done);
    done();
  });
}

/**
 * Before reloading into a new build: fetches the new worker and waits until it has taken over (or
 * failed), at most `timeoutMs`. Never rejects; without a worker it returns at once.
 */
export async function prepareReload(timeoutMs = RELOAD_WAIT_MS): Promise<void> {
  if (!supported() || !import.meta.env.PROD) return;
  const started = Date.now();
  const reg = registration ?? (await navigator.serviceWorker.getRegistration().catch(() => undefined)) ?? null;
  if (!reg) return;
  await Promise.race([reg.update().catch(() => undefined), new Promise((r) => setTimeout(r, timeoutMs))]);
  const worker = reg.installing ?? reg.waiting;
  if (!worker) return;
  await settled(worker, Math.max(0, timeoutMs - (Date.now() - started)));
}

/** Tells the worker whether note images may be kept for offline reading (Settings › This device). */
export function setOfflineMedia(enabled: boolean): void {
  if (!supported() || !import.meta.env.PROD) return;
  void navigator.serviceWorker.ready.then((r) => r.active?.postMessage({ type: 'SET_OFFLINE_MEDIA', enabled })).catch(() => undefined);
}
