// Code highlighting for the reading view, loaded lazily by rich/index.ts. It reuses the editor's
// grammars (@codemirror/language-data, each loaded on first use) and its token classes
// (features/codeTokens.ts), through @lezer/highlight's highlightCode, so there is no Prism or Shiki
// and a code block looks the same in both modes. Theme-aware through the `--tok-*` variables.
import { LanguageDescription, type Language } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { highlightCode, tagHighlighter } from '@lezer/highlight';
import { CODE_TOKEN_STYLES } from '../../features/codeTokens';

const highlighter = tagHighlighter(CODE_TOKEN_STYLES);

/** Loaded grammars by lowercased fence name; null for names no grammar matches. */
const loaded = new Map<string, Language | null>();
const loading = new Map<string, Promise<Language | null>>();

/** The language-data entry for a fence name (`ts`, `Python`, `c++`), by name or alias, then by file extension. */
export function describeLanguage(name: string): LanguageDescription | null {
  const lower = name.toLowerCase();
  return LanguageDescription.matchLanguageName(languages, lower, false) ?? LanguageDescription.matchFilename(languages, `file.${lower}`);
}

/** The grammar for `name` if it is already loaded; undefined while unknown or loading. */
export function loadedLanguage(name: string): Language | null | undefined {
  return loaded.get(name.toLowerCase());
}

export function loadLanguage(name: string): Promise<Language | null> {
  const key = name.toLowerCase();
  if (loaded.has(key)) return Promise.resolve(loaded.get(key)!);
  let promise = loading.get(key);
  if (!promise) {
    const description = describeLanguage(key);
    promise = (description ? description.load().then((support) => support.language) : Promise.resolve(null)).then(
      (language) => {
        loaded.set(key, language);
        loading.delete(key);
        return language;
      },
      () => {
        // A failed chunk load is retried on the next render.
        loading.delete(key);
        return null;
      },
    );
    loading.set(key, promise);
  }
  return promise;
}

/** Highlighted code as text nodes and `<span class="cm-tok-…">`s, built without HTML parsing. */
export function highlightFragment(code: string, language: Language): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const tree = language.parser.parse(code);
  let plain = '';
  const flush = () => {
    if (plain) fragment.appendChild(document.createTextNode(plain));
    plain = '';
  };
  highlightCode(
    code,
    tree,
    highlighter,
    (text, classes) => {
      if (!classes) {
        plain += text;
        return;
      }
      flush();
      const span = document.createElement('span');
      span.className = classes;
      span.textContent = text;
      fragment.appendChild(span);
    },
    () => {
      plain += '\n';
    },
  );
  flush();
  return fragment;
}
