// Backlinks (DESIGN §6.2, API.md §11.2): linked mentions, and unlinked mentions (fetched when
// expanded) with a Link action that turns a plain-text mention into a link (§15.5). Links to
// blocks of the note (`[[Note#^id]]`, ROADMAP item 20) are marked, and the blocks they name are
// listed above them with their text (DESIGN §6.37).
import { ChevronRight, FileText, Link2 } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { errorMessage } from '../../api/client';
import { useBacklinks, useTextFile } from '../../api/hooks';
import { findBlock, linkedBlockId, scanBlocks } from '../../features/blocks';
import { toLf } from '../../features/eol';
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
              {!unlinked && <BlockChip raw={m.matched} />}
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

function BlockChip({ raw }: { raw: string }) {
  const id = linkedBlockId(raw);
  return id ? <span className="backlink-block-chip">^{id}</span> : null;
}

interface LinkedBlock {
  id: string;
  count: number;
}

/** The blocks of the note that links name, with how many links name each. */
function linkedBlocks(groups: BacklinkGroup[]): LinkedBlock[] {
  const counts = new Map<string, LinkedBlock>();
  for (const g of groups) {
    for (const m of g.mentions) {
      const id = linkedBlockId(m.matched);
      if (!id) continue;
      const key = id.toLowerCase();
      const entry = counts.get(key) ?? { id, count: 0 };
      entry.count++;
      counts.set(key, entry);
    }
  }
  return [...counts.values()];
}

/** "Linked blocks": each block of this note that other notes link to, with its text. */
function LinkedBlocks({ path, blocks }: { path: string; blocks: LinkedBlock[] }) {
  const file = useTextFile(path.toLowerCase().endsWith('.md') ? path : null);
  const scanned = useMemo(() => (file.data ? scanBlocks(toLf(file.data.content)) : null), [file.data]);
  const open = (id: string, e: { detail: number }) => {
    useUi.getState().setSheetOpen(false);
    afterOpen(path, isKeyboardClick(e));
    navigateTo(noteRoute(path, '^' + id));
  };
  return (
    <ul className="backlink-blocks" aria-label="Linked blocks">
      {blocks.map((b) => {
        const block = scanned ? findBlock(scanned, b.id) : null;
        return (
          <li key={b.id}>
            <button type="button" className="backlink-block" onClick={(e) => open(b.id, e)} title={`Go to block ^${b.id}`}>
              <span className="backlink-block-chip">^{b.id}</span>
              <span className={`backlink-block-text${block || !scanned ? '' : ' muted'}`}>{block ? block.text : scanned ? 'Not in this note' : ''}</span>
              <span className="backlink-count">{b.count}</span>
            </button>
          </li>
        );
      })}
    </ul>
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
  const blocks = useMemo(() => linkedBlocks(linked.data?.linked ?? []), [linked.data]);
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
          <>
            {blocks.length > 0 && <LinkedBlocks path={path} blocks={blocks} />}
            <ul className="backlink-groups">
              {linkedGroups.map((g) => (
                <Group key={g.source} group={g} targetPath={path} unlinked={false} />
              ))}
            </ul>
          </>
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
