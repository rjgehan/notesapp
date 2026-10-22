// A tab's title and icon, from its route (DESIGN §6.38).
import { FileQuestion, FileText, Home, Plus, Search, Settings, Trash, type LucideIcon } from 'lucide-react';
import { matchPath } from 'react-router';
import type { VaultTree } from '../api/vaultTree';
import { pageRoute, registeredPages } from '../extensions';
import { displayName } from '../features/paths';
import { viewFor } from '../views/registry';
import { NEW_TAB_ROUTE, pathOfRoute, splitRoute } from './model';

export interface TabLabel {
  title: string;
  icon: LucideIcon;
  /** The file is no longer in the vault. */
  missing?: boolean;
}

export function tabLabel(route: string, tree: VaultTree | undefined): TabLabel {
  const path = pathOfRoute(route);
  if (path !== null) {
    const entry = tree?.byPath.get(path);
    let icon: LucideIcon = FileText;
    if (entry) {
      try {
        icon = viewFor(entry).icon;
      } catch {
        icon = FileText;
      }
    }
    return { title: displayName(path), icon: tree && !entry ? FileQuestion : icon, missing: !!tree && !entry };
  }
  const { pathname } = splitRoute(route);
  if (pathname === NEW_TAB_ROUTE) return { title: 'New tab', icon: Plus };
  if (pathname === '/') return { title: 'Home', icon: Home };
  if (pathname.startsWith('/settings')) return { title: 'Settings', icon: Settings };
  if (pathname === '/trash') return { title: 'Trash', icon: Trash };
  if (pathname === '/search') return { title: 'Search', icon: Search };
  const page = pathname.startsWith('/x/') ? registeredPages().find((p) => matchPath(pageRoute(p), pathname)) : undefined;
  return page ? { title: page.title, icon: page.icon } : { title: pathname, icon: FileQuestion };
}
