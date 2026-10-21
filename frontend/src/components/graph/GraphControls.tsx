// The graph view's settings panel (ROADMAP item 16, DESIGN §6.21), laid out like Obsidian's:
// Filters, Groups, Display and Forces, each collapsible. Changes apply at once and are kept on
// this device.
import { Plus, RotateCcw, X } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { GROUP_PALETTE, RANGES, type GraphOptions } from '../../features/graph/options';

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange(v: boolean): void }) {
  return (
    <div className="graph-control-row">
      <span className="graph-control-label">{label}</span>
      <button type="button" role="switch" aria-checked={checked} aria-label={label} className={`toggle${checked ? ' is-on' : ''}`} onClick={() => onChange(!checked)}>
        <span className="toggle-knob" />
      </button>
    </div>
  );
}

function Slider({ label, value, range, onChange, format }: { label: string; value: number; range: readonly [number, number, number]; onChange(v: number): void; format?: (v: number) => string }) {
  const id = useId();
  return (
    <div className="graph-control-slider">
      <label htmlFor={id} className="graph-control-label">
        {label}
        <span className="graph-control-value">{format ? format(value) : value}</span>
      </label>
      <input id={id} type="range" min={range[0]} max={range[1]} step={range[2]} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  );
}

function Section({ title, children, open }: { title: string; children: ReactNode; open?: boolean }) {
  return (
    <details className="graph-section" open={open}>
      <summary className="graph-section-title">{title}</summary>
      <div className="graph-section-body">{children}</div>
    </details>
  );
}

const two = (v: number) => v.toFixed(2);

export interface GraphControlsProps {
  options: GraphOptions;
  onChange(patch: Partial<GraphOptions>): void;
  onReset(): void;
  onClose(): void;
  folders: readonly string[];
  tags: readonly string[];
}

export function GraphControls({ options: o, onChange, onReset, onClose, folders, tags }: GraphControlsProps) {
  const setGroup = (i: number, patch: Partial<GraphOptions['colorGroups'][number]>) =>
    onChange({ colorGroups: o.colorGroups.map((g, j) => (j === i ? { ...g, ...patch } : g)) });
  return (
    <aside className="graph-controls" aria-label="Graph settings">
      <div className="graph-controls-header">
        <button type="button" className="graph-icon-button" aria-label="Restore default settings" title="Restore default settings" onClick={onReset}>
          <RotateCcw size={15} aria-hidden />
        </button>
        <button type="button" className="graph-icon-button" aria-label="Close graph settings" title="Close" onClick={onClose}>
          <X size={16} aria-hidden />
        </button>
      </div>
      <Section title="Filters" open>
        <input
          className="graph-search"
          type="search"
          placeholder="Search files…"
          aria-label="Search files (tag:, path:, file:, -exclude)"
          title='Names, paths, aliases and tags: words, "phrases", tag:#x, path:x, file:x, -exclude'
          value={o.search}
          onChange={(e) => onChange({ search: e.target.value })}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
        />
        <Toggle label="Tags" checked={o.showTags} onChange={(v) => onChange({ showTags: v })} />
        <Toggle label="Attachments" checked={o.showAttachments} onChange={(v) => onChange({ showAttachments: v })} />
        <Toggle label="Existing files only" checked={o.hideUnresolved} onChange={(v) => onChange({ hideUnresolved: v })} />
        <Toggle label="Orphans" checked={o.showOrphans} onChange={(v) => onChange({ showOrphans: v })} />
        <div className="graph-control-row">
          <span className="graph-control-label">Folder</span>
          <select className="select graph-select" aria-label="Only notes in folder" value={o.folder} onChange={(e) => onChange({ folder: e.target.value })}>
            <option value="">All folders</option>
            {o.folder && !folders.includes(o.folder) && <option value={o.folder}>{o.folder}</option>}
            {folders.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </div>
        <div className="graph-control-row">
          <span className="graph-control-label">Tag</span>
          <select className="select graph-select" aria-label="Only notes with tag" value={o.tag} onChange={(e) => onChange({ tag: e.target.value })}>
            <option value="">Any tag</option>
            {o.tag && !tags.includes(o.tag) && <option value={o.tag}>#{o.tag}</option>}
            {tags.map((t) => (
              <option key={t} value={t}>
                #{t}
              </option>
            ))}
          </select>
        </div>
      </Section>
      <Section title="Groups">
        {o.colorGroups.map((g, i) => (
          <div className="graph-group" key={i}>
            <input type="color" className="graph-group-color" aria-label={`Group ${i + 1} color`} value={g.color} onChange={(e) => setGroup(i, { color: e.target.value })} />
            <input
              className="graph-group-query"
              type="text"
              placeholder="tag:#project, path:Daily…"
              aria-label={`Group ${i + 1} query`}
              value={g.query}
              onChange={(e) => setGroup(i, { query: e.target.value })}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
            <button type="button" className="graph-icon-button" aria-label={`Remove group ${i + 1}`} title="Remove group" onClick={() => onChange({ colorGroups: o.colorGroups.filter((_, j) => j !== i) })}>
              <X size={15} aria-hidden />
            </button>
          </div>
        ))}
        <button type="button" className="graph-new-group" onClick={() => onChange({ colorGroups: [...o.colorGroups, { query: '', color: GROUP_PALETTE[o.colorGroups.length % GROUP_PALETTE.length]! }] })}>
          <Plus size={15} aria-hidden /> New group
        </button>
      </Section>
      <Section title="Display">
        <Toggle label="Arrows" checked={o.showArrow} onChange={(v) => onChange({ showArrow: v })} />
        <Slider label="Text fade threshold" value={o.textFadeMultiplier} range={RANGES.textFadeMultiplier} onChange={(v) => onChange({ textFadeMultiplier: v })} format={(v) => v.toFixed(1)} />
        <Slider label="Node size" value={o.nodeSizeMultiplier} range={RANGES.nodeSizeMultiplier} onChange={(v) => onChange({ nodeSizeMultiplier: v })} format={(v) => v.toFixed(1)} />
        <Slider label="Link thickness" value={o.lineSizeMultiplier} range={RANGES.lineSizeMultiplier} onChange={(v) => onChange({ lineSizeMultiplier: v })} format={(v) => v.toFixed(1)} />
      </Section>
      <Section title="Forces">
        <Slider label="Center force" value={o.centerStrength} range={RANGES.centerStrength} onChange={(v) => onChange({ centerStrength: v })} format={two} />
        <Slider label="Repel force" value={o.repelStrength} range={RANGES.repelStrength} onChange={(v) => onChange({ repelStrength: v })} format={(v) => v.toFixed(1)} />
        <Slider label="Link force" value={o.linkStrength} range={RANGES.linkStrength} onChange={(v) => onChange({ linkStrength: v })} format={two} />
        <Slider label="Link distance" value={o.linkDistance} range={RANGES.linkDistance} onChange={(v) => onChange({ linkDistance: v })} format={(v) => String(Math.round(v))} />
      </Section>
    </aside>
  );
}
