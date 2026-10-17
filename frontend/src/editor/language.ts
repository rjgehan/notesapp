// The note language (DESIGN §6.6 #6): GFM with frontmatter, lazily loaded fence grammars and the
// Obsidian nodes. Shared by the editor and by sessions, so headings and links can be read from the
// Lezer tree even while no editor is mounted.
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { yamlFrontmatter } from '@codemirror/lang-yaml';
import type { LanguageSupport } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { ObsidianSyntax } from './obsidianSyntax';

let support: LanguageSupport | null = null;

export function markdownNoteLanguage(): LanguageSupport {
  support ??= yamlFrontmatter({
    content: markdown({
      base: markdownLanguage,
      codeLanguages: languages,
      extensions: [ObsidianSyntax],
      completeHTMLTags: false,
    }),
  });
  return support;
}
