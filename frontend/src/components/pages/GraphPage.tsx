// `/x/graph` (ROADMAP item 16, DESIGN §6.28): the global graph of every note and link, with
// Obsidian's filters, color groups, display and force settings in a panel over the graph.
import { Settings2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { errorMessage } from '../../api/client';
import { GraphCanvas } from '../graph/GraphCanvas';
import { GraphControls } from '../graph/GraphControls';
import { useBreakpoint } from '../layout/useBreakpoint';
import { buildView, graphFolders, graphTags, groupColors } from '../../features/graph/model';
import { openGraphNode } from '../../features/graph/open';
import { DEFAULT_GRAPH_OPTIONS } from '../../features/graph/options';
import { useGraphOptions } from '../../features/graph/store';
import { useGraphData } from '../../features/graph/useGraphData';
import { usePageTitle } from './usePageTitle';
import '../graph/graph.css';

export default function GraphPage() {
  usePageTitle('Graph');
  const phone = useBreakpoint() === 'phone';
  const { base, loading, error } = useGraphData();
  const o = useGraphOptions((s) => s.global);
  const setGlobal = useGraphOptions((s) => s.setGlobal);
  const replaceGlobal = useGraphOptions((s) => s.replaceGlobal);
  const [controlsOpen, setControlsOpen] = useState(!phone);

  const { search, showTags, showAttachments, hideUnresolved, showOrphans, folder, tag } = o;
  const view = useMemo(
    () => (base ? buildView(base, { search, showTags, showAttachments, hideUnresolved, showOrphans, folder, tag }) : null),
    [base, search, showTags, showAttachments, hideUnresolved, showOrphans, folder, tag],
  );
  const groups = o.colorGroups;
  const colors = useMemo(() => (view ? groupColors(view.nodes, groups) : []), [view, groups]);
  const { showArrow, textFadeMultiplier, nodeSizeMultiplier, lineSizeMultiplier } = o;
  const display = useMemo(
    () => ({ showArrow, textFadeMultiplier, nodeSizeMultiplier, lineSizeMultiplier }),
    [showArrow, textFadeMultiplier, nodeSizeMultiplier, lineSizeMultiplier],
  );
  const { centerStrength, repelStrength, linkStrength, linkDistance } = o;
  const forces = useMemo(() => ({ centerStrength, repelStrength, linkStrength, linkDistance }), [centerStrength, repelStrength, linkStrength, linkDistance]);
  const folders = useMemo(() => (base ? graphFolders(base) : []), [base]);
  const tags = useMemo(() => (base ? graphTags(base) : []), [base]);

  const notes = view ? view.nodes.filter((n) => n.type === 'note').length : 0;
  const links = view ? view.links.length / 3 : 0;
  const empty = base !== null && base.nodes.every((n) => n.type !== 'note');

  let body;
  if (error && !base)
    body = (
      <div className="graph-message" role="alert">
        The graph could not be loaded: {errorMessage(error)}
      </div>
    );
  else if (loading || !view)
    body = (
      <div className="graph-message" aria-busy="true">
        Loading the graph…
      </div>
    );
  else if (empty) body = <div className="graph-message">No notes yet: notes and the links between them appear here.</div>;
  else
    body = (
      <GraphCanvas
        view={view}
        groupColors={colors}
        display={display}
        forces={forces}
        onOpen={(node) => openGraphNode(base, node)}
        label={`Graph of ${notes} notes and ${links} links`}
      />
    );

  return (
    <div className="graph-page graph-view">
      {body}
      {view && !empty && (
        <div className="graph-stats" aria-live="polite">
          {notes.toLocaleString()} {notes === 1 ? 'note' : 'notes'} · {links.toLocaleString()} {links === 1 ? 'link' : 'links'}
        </div>
      )}
      {controlsOpen ? (
        <GraphControls
          options={o}
          onChange={setGlobal}
          onReset={() => replaceGlobal({ ...DEFAULT_GRAPH_OPTIONS, colorGroups: o.colorGroups })}
          onClose={() => setControlsOpen(false)}
          folders={folders}
          tags={tags}
        />
      ) : (
        <button type="button" className="graph-settings-toggle graph-icon-button" aria-label="Graph settings" title="Graph settings" onClick={() => setControlsOpen(true)}>
          <Settings2 size={18} aria-hidden />
        </button>
      )}
    </div>
  );
}
