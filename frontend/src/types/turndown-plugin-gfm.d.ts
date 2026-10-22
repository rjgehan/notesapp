// The Joplin-maintained turndown GFM plugin ships without types.
declare module '@joplin/turndown-plugin-gfm' {
  import type TurndownService from 'turndown';

  type Plugin = (service: TurndownService) => void;
  export const gfm: Plugin;
  export const highlightedCodeBlock: Plugin;
  export const strikethrough: Plugin;
  export const tables: Plugin;
  export const taskListItems: Plugin;
}
