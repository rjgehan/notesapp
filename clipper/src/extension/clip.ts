// What a click does (DESIGN §6.27.1): extract in the clipped tab (activeTab), download the images
// if asked, open the app's /clip page and hand it the clip. The extension never calls the API
// itself; /clip saves through the app's same-origin API, so the CSRF rules (API.md §2) stay as
// they are and no server setting is needed.
import { CLIP_MESSAGE, PROTOCOL_VERSION, type ExtractedClipMessage } from '../core/protocol';
import type { Clip } from '../core/types';
import type { Browser, Tab } from './browser';
import { deliverClip } from './deliver';
import { downloadImages } from './images';
import { ALL_SITES, appPattern, readSettings, type ClipperSettings } from './settings';

export class ClipError extends Error {}

/** How long a clip that saves itself may take before the tab is left to the user. */
const AUTO_SAVE_WAIT_MS = 90_000;

/** Pages an extension may not script (the browser's own, the stores). */
export function isClippable(url: string | undefined): boolean {
  return !!url && /^(https?|file):/i.test(url) && !/^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com|addons\.mozilla\.org|microsoftedge\.microsoft\.com\/addons)/i.test(url);
}

export async function loadSettings(b: Browser): Promise<ClipperSettings> {
  return readSettings(await b.storage.sync.get(null));
}

/** Resolves once `tabId` has finished loading. */
export function waitForLoad(b: Browser, tabId: number, timeoutMs = 30_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(new ClipError('NotesApp did not load in time. Is Tailscale connected?')), timeoutMs);
    const onUpdated = (id: number, change: { status?: string }) => {
      if (id === tabId && change.status === 'complete') done();
    };
    const onRemoved = (id: number) => {
      if (id === tabId) done(new ClipError('The clip tab was closed.'));
    };
    function done(error?: Error) {
      clearTimeout(timer);
      b.tabs.onUpdated.removeListener(onUpdated);
      b.tabs.onRemoved.removeListener(onRemoved);
      if (error) reject(error);
      else resolve();
    }
    b.tabs.onUpdated.addListener(onUpdated);
    b.tabs.onRemoved.addListener(onRemoved);
    void b.tabs.get(tabId).then((t) => t.status === 'complete' && t.url && t.url !== 'about:blank' && done(), () => undefined);
  });
}

/** Runs the extractor in `tab` (content.js defines it). */
export async function extractInTab(b: Browser, tabId: number, selection: boolean): Promise<Clip> {
  await b.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  const [first] = await b.scripting.executeScript<Clip>({
    target: { tabId },
    func: ((onlySelection: boolean) => (globalThis as unknown as { __notesappClip: (s: boolean) => Clip }).__notesappClip(onlySelection)) as (...args: never[]) => unknown,
    args: [selection],
  });
  if (!first?.result) throw new ClipError('The page could not be read.');
  return first.result;
}

export interface ClipOutcome {
  status: 'saved' | 'failed' | 'delivered' | 'timeout';
  path?: string;
  error?: string;
}

/** The whole clip of `tab`. */
export async function clipTab(b: Browser, tab: Tab, selection: boolean): Promise<ClipOutcome> {
  const settings = await loadSettings(b);
  if (!settings.appUrl) {
    await b.runtime.openOptionsPage();
    throw new ClipError('Set NotesApp’s address in the clipper’s options first.');
  }
  if (tab.id === undefined || !isClippable(tab.url)) throw new ClipError('This page cannot be clipped.');
  if (!(await b.permissions.contains({ origins: [appPattern(settings.appUrl)] }))) {
    await b.runtime.openOptionsPage();
    throw new ClipError('Allow the clipper to open NotesApp (Options › Save).');
  }
  const clip = await extractInTab(b, tab.id, selection);
  const images = settings.downloadImages && clip.images.length > 0 && (await b.permissions.contains({ origins: ALL_SITES })) ? await downloadImages(clip.images) : [];
  const message: ExtractedClipMessage = { type: CLIP_MESSAGE, v: PROTOCOL_VERSION, kind: 'clip', clip, images, folder: settings.folder, autoSave: settings.autoSave };
  const appTab = await b.tabs.create({ url: `${settings.appUrl}/clip?via=extension`, active: !settings.autoSave, openerTabId: tab.id });
  if (appTab.id === undefined) throw new ClipError('NotesApp could not be opened.');
  await waitForLoad(b, appTab.id);
  const [delivered] = await b.scripting.executeScript<ClipOutcome>({
    target: { tabId: appTab.id },
    func: deliverClip as unknown as (...args: never[]) => unknown,
    args: [message, AUTO_SAVE_WAIT_MS],
  });
  const outcome = delivered?.result ?? { status: 'failed', error: 'NotesApp did not answer.' };
  if (settings.autoSave && outcome.status === 'saved') await b.tabs.remove(appTab.id).catch(() => undefined);
  // A clip that should have saved itself but did not: show its tab, where the error is.
  else if (settings.autoSave) await b.tabs.update(appTab.id, { active: true }).catch(() => undefined);
  return { status: outcome.status, path: outcome.path, error: outcome.error };
}
