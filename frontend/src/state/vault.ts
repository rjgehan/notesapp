// The vault this page shows (ROADMAP item 37, DESIGN §6.41). The default vault keeps its
// unprefixed URLs (`/n/...`, `/api/...`); an extra vault lives under `/v/<name>/` and its API under
// `/api/v/<name>/`. The vault is read once from the address at startup: switching vaults loads the
// app again, so caches, the event stream and every in-memory store belong to one vault only.
// Storage that outlives the page (drafts, the offline note cache, the capture queue, the open tabs,
// recent files) is keyed by vault with `vaultKey`.
import { vaultFromPathname } from '../sw/vaultPath';

export { isValidVaultName, vaultFromPathname } from '../sw/vaultPath';

/** Endpoints that belong to the server, not to a vault: never prefixed. */
const SERVER_WIDE = ['/api/vaults'];

let current: string | null = typeof window === 'undefined' ? null : vaultFromPathname(window.location.pathname);

/** The extra vault this page shows, or null for the default vault. */
export function currentVault(): string | null {
  return current;
}

/** Tests only: pretend the page shows another vault. */
export function setCurrentVaultForTests(name: string | null): void {
  current = name;
}

/** The router's basename: '' for the default vault, `/v/<name>` for an extra one. */
export function vaultBasename(): string {
  return current === null ? '' : `/v/${current}`;
}

/** An API path (`/api/...`) of this vault. */
export function apiUrl(url: string): string {
  if (current === null || !url.startsWith('/api/')) return url;
  if (SERVER_WIDE.some((p) => url === p || url.startsWith(p + '?') || url.startsWith(p + '/'))) return url;
  return `/api/v/${current}${url.slice(4)}`;
}

/** An app path (`/n/...`, `/x/...`) as an address of this vault, for links outside the router. */
export function appUrl(path: string): string {
  return vaultBasename() + path;
}

/** The address's path within this vault's app (without `/v/<name>`), like the router's location. */
export function appPathname(pathname: string = window.location.pathname): string {
  const base = vaultBasename();
  if (base && (pathname === base || pathname.startsWith(base + '/'))) return pathname.slice(base.length) || '/';
  return pathname;
}

/**
 * An app link the server handed out (a reminder's `/v/work/x/tasks/...`) as a route of this
 * vault's router; null when it belongs to another vault, which only a full load can open.
 */
export function routeOfAppUrl(url: string): string | null {
  const vault = vaultFromPathname(url);
  if (vault !== current) return null;
  return vault === null ? url : url.slice(`/v/${vault}`.length) || '/';
}

/** A storage key of this vault: the key itself for the default vault, `key@name` otherwise. */
export function vaultKey(key: string): string {
  return current === null ? key : `${key}@${current}`;
}

/** A browser tab title: an extra vault's name is part of it, so tabs of two vaults tell apart. */
export function appTitle(title: string): string {
  return current === null ? `${title} · Notes` : `${title} · ${current} · Notes`;
}
