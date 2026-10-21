// The local graph (ROADMAP item 16, DESIGN §6.21): the open note and what is up to `depth` links
// away, in a sidebar panel (the bottom sheet on phones), following the open note. Color groups,
// display and forces come from the global graph's settings, so they are set up once.
import { Maximize2, SlidersHorizontal } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { GraphCanvas } from '../graph/GraphCanvas';
import { buildView, groupColors } from '../../features/graph/model';
import { openGraphNode } from '../../features/graph/open';
import { RANGES, type LocalGraphOptions } from '../../features/graph/options';
import { useGraphOptions } from '../../features/graph/store';
import { useGraphData } from '../../features/graph/useGraphData';
import { navigateTo } from '../../features/navigation';
import { useUi } from '../../state/ui';
import '../graph/graph.css';

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange(v: boolean): void }) {
  return (
    <label className="local-graph-check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

export default function LocalGraphPanel({ activePath }: { activePath: string | null }) {
  const { base, loading } = useGraphData();
  const o = useGraphOptions((s) => s.local);
  const setLocal = useGraphOptions((s) => s.setLocal);
  const global = useGraphOptions((s) => s.global);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const depthId = useId();

  const { depth, incoming, outgoing, neighborLinks, showTags, showAttachments, hideUnresolved } = o;
  const view = useMemo(() => {
    if (!base || !activePath) return null;
    return buildView(
      base,
      { search: '', showTags, showAttachments, hideUnresolved, showOrphans: true, folder: '', tag: '' },
      { path: activePath, depth, incoming, outgoing, neighborLinks },
    );
  }, [base, activePath, depth, incoming, outgoing, neighborLinks, showTags, showAttachments, hideUnresolved]);
  const groups = global.colorGroups;
  const colors = useMemo(() => (view ? groupColors(view.nodes, groups) : []), [view, groups]);
  const { textFadeMultiplier, nodeSizeMultiplier, lineSizeMultiplier } = global;
  const showArrow = global.showArrow || o.showArrow;
  const display = useMemo(
    () => ({ showArrow, textFadeMultiplier, nodeSizeMultiplier, lineSizeMultiplier }),
    [showArrow, textFadeMultiplier, nodeSizeMultiplier, lineSizeMultiplier],
  );
  const { centerStrength, repelStrength, linkStrength, linkDistance } = global;
  const forces = useMemo(() => ({ centerStrength, repelStrength, linkStrength, linkDistance }), [centerStrength, repelStrength, linkStrength, linkDistance]);

  const set = (patch: Partial<LocalGraphOptions>) => setLocal(patch);
  const openGlobal = () => {
    useUi.getState().setSheetOpen(false);
    navigateTo('/x/graph');
  };

  let body;
  if (!activePath) body = <div className="panel-empty">Open a note to see its local graph.</div>;
  else if (loading || !base) body = <div className="panel-empty">Loading…</div>;
  else if (!view || view.nodes.length === 0) body = <div className="panel-empty">This file is not in the graph.</div>;
  else
    body = (
      <GraphCanvas
        view={view}
        groupColors={colors}
        display={display}
        forces={forces}
        onOpen={(node) => openGraphNode(base, node)}
        label={`Local graph: ${view.nodes.length} nodes, ${view.links.length / 3} links`}
        compact
      />
    );

  return (
    <div className="local-graph graph-view">
      <div className="local-graph-toolbar">
        <label htmlFor={depthId} className="local-graph-depth">
          Depth <span className="graph-control-value">{depth}</span>
        </label>
        <input
          id={depthId}
          className="local-graph-depth-input"
          type="range"
          min={RANGES.depth[0]}
          max={RANGES.depth[1]}
          step={1}
          value={depth}
          onChange={(e) => set({ depth: Number(e.target.value) })}
        />
        <button
          type="button"
          className="graph-icon-button"
          aria-label="Local graph settings"
          title="Local graph settings"
          aria-expanded={settingsOpen}
          onClick={() => setSettingsOpen(!settingsOpen)}
        >
          <SlidersHorizontal size={15} aria-hidden />
        </button>
        <button type="button" className="graph-icon-button" aria-label="Open graph view" title="Open graph view" onClick={openGlobal}>
          <Maximize2 size={15} aria-hidden />
        </button>
      </div>
      {settingsOpen && (
        <div className="local-graph-settings">
          <Check label="Incoming links" checked={incoming} onChange={(v) => set({ incoming: v })} />
          <Check label="Outgoing links" checked={outgoing} onChange={(v) => set({ outgoing: v })} />
          <Check label="Neighbor links" checked={neighborLinks} onChange={(v) => set({ neighborLinks: v })} />
          <Check label="Tags" checked={showTags} onChange={(v) => set({ showTags: v })} />
          <Check label="Attachments" checked={showAttachments} onChange={(v) => set({ showAttachments: v })} />
          <Check label="Existing files only" checked={hideUnresolved} onChange={(v) => set({ hideUnresolved: v })} />
          <Check label="Arrows" checked={o.showArrow} onChange={(v) => set({ showArrow: v })} />
        </div>
      )}
      <div className="local-graph-body">{body}</div>
    </div>
  );
}
