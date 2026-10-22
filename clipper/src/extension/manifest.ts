// manifest.json for each browser (Manifest V3). Chrome and Edge run the background as a service
// worker; Firefox runs it as an event page and needs an add-on id. Host access is never asked for
// at install: NotesApp's origin (and every site, for image downloads) is requested on the options
// page, and the clipped tab is reached through activeTab, on the click.
export type Target = 'chrome' | 'firefox';

export const GECKO_ID = 'clipper@notesapp.rjgehan.github.io';

export function manifest(target: Target, version: string): Record<string, unknown> {
  const icons = { '16': 'icons/icon-128.png', '32': 'icons/icon-128.png', '48': 'icons/icon-128.png', '128': 'icons/icon-128.png' };
  const base: Record<string, unknown> = {
    manifest_version: 3,
    name: 'NotesApp clipper',
    short_name: 'Clip to Notes',
    version,
    description: 'Save the article on this page, or the selection, as a Markdown note in your NotesApp.',
    icons,
    action: { default_title: 'Clip to NotesApp', default_popup: 'popup.html', default_icon: icons },
    permissions: ['activeTab', 'scripting', 'storage', 'contextMenus'],
    optional_host_permissions: ['https://*/*', 'http://*/*'],
    options_ui: { page: 'options.html', open_in_tab: true },
    commands: {
      _execute_action: { suggested_key: { default: 'Alt+Shift+K' }, description: 'Open the clipper' },
    },
  };
  if (target === 'chrome') {
    return { ...base, background: { service_worker: 'background.js' }, minimum_chrome_version: '121' };
  }
  return {
    ...base,
    background: { scripts: ['background.js'] },
    browser_specific_settings: {
      gecko: { id: GECKO_ID, strict_min_version: '128.0', data_collection_permissions: { required: ['none'] } },
    },
  };
}
