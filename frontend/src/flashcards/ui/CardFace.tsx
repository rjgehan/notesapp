// One side of a card, rendered like the reading view (DESIGN §6.7): links, tags, images and
// embeds work, and links open their note.
import { MarkdownSnippet } from '../../render/MarkdownSnippet';

export function CardFace({ markdown, path, className }: { markdown: string; path: string; className?: string }) {
  return <MarkdownSnippet markdown={markdown} path={path} className={`fc-face${className ? ' ' + className : ''}`} />;
}
