import type { Settings } from '../api/types';

/** Vault settings defaults (DESIGN §5.12), used until GET /api/settings answers. */
export const DEFAULT_SETTINGS: Settings = {
  schemaVersion: 1,
  files: {
    newNoteLocation: 'root',
    newNoteFolder: '',
    newLinkFormat: 'shortest',
    useWikilinks: true,
    attachmentLocation: 'folder',
    attachmentFolder: 'Attachments',
    attachmentSubfolder: 'attachments',
    autoUpdateLinks: true,
    excludedPaths: [],
  },
  dailyNotes: { format: 'YYYY-MM-DD', folder: 'Daily', template: '', openOnStartup: false },
  templates: { folder: 'Templates', dateFormat: 'YYYY-MM-DD', timeFormat: 'HH:mm' },
  editor: { defaultMode: 'edit', readableLineLength: true, strictLineBreaks: false },
  ai: { enabled: false, provider: 'claude-code', model: 'claude-sonnet-5-5', excludedPaths: ['Private'], maxContextChars: 60000, monthlyBudgetUsd: 5 },
};
