// Converting an unlinked mention into a link (API.md §15.5). An open DocumentSession is edited in
// place (an ordinary, undoable edit that autosaves); otherwise the source note is read, checked,
// spliced and saved with its version. Server offsets are mapped for CRLF sessions (§1.4).
import { isVersionConflict } from '../api/client';
import { api } from '../api/endpoints';
import { currentSettings, currentTree } from '../api/hooks';
import { queryClient } from '../api/queryClient';
import { queryKeys } from '../api/queryKeys';
import type { BacklinkGroup, LinkStyle, Mention } from '../api/types';
import type { LinkIndex } from './links';
import { linkText } from './links';
import { serverToDocOffset, toLf } from './eol';
import type { DocumentSession } from '../sync/DocumentSession';
import { documents } from '../sync/instance';
import { applyWriteResult } from '../sync/treePatch';

/** The link that replaces `matched`, in the configured style (§15.5 step 4). */
export function mentionLink(targetPath: string, source: string, matched: string, format: 'shortest' | 'relative' | 'absolute', style: LinkStyle, index: LinkIndex): string {
  const text = linkText(targetPath, source, format, style, index);
  if (style === 'markdown') return `[${matched}](${text})`;
  return text === matched ? `[[${text}]]` : `[[${text}|${matched}]]`;
}

export type LinkMentionResult = 'linked' | 'stale';

/**
 * Applies the conversion to an open session; 'stale' when its text no longer matches. Server
 * offsets count every `` of the file. The session's eol maps them for LF and all-CRLF files;
 * a file with mixed line endings (its eol is LF, yet some breaks were CRLF) needs `raw`, the
 * server's content at `sourceVersion`, which maps them exactly.
 */
export function linkMentionInSession(session: DocumentSession, sourceVersion: string, mention: Pick<Mention, 'from' | 'to' | 'matched'>, link: string, raw?: string): LinkMentionResult {
  const snapshot = session.getSnapshot();
  if (snapshot.version !== sourceVersion || !session.isEditable()) return 'stale';
  const text = session.getText();
  let from: number;
  let to: number;
  if (raw !== undefined) {
    if (toLf(raw) !== text || raw.slice(mention.from, mention.to) !== mention.matched) return 'stale';
    from = toLf(raw.slice(0, mention.from)).length;
    to = from + toLf(mention.matched).length;
  } else {
    from = serverToDocOffset(text, mention.from, snapshot.eol);
    to = serverToDocOffset(text, mention.to, snapshot.eol);
  }
  if (text.slice(from, to) !== toLf(mention.matched)) return 'stale';
  session.applyEdit({ from, to, insert: link });
  return 'linked';
}

export async function linkMention(targetPath: string, group: BacklinkGroup, mention: Mention): Promise<LinkMentionResult> {
  const settings = currentSettings().files;
  const style: LinkStyle = settings.useWikilinks ? 'wiki' : 'markdown';
  const link = mentionLink(targetPath, group.source, mention.matched, settings.newLinkFormat, style, currentTree().links);
  const session = documents.get(group.source);
  let result: LinkMentionResult;
  if (session) {
    result = linkMentionInSession(session, group.sourceVersion, mention, link);
    // Mixed line endings: the server's raw text maps its offsets onto the (unchanged) session.
    if (result === 'stale' && session.getSnapshot().version === group.sourceVersion && !session.hasUnsavedChanges()) {
      const file = await api.readFile(group.source);
      if (file.version === group.sourceVersion) result = linkMentionInSession(session, group.sourceVersion, mention, link, file.content);
    }
  } else {
    const file = await api.readFile(group.source);
    if (file.version !== group.sourceVersion || file.content.slice(mention.from, mention.to) !== mention.matched) {
      result = 'stale';
    } else {
      const content = file.content.slice(0, mention.from) + link + file.content.slice(mention.to);
      try {
        const saved = await api.saveFile(group.source, { content, baseVersion: file.version });
        applyWriteResult(queryClient, saved, content);
        result = 'linked';
      } catch (e) {
        if (!isVersionConflict(e)) throw e;
        result = 'stale';
      }
    }
  }
  if (result === 'stale') void queryClient.invalidateQueries({ queryKey: queryKeys.backlinksAll() });
  return result;
}
