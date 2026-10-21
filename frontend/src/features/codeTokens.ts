// Syntax-token classes for code: shared by the editor's styled source mode (editor/highlight.ts)
// and the reading view's highlighted code blocks (render/rich/highlight.ts), so a code block looks
// the same in both modes. The colours are the theme tokens `--tok-*` (styles/tokens.css), applied by
// the `.cm-tok-*` rules in styles/editor.css.
import { tags as t, type Tag } from '@lezer/highlight';

export const CODE_TOKEN_STYLES: readonly { tag: Tag | readonly Tag[]; class: string }[] = [
  { tag: [t.propertyName, t.definition(t.propertyName)], class: 'cm-tok-property' },
  { tag: [t.keyword, t.operatorKeyword, t.modifier], class: 'cm-tok-keyword' },
  { tag: [t.string, t.special(t.string), t.regexp, t.character], class: 'cm-tok-string' },
  { tag: [t.number, t.bool, t.null, t.atom], class: 'cm-tok-number' },
  // `comment` covers line, block and doc comments, and the comments of legacy (stream) modes.
  { tag: t.comment, class: 'cm-tok-comment' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], class: 'cm-tok-function' },
  { tag: [t.typeName, t.className, t.namespace], class: 'cm-tok-type' },
  { tag: [t.variableName, t.labelName], class: 'cm-tok-variable' },
  { tag: [t.tagName, t.angleBracket], class: 'cm-tok-tag' },
  { tag: t.attributeName, class: 'cm-tok-attribute' },
  { tag: t.invalid, class: 'cm-tok-invalid' },
];
