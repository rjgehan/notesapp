// Backlinks (DESIGN §6.2, API.md §11.2): linked mentions, and unlinked mentions (fetched when
// expanded) with a Link action that turns a plain-text mention into a link (§15.5).
import { ChevronRight, FileText, Link2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { errorMessage } from '../../api/client';
import { useBacklinks } from '../../api/hooks';
import type { BacklinkGroup, Mention } from '../../api/types';
import { afterOpen, isKeyboardClick } from '../../features/focus';
import { linkMention } from '../../features/mentions';
import { navigateTo } from '../../features/navigation';
import { displayName, folderOf, noteRoute } from '../../features/paths';
import { toast } from '../../state/toasts';
import { useUi } from '../../state/ui';
import { HighlightedText } from '../HighlightedText';
import { toastError } from '../../features/errors';

function openMention(source: string, mention: Mention, e: { detail: number }): void {
  useUi.getState().setSheetOpen(false);
  afterOpen(source, isKeyboardClick(e));
  navigateTo(noteRoute(source) + `?line=${mention.line}`);
}

function Group({ group, targetPath, unlinked }: { group: BacklinkGroup; targetPath: string; unlinked: boolean }) {
  const [busy, setBusy] = useState<number | null>(null);
  const link = async (mention: Mention, index: number) => {
    setBusy(index);
    try {
      const result = await linkMention(targetPath, group, mention);
      if (result === 'stale') toast(`${displayName(group.source)} changed; the mentions were refreshed`);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(null);
    }
  };
  const folder = folderOf(group.source);
  return (
    <li className="backlink-group">
      <button type="button" className="backlink-source" title={group.source} onClick={(e) => openMention(group.source, group.mentions[0], e)}>
        <FileText size={14} aria-hidden />
        <span className="backlink-source-name">{displayName(group.source)}</span>
        {folder && <span className="backlink-source-folder">{folder}</span>}
      </button>
      <ul className="backlink-mentions">
        {group.mentions.map((m, i) => (
          <li key={`${m.from}-${i}`} className="backlink-mention">
            <button type="button" className="backlink-context" onClick={(e) => openMention(group.source, m, e)}>
              <HighlightedText text={m.context} ranges={[m.contextRange]} />
            </button>
            {unlinked && (
              <button type="button" className="button button-small backlink-link" disabled={busy !== null} onClick={() => void link(m, i)} title={`Link “${m.matched}” to ${displayName(targetPath)}`}>
                <Link2 size={13} aria-hidden /> Link
              </button>
            )}
          </li>
        ))}
      </ul>
    </li>
  );
}

function Section({ title, count, open, onToggle, children }: { title: string; count: number | null; open: boolean; onToggle(): void; children: ReactNode }) {
  return (
    <section className="backlink-section">
      <button type="button" className="backlink-section-header" aria-expanded={open} onClick={onToggle}>
        <ChevronRight size={14} className={`tree-chevron${open ? ' is-open' : ''}`} aria-hidden />
        <span>{title}</span>
        {count !== null && <span className="backlink-count">{count}</span>}
      </button>
      {open && children}
    </section>
  );
}

function Backlinks({ path }: { path: string }) {
  const [linkedOpen, setLinkedOpen] = useState(true);
  const [unlinkedOpen, setUnlinkedOpen] = useState(false);
  const linked = useBacklinks(path, false);
  const unlinked = useBacklinks(path, true, unlinkedOpen);
  const linkedGroups = linked.data?.linked ?? [];
  const unlinkedGroups = unlinked.data?.unlinked ?? [];
  const countOf = (groups: BacklinkGroup[]) => groups.reduce((n, g) => n + g.mentions.length, 0);
  return (
    <div className="backlinks">
      <Section title="Linked mentions" count={linked.data ? countOf(linkedGroups) : null} open={linkedOpen} onToggle={() => setLinkedOpen(!linkedOpen)}>
        {linked.isPending ? (
          <div className="panel-empty">Loading…</div>
        ) : linked.isError ? (
          <div className="panel-empty">{errorMessage(linked.error)}</div>
        ) : linkedGroups.length === 0 ? (
          <div className="panel-empty">No backlinks found.</div>
        ) : (
          <ul className="backlink-groups">
            {linkedGroups.map((g) => (
              <Group key={g.source} group={g} targetPath={path} unlinked={false} />
            ))}
          </ul>
        )}
      </Section>
      <Section title="Unlinked mentions" count={unlinked.data ? countOf(unlinkedGroups) : null} open={unlinkedOpen} onToggle={() => setUnlinkedOpen(!unlinkedOpen)}>
        {unlinked.isPending ? (
          <div className="panel-empty">Loading…</div>
        ) : unlinked.isError ? (
          <div className="panel-empty">{errorMessage(unlinked.error)}</div>
        ) : unlinkedGroups.length === 0 ? (
          <div className="panel-empty">No unlinked mentions found.</div>
        ) : (
          <ul className="backlink-groups">
            {unlinkedGroups.map((g) => (
              <Group key={g.source} group={g} targetPath={path} unlinked />
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

export default function BacklinksPanel({ activePath }: { activePath: string | null }) {
  if (!activePath) return <div className="panel-empty">Open a note to see its backlinks.</div>;
  return <Backlinks key={activePath} path={activePath} />;
}
