// The few WebExtension APIs the clipper uses, typed by hand so one build serves Chrome, Edge
// (`chrome.*`, promise-based in Manifest V3) and Firefox (`browser.*`).

export interface Tab {
  id?: number;
  url?: string;
  status?: string;
  windowId?: number;
}

export interface InjectionResult<T> {
  result?: T;
}

export interface Permissions {
  origins?: string[];
  permissions?: string[];
}

export interface ContextMenuInfo {
  menuItemId: string | number;
  selectionText?: string;
}

interface Event<F> {
  addListener(listener: F): void;
  removeListener(listener: F): void;
}

export interface Browser {
  runtime: {
    onInstalled: Event<() => void>;
    onMessage: Event<(message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => boolean | void>;
    sendMessage(message: unknown): Promise<unknown>;
    openOptionsPage(): Promise<void>;
    getManifest(): { version: string };
  };
  storage: {
    sync: {
      get(keys: string[] | null): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    };
  };
  tabs: {
    query(q: { active: boolean; currentWindow: boolean }): Promise<Tab[]>;
    create(p: { url: string; active: boolean; index?: number; openerTabId?: number }): Promise<Tab>;
    get(tabId: number): Promise<Tab>;
    remove(tabId: number): Promise<void>;
    update(tabId: number, p: { active: boolean }): Promise<Tab>;
    onUpdated: Event<(tabId: number, change: { status?: string }, tab: Tab) => void>;
    onRemoved: Event<(tabId: number) => void>;
  };
  scripting: {
    executeScript<T>(p: { target: { tabId: number }; files?: string[]; func?: (...args: never[]) => unknown; args?: unknown[] }): Promise<InjectionResult<T>[]>;
  };
  permissions: {
    contains(p: Permissions): Promise<boolean>;
    request(p: Permissions): Promise<boolean>;
  };
  contextMenus: {
    create(p: { id: string; title: string; contexts: string[] }): void;
    removeAll(): Promise<void>;
    onClicked: Event<(info: ContextMenuInfo, tab?: Tab) => void>;
  };
  action: {
    setBadgeText(p: { text: string; tabId?: number }): Promise<void>;
    setBadgeBackgroundColor(p: { color: string; tabId?: number }): Promise<void>;
    setTitle(p: { title: string; tabId?: number }): Promise<void>;
  };
}

const g = globalThis as unknown as { browser?: Browser; chrome?: Browser };

/** `browser` in Firefox, `chrome` in Chrome and Edge. */
export function ext(): Browser {
  const b = g.browser ?? g.chrome;
  if (!b) throw new Error('No WebExtension API here');
  return b;
}
