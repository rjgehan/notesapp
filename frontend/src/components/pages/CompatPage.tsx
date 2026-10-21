// `/x/compat` (ROADMAP item 24, DESIGN §6.22): how this vault, typically an imported Obsidian vault,
// works in NotesApp. Obsidian's settings next to NotesApp's (with "Apply"), its graph settings
// (for this device), the plugins it uses, then every finding by category, each occurrence opening
// the note at its line.
import { CircleAlert, CircleCheck, Info, RefreshCw, TriangleAlert } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { errorMessage, isProblem } from '../../api/client';
import { api } from '../../api/endpoints';
import { useSettings } from '../../api/hooks';
import { queryClient } from '../../api/queryClient';
import { queryKeys } from '../../api/queryKeys';
import type { CompatIssue, CompatPlugin, CompatReport, CompatSetting } from '../../api/types';
import { toastError } from '../../features/errors';
import { formatRelative } from '../../features/format';
import { optionsFromObsidian } from '../../features/graph/options';
import { useGraphOptions } from '../../features/graph/store';
import { navigateTo } from '../../features/navigation';
import { noteRoute } from '../../features/paths';
import { toast } from '../../state/toasts';
import { usePageTitle } from './usePageTitle';
import './compat.css';

const SEVERITY_ICON = { error: CircleAlert, warning: TriangleAlert, info: Info } as const;
const CATEGORIES: Array<{ id: CompatIssue['category']; title: string }> = [
  { id: 'syntax', title: 'Syntax and plugins in notes' },
  { id: 'links', title: 'Links' },
  { id: 'files', title: 'Files' },
];
const SUPPORT_LABEL: Record<CompatPlugin['status'], string> = {
  supported: 'Supported',
  partial: 'Partly',
  planned: 'Planned',
  unsupported: 'Not supported',
  unknown: 'Unknown',
};

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

function RoadmapBadge({ item }: { item: number | null }) {
  if (item === null) return null;
  return (
    <span className="compat-badge is-roadmap" title={`ROADMAP item ${item}`}>
      Roadmap {item}
    </span>
  );
}

function Section({ title, children, id }: { title: string; children: ReactNode; id: string }) {
  return (
    <section className="compat-section" aria-labelledby={id}>
      <h2 id={id} className="compat-section-title">
        {title}
      </h2>
      {children}
    </section>
  );
}

function openOccurrence(path: string, line: number | null): void {
  navigateTo(noteRoute(path) + (line !== null ? `?line=${line}` : ''));
}

function IssueCard({ issue }: { issue: CompatIssue }) {
  const Icon = SEVERITY_ICON[issue.severity];
  const where = issue.noteCount === 1 ? 'in 1 file' : `in ${issue.noteCount.toLocaleString()} files`;
  return (
    <details className={`compat-issue is-${issue.severity}`}>
      <summary className="compat-issue-summary">
        <Icon size={16} className="compat-issue-icon" aria-label={issue.severity} />
        <span className="compat-issue-title">{issue.title}</span>
        <span className="compat-issue-count">
          {issue.count.toLocaleString()} {where}
        </span>
        <RoadmapBadge item={issue.roadmapItem} />
      </summary>
      <p className="compat-issue-detail">{issue.detail}</p>
      <ul className="compat-occurrences">
        {issue.occurrences.map((o, i) => (
          <li key={`${o.path}:${o.line}:${i}`}>
            <a
              className="compat-occurrence"
              href={noteRoute(o.path)}
              onClick={(e) => {
                e.preventDefault();
                openOccurrence(o.path, o.line);
              }}
            >
              <span className="compat-occurrence-path">
                {o.path}
                {o.line !== null && <span className="compat-occurrence-line">:{o.line + 1}</span>}
              </span>
              {o.text !== o.path && <code className="compat-occurrence-text">{o.text}</code>}
            </a>
          </li>
        ))}
      </ul>
      {issue.truncated && <p className="compat-more">The first {issue.occurrences.length} are listed.</p>}
    </details>
  );
}

function SettingRow({ row }: { row: CompatSetting }) {
  return (
    <tr className={`compat-setting is-${row.status}`}>
      <th scope="row">
        <code>{row.source}</code>
        <div className="compat-setting-value">{row.obsidianValue}</div>
      </th>
      <td>
        {row.setting ? <code>{row.setting}</code> : '—'}
        {row.note && <div className="compat-setting-note">{row.note}</div>}
      </td>
      <td>{row.current ?? '—'}</td>
      <td>
        {row.status === 'different' ? (
          <span className="compat-proposed">{row.proposed}</span>
        ) : row.status === 'same' ? (
          <span className="compat-badge is-ok">In effect</span>
        ) : (
          <span className="compat-badge is-muted">Not used</span>
        )}
      </td>
    </tr>
  );
}

function ObsidianSettings({ report }: { report: CompatReport }) {
  const settings = useSettings();
  const [applying, setApplying] = useState(false);
  const different = report.settings.filter((s) => s.status === 'different').length;
  const readOnly = settings.data?.readOnly ?? false;
  const apply = async () => {
    if (!report.proposedSettings) return;
    setApplying(true);
    try {
      const saved = await api.putSettings({ settings: report.proposedSettings, baseVersion: report.settingsVersion });
      queryClient.setQueryData(queryKeys.settings(), saved);
      toast(`Applied ${plural(different, "Obsidian setting")}`);
    } catch (e) {
      if (isProblem(e, 'version-conflict')) toast('The settings changed meanwhile; the report was refreshed, check it and apply again', { kind: 'error' });
      else toastError(e);
    } finally {
      setApplying(false);
      void queryClient.invalidateQueries({ queryKey: queryKeys.compat() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.settings() });
    }
  };
  return (
    <Section title="Obsidian settings" id="compat-settings">
      <p className="compat-text">
        {different === 0
          ? 'NotesApp already uses every Obsidian setting it supports.'
          : `${plural(different, 'setting')} of .obsidian/ ${different === 1 ? 'differs' : 'differ'} from NotesApp's. A new installation takes them at its first start; apply them here to use them now.`}
      </p>
      {report.settings.length > 0 && (
        <div className="compat-table-wrap">
          <table className="compat-table">
            <thead>
              <tr>
                <th scope="col">Obsidian</th>
                <th scope="col">NotesApp setting</th>
                <th scope="col">Now</th>
                <th scope="col">With Obsidian's</th>
              </tr>
            </thead>
            <tbody>
              {report.settings.map((row) => (
                <SettingRow key={row.source} row={row} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {different > 0 && (
        <div className="compat-actions">
          <button type="button" className="button button-primary" disabled={applying || readOnly || !report.proposedSettings} onClick={() => void apply()}>
            {applying ? 'Applying…' : `Apply Obsidian's settings`}
          </button>
          {readOnly && <span className="compat-text">The settings are read-only (see Settings).</span>}
        </div>
      )}
    </Section>
  );
}

function GraphSettings({ graph }: { graph: Record<string, unknown> }) {
  const replaceGlobal = useGraphOptions((s) => s.replaceGlobal);
  const groups = Array.isArray(graph.colorGroups) ? graph.colorGroups.length : 0;
  return (
    <Section title="Graph view" id="compat-graph">
      <p className="compat-text">
        .obsidian/graph.json has Obsidian's graph settings{groups > 0 ? `, with ${plural(groups, 'color group')}` : ''}. Graph settings are kept per device in
        NotesApp.
      </p>
      <div className="compat-actions">
        <button
          type="button"
          className="button"
          onClick={() => {
            replaceGlobal(optionsFromObsidian(graph, useGraphOptions.getState().global));
            toast("This device's graph now uses Obsidian's settings");
          }}
        >
          Use them on this device
        </button>
      </div>
    </Section>
  );
}

function Plugins({ plugins }: { plugins: CompatPlugin[] }) {
  return (
    <Section title="Plugins" id="compat-plugins">
      <p className="compat-text">NotesApp does not run Obsidian plugins. This is what it offers for the ones this vault has turned on.</p>
      <ul className="compat-plugins">
        {plugins.map((p) => (
          <li key={`${p.kind}:${p.id}`} className={`compat-plugin is-${p.status}`}>
            <div className="compat-plugin-head">
              <span className="compat-plugin-name">{p.name}</span>
              <span className="compat-plugin-kind">{p.kind === 'core' ? 'Core' : 'Community'}</span>
              <span className={`compat-badge is-${p.status}`}>{SUPPORT_LABEL[p.status]}</span>
              <RoadmapBadge item={p.roadmapItem} />
            </div>
            <div className="compat-plugin-note">{p.note}</div>
          </li>
        ))}
      </ul>
    </Section>
  );
}

export default function CompatPage() {
  usePageTitle('Compatibility report');
  const report = useQuery({ queryKey: queryKeys.compat(), queryFn: () => api.getCompat(), staleTime: 0 });
  const data = report.data;

  let body: ReactNode;
  if (report.isPending) body = <p className="compat-text" aria-busy="true">Checking the vault…</p>;
  else if (!data)
    body = (
      <p className="compat-text" role="alert">
        The report could not be made: {errorMessage(report.error)}
      </p>
    );
  else {
    const { totals } = data;
    const clean = data.issues.length === 0;
    body = (
      <>
        <ul className="compat-summary" aria-label="Summary">
          <li className={totals.errors ? 'is-error' : 'is-ok'}>
            <CircleAlert size={16} aria-hidden /> {plural(totals.errors, 'error')}
          </li>
          <li className={totals.warnings ? 'is-warning' : 'is-ok'}>
            <TriangleAlert size={16} aria-hidden /> {plural(totals.warnings, 'warning')}
          </li>
          <li className="is-info">
            <Info size={16} aria-hidden /> {plural(totals.infos, 'notice')}
          </li>
          <li className="is-muted">
            {plural(totals.notes, 'note')}, {plural(totals.files, 'file')} · checked {formatRelative(data.generatedAt)} in {data.tookMs} ms
          </li>
        </ul>
        <p className="compat-text">
          {data.obsidian.found
            ? `This vault has Obsidian's settings folder (.obsidian/: ${data.obsidian.configFiles.join(', ') || 'nothing NotesApp reads'}). NotesApp reads it but never changes it, so the vault stays usable in Obsidian.`
            : 'This vault has no .obsidian/ folder, so there are no Obsidian settings to take over.'}
        </p>
        {data.obsidian.problems.length > 0 && (
          <ul className="compat-problems">
            {data.obsidian.problems.map((p) => (
              <li key={p}>
                <TriangleAlert size={14} aria-hidden /> {p}
              </li>
            ))}
          </ul>
        )}
        {data.obsidian.found && <ObsidianSettings report={data} />}
        {data.graph && <GraphSettings graph={data.graph} />}
        {data.plugins.length > 0 && <Plugins plugins={data.plugins} />}
        {clean ? (
          <p className="compat-clean">
            <CircleCheck size={16} aria-hidden /> Nothing to report: every note in this vault works in NotesApp.
          </p>
        ) : (
          CATEGORIES.map(({ id, title }) => {
            const issues = data.issues.filter((i) => i.category === id);
            if (issues.length === 0) return null;
            return (
              <Section key={id} title={title} id={`compat-${id}`}>
                {issues.map((issue) => (
                  <IssueCard key={issue.id} issue={issue} />
                ))}
              </Section>
            );
          })
        )}
      </>
    );
  }

  return (
    <div className="page compat-page">
      <header className="page-header">
        <h1 className="page-title">Compatibility report</h1>
        <button
          type="button"
          className="button"
          aria-label="Check again"
          title="Check again"
          disabled={report.isFetching}
          onClick={() => void report.refetch()}
        >
          <RefreshCw size={15} aria-hidden /> Check again
        </button>
      </header>
      {body}
    </div>
  );
}
