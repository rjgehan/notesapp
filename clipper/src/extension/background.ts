// background.js (the Manifest V3 service worker in Chrome and Edge, an event page in Firefox):
// the context-menu items, and the clips the popup asks for.
import type { Browser, Tab } from './browser';
import { clipTab, ClipError, type ClipOutcome } from './clip';

const MENU_PAGE = 'notesapp-clip-page';
const MENU_SELECTION = 'notesapp-clip-selection';

/** The popup's request (popup.ts). */
export interface ClipRequest {
  type: 'clip';
  selection: boolean;
}

export function isClipRequest(m: unknown): m is ClipRequest {
  return typeof m === 'object' && m !== null && (m as ClipRequest).type === 'clip' && typeof (m as ClipRequest).selection === 'boolean';
}

async function badge(b: Browser, tab: Tab | undefined, outcome: ClipOutcome | Error): Promise<void> {
  const tabId = tab?.id;
  const ok = !(outcome instanceof Error) && outcome.status !== 'failed' && outcome.status !== 'timeout';
  const title = outcome instanceof Error ? outcome.message : outcome.status === 'saved' ? `Saved to ${outcome.path ?? 'NotesApp'}` : outcome.status === 'delivered' ? 'Opened in NotesApp' : (outcome.error ?? 'The clip was not saved');
  await b.action.setBadgeBackgroundColor({ color: ok ? '#2f9e44' : '#c92a2a', tabId }).catch(() => undefined);
  await b.action.setBadgeText({ text: ok ? '✓' : '!', tabId }).catch(() => undefined);
  await b.action.setTitle({ title: `NotesApp clipper: ${title}`, tabId }).catch(() => undefined);
}

export async function runClip(b: Browser, tab: Tab | undefined, selection: boolean): Promise<ClipOutcome> {
  try {
    if (!tab) throw new ClipError('No tab to clip.');
    const outcome = await clipTab(b, tab, selection);
    await badge(b, tab, outcome);
    return outcome;
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    await badge(b, tab, error);
    return { status: 'failed', error: error.message };
  }
}

export function install(b: Browser): void {
  b.runtime.onInstalled.addListener(() => {
    void b.contextMenus.removeAll().then(() => {
      b.contextMenus.create({ id: MENU_PAGE, title: 'Clip this page to NotesApp', contexts: ['page'] });
      b.contextMenus.create({ id: MENU_SELECTION, title: 'Clip the selection to NotesApp', contexts: ['selection'] });
    });
  });
  b.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === MENU_PAGE || info.menuItemId === MENU_SELECTION) void runClip(b, tab, info.menuItemId === MENU_SELECTION);
  });
  b.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!isClipRequest(message)) return false;
    void b.tabs
      .query({ active: true, currentWindow: true })
      .then(([tab]) => runClip(b, tab, message.selection))
      .then(sendResponse);
    return true;
  });
}
