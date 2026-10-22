// The clip every client produces (DESIGN §6.27.1), before it becomes a note.

export interface Clip {
  /** The article's title, or the page's. */
  title: string;
  /** The page's address (`location.href`), without its fragment. */
  url: string;
  author: string | null;
  siteName: string | null;
  /** As the page states it; reduced to a date in the frontmatter. */
  published: string | null;
  description: string | null;
  /** The readable body (or the selection) as Markdown. */
  markdown: string;
  /** The absolute `http`/`https` URLs of the images the Markdown shows, each once. */
  images: string[];
  /** True when only the selection was clipped. */
  selection: boolean;
}

export interface ExtractOptions {
  /** The page's address; default the document's own URL. */
  url?: string;
  /** Clip this HTML (the selection) instead of the readable article. */
  selectionHtml?: string | null;
}
