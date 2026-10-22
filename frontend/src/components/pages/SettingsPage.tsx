// `/settings` and `/settings/<section>` (DESIGN §5.12, §6.4), a lazy chunk. Vault settings are
// written with the version protocol (`PUT /api/settings {settings, baseVersion}`); "This device"
// holds the per-device preferences and the recently discarded edits.
import { ArrowLeft, Copy, Info, Laptop, RotateCcw, Trash2, TriangleAlert } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation } from 'react-router';
import { errorMessage } from '../../api/client';
import { api } from '../../api/endpoints';
import { useMe, useSettings, useStatus, useTree } from '../../api/hooks';
import { queryClient } from '../../api/queryClient';
import { queryKeys, STALE } from '../../api/queryKeys';
import type { FolderTemplate, Settings, SettingsResponse } from '../../api/types';
import { unsupportedTokens } from '../../features/dates';
import { formatBytes, formatDateTime, formatRelative } from '../../features/format';
import { formatLimit } from '../../features/largeFiles';
import { mirrorSummary } from '../../features/mirror';
import { openPath } from '../../features/navigation';
import { displayName, newNameError, pathSafetyError } from '../../features/paths';
import { DEFAULT_SETTINGS } from '../../features/settings';
import { vimAvailable } from '../../editor/vimMode';
import { clearOfflineCopies, noteCache } from '../../offline/offlineStore';
import { setOfflineMedia } from '../../pwa/serviceWorker';
import { pageBuild } from '../../state/buildCheck';
import { ENCRYPTION_LOCK_CHOICES, usePrefs, type SyntaxVisibility, type ThemePref } from '../../state/prefs';
import { toast } from '../../state/toasts';
import { useUi } from '../../state/ui';
import type { DiscardedRecord } from '../../sync/drafts';
import { documents, draftStore } from '../../sync/instance';
import { useBreakpoint } from '../layout/useBreakpoint';
import { CaptureSettings } from '../capture/CaptureSettings';
import { PublishSettings } from '../publish/PublishSettings';
import { OrphanDraftList } from '../OrphanDrafts';
import { HotkeysSection } from './HotkeysSection';
import { usePageTitle } from './usePageTitle';
import { toastError } from '../../features/errors';
import { SettingsWriter } from '../../features/settingsWriter';
import { setTranscribeNewRecordings, useVoice } from '../../features/voice/voiceNotes';
import { fetchAiStatus } from '../../features/ai/aiClient';
import { AI_STATUS_KEY } from '../../features/ai/run';
import { REMINDERS_STATUS_KEY, remindersApi } from '../../features/reminders/client';
import { pushSupport, removeDevice, subscribeThisDevice, thisDeviceId, unsubscribeThisDevice, type PushSupport } from '../../features/reminders/device';
import { deviceZone, reportZone } from '../../features/reminders/register';
import type { ReminderRouteId } from '../../api/types';

const SECTIONS = [
  { id: 'files', title: 'Files and links' },
  { id: 'daily', title: 'Daily notes' },
  { id: 'templates', title: 'Templates' },
  { id: 'editor', title: 'Editor' },
  { id: 'hotkeys', title: 'Hotkeys' },
  { id: 'capture', title: 'Quick capture' },
  { id: 'ai', title: 'Ask and summaries' },
  { id: 'reminders', title: 'Reminders' },
  { id: 'publish', title: 'Publishing' },
  { id: 'device', title: 'This device' },
  { id: 'about', title: 'About' },
] as const;

type SectionId = (typeof SECTIONS)[number]['id'];

// ---------- validation (API.md §5) ----------

function folderError(value: string): string | null {
  if (value === '') return null;
  const err = pathSafetyError(value);
  return err ? `Not a valid folder path: ${err.toLowerCase()}` : null;
}

function formatError(value: string): string | null {
  if (value.length < 1 || value.length > 100) return 'Use 1 to 100 characters';
  const bad = unsupportedTokens(value);
  return bad ? `The token “${bad}” formats differently from Obsidian; avoid it` : null;
}

/** API.md §5: at most 100 rules, valid paths (an empty template is an unused row), one rule per folder. */
function folderTemplatesError(rules: FolderTemplate[]): string | null {
  if (rules.length > 100) return 'At most 100 folder templates';
  const seen = new Set<string>();
  for (const [i, r] of rules.entries()) {
    const err = folderError(r.folder) ?? (r.template === '' ? null : pathSafetyError(r.template));
    if (err) return `Folder template ${i + 1}: ${err}`;
    if (seen.has(r.folder)) return `Folder template ${i + 1}: “${r.folder || 'Every folder'}” already has a template`;
    seen.add(r.folder);
  }
  return null;
}

function validate(s: Settings): Record<string, string> {
  const errors: Record<string, string> = {};
  const add = (key: string, msg: string | null) => {
    if (msg) errors[key] = msg;
  };
  add('newNoteFolder', folderError(s.files.newNoteFolder));
  add('attachmentFolder', folderError(s.files.attachmentFolder));
  add('attachmentSubfolder', s.files.attachmentSubfolder === '' ? 'A folder name is required' : newNameError(s.files.attachmentSubfolder));
  add('dailyFolder', folderError(s.dailyNotes.folder));
  add('dailyTemplate', s.dailyNotes.template === '' ? null : pathSafetyError(s.dailyNotes.template));
  add('dailyFormat', s.dailyNotes.format.length < 1 || s.dailyNotes.format.length > 100 ? 'Use 1 to 100 characters' : null);
  add('templatesFolder', folderError(s.templates.folder));
  add('dateFormat', s.templates.dateFormat.length < 1 || s.templates.dateFormat.length > 100 ? 'Use 1 to 100 characters' : null);
  add('timeFormat', s.templates.timeFormat.length < 1 || s.templates.timeFormat.length > 100 ? 'Use 1 to 100 characters' : null);
  add('folderTemplates', folderTemplatesError(s.templates.folderTemplates));
  const paths = s.files.excludedPaths;
  if (paths.length > 100) add('excludedPaths', 'At most 100 paths');
  else add('excludedPaths', paths.map((p) => pathSafetyError(p)).find((e) => e) ?? null);
  if (s.ai) {
    const aiPaths = s.ai.excludedPaths;
    if (aiPaths.length > 100) add('aiExcludedPaths', 'At most 100 paths');
    else add('aiExcludedPaths', aiPaths.map((p) => pathSafetyError(p)).find((e) => e) ?? null);
    if (!Number.isInteger(s.ai.maxContextChars) || s.ai.maxContextChars < 4000 || s.ai.maxContextChars > 400000) add('aiMaxContext', 'Use 4,000 to 400,000 characters');
    if (!Number.isFinite(s.ai.monthlyBudgetUsd) || s.ai.monthlyBudgetUsd <= 0 || s.ai.monthlyBudgetUsd > 10000) add('aiBudget', 'Use an amount above $0 and at most $10,000');
  }
  if (s.reminders) add('reminderTime', /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(s.reminders.dailyNoteTime) ? null : 'Use a time such as 09:00');
  return errors;
}


// ---------- vault settings writer ----------

function useSettingsDraft(response: SettingsResponse | undefined) {
  const [draft, setDraft] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [writer] = useState(
    () =>
      new SettingsWriter({
        current: () => queryClient.getQueryData<SettingsResponse>(queryKeys.settings()),
        put: (req) => api.putSettings(req),
        refetch: () => queryClient.fetchQuery({ queryKey: queryKeys.settings(), queryFn: () => api.getSettings(), staleTime: 0 }),
        store: (saved) => queryClient.setQueryData(queryKeys.settings(), saved),
        valid: (s) => Object.keys(validate(s)).length === 0,
        onDraft: setDraft,
        onSaving: setSaving,
        notify: (message, kind) => toast(message, { kind }),
        onError: (e) => toastError(e),
      }),
  );
  const settings = draft ?? response?.settings ?? DEFAULT_SETTINGS;

  useEffect(() => {
    writer.setAttached(true);
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') void writer.flush();
    };
    const onPageHide = () => void writer.flush();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      // Writes outlive the page (a debounced edit is sent on leaving); the form state does not.
      writer.setAttached(false);
      // Leaving Settings within the debounce sends the edit instead of dropping it.
      void writer.flush();
    };
  }, [writer]);

  return { settings, update: (next: Settings, immediate: boolean) => writer.update(next, immediate), saving, dirty: draft !== null };
}

// ---------- controls ----------

function Row({ label, description, error, warning, children }: { label: string; description?: ReactNode; error?: string; warning?: string | null; children: ReactNode }) {
  return (
    <div className="setting-row">
      <div className="setting-info">
        <div className="setting-label">{label}</div>
        {description && <div className="setting-description">{description}</div>}
        {error && <div className="field-error">{error}</div>}
        {!error && warning && <div className="field-warning">{warning}</div>}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}

/**
 * A text field. With `trim` (folder and file paths), the field keeps exactly what is typed, so a
 * space between words survives, and the setting receives the trimmed value.
 */
export function TextSetting({ value, onChange, disabled, placeholder, label, trim = false }: { value: string; onChange(v: string): void; disabled: boolean; placeholder?: string; label: string; trim?: boolean }) {
  const [text, setText] = useState(value);
  const [shown, setShown] = useState(value);
  if (value !== shown) {
    // A change from outside (saved, another device) replaces the text; this field's own trimmed
    // value does not.
    setShown(value);
    if ((trim ? text.trim() : text) !== value) setText(value);
  }
  return (
    <input
      className="text-input"
      value={text}
      placeholder={placeholder}
      disabled={disabled}
      aria-label={label}
      onChange={(e) => {
        setText(e.target.value);
        onChange(trim ? e.target.value.trim() : e.target.value);
      }}
      autoCapitalize="off"
      autoCorrect="off"
      spellCheck={false}
    />
  );
}

function Toggle({ checked, onChange, disabled, label }: { checked: boolean; onChange(v: boolean): void; disabled?: boolean; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className={`toggle${checked ? ' is-on' : ''}`} disabled={disabled} onClick={() => onChange(!checked)}>
      <span className="toggle-knob" />
    </button>
  );
}

function Select<T extends string>({ value, options, onChange, disabled, label }: { value: T; options: Array<[T, string]>; onChange(v: T): void; disabled?: boolean; label: string }) {
  return (
    <select className="select" value={value} disabled={disabled} aria-label={label} onChange={(e) => onChange(e.target.value as T)}>
      {options.map(([v, text]) => (
        <option key={v} value={v}>
          {text}
        </option>
      ))}
    </select>
  );
}

// ---------- sections ----------

export interface VaultSectionProps {
  settings: Settings;
  set(next: Settings, immediate?: boolean): void;
  disabled: boolean;
  errors: Record<string, string>;
}

function FilesSection({ settings: s, set, disabled, errors }: VaultSectionProps) {
  const f = s.files;
  const files = (patch: Partial<Settings['files']>, immediate = true) => set({ ...s, files: { ...f, ...patch } }, immediate);
  return (
    <>
      <Row label="Default location for new notes" description="Where New note and links to missing notes create notes.">
        <Select
          label="Default location for new notes"
          value={f.newNoteLocation}
          disabled={disabled}
          options={[
            ['root', 'Vault root'],
            ['current', 'Same folder as the current note'],
            ['folder', 'In the folder below'],
          ]}
          onChange={(v) => files({ newNoteLocation: v })}
        />
      </Row>
      {f.newNoteLocation === 'folder' && (
        <Row label="Folder for new notes" error={errors.newNoteFolder}>
          <TextSetting label="Folder for new notes" value={f.newNoteFolder} disabled={disabled} placeholder="Inbox" trim onChange={(v) => files({ newNoteFolder: v }, false)} />
        </Row>
      )}
      <Row label="New link format" description="Shortest uses the bare name when it is unique.">
        <Select
          label="New link format"
          value={f.newLinkFormat}
          disabled={disabled}
          options={[
            ['shortest', 'Shortest path when possible'],
            ['relative', 'Relative path to the note'],
            ['absolute', 'Absolute path in the vault'],
          ]}
          onChange={(v) => files({ newLinkFormat: v })}
        />
      </Row>
      <Row label="Use [[Wikilinks]]" description="Off: links are written as Markdown links [text](path.md).">
        <Toggle label="Use wikilinks" checked={f.useWikilinks} disabled={disabled} onChange={(v) => files({ useWikilinks: v })} />
      </Row>
      <Row label="Automatically update internal links" description="Rewrite links when a file is renamed or moved.">
        <Toggle label="Automatically update internal links" checked={f.autoUpdateLinks} disabled={disabled} onChange={(v) => files({ autoUpdateLinks: v })} />
      </Row>
      <Row label="Default location for attachments">
        <Select
          label="Default location for attachments"
          value={f.attachmentLocation}
          disabled={disabled}
          options={[
            ['folder', 'In the folder below'],
            ['root', 'Vault root'],
            ['current', 'Same folder as the current note'],
            ['subfolder', 'In a subfolder of the current folder'],
          ]}
          onChange={(v) => files({ attachmentLocation: v })}
        />
      </Row>
      {f.attachmentLocation === 'folder' && (
        <Row label="Attachment folder" error={errors.attachmentFolder}>
          <TextSetting label="Attachment folder" value={f.attachmentFolder} disabled={disabled} trim onChange={(v) => files({ attachmentFolder: v }, false)} />
        </Row>
      )}
      {f.attachmentLocation === 'subfolder' && (
        <Row label="Attachment subfolder name" error={errors.attachmentSubfolder}>
          <TextSetting label="Attachment subfolder name" value={f.attachmentSubfolder} disabled={disabled} trim onChange={(v) => files({ attachmentSubfolder: v }, false)} />
        </Row>
      )}
      <Row label="Excluded files" description="One folder or file path per line. Hidden from search and unlinked mentions." error={errors.excludedPaths}>
        <textarea
          className="text-input"
          rows={3}
          aria-label="Excluded files"
          disabled={disabled}
          defaultValue={f.excludedPaths.join('\n')}
          onChange={(e) =>
            files(
              {
                // "Archive/" means the folder, which the server spells "Archive" (it matches the
                // entry itself and everything under it).
                excludedPaths: e.target.value
                  .split('\n')
                  .map((l) => l.trim().replace(/\/+$/, ''))
                  .filter(Boolean),
              },
              false,
            )
          }
        />
      </Row>
    </>
  );
}

function DailySection({ settings: s, set, disabled, errors }: VaultSectionProps) {
  const d = s.dailyNotes;
  const daily = (patch: Partial<Settings['dailyNotes']>, immediate = true) => set({ ...s, dailyNotes: { ...d, ...patch } }, immediate);
  const warning = unsupportedTokens(d.format) ? formatError(d.format) : null;
  return (
    <>
      <Row label="Date format" description={<>Moment.js tokens, e.g. YYYY-MM-DD. A “/” creates subfolders.</>} error={errors.dailyFormat} warning={warning}>
        <TextSetting label="Daily note date format" value={d.format} disabled={disabled} onChange={(v) => daily({ format: v }, false)} />
      </Row>
      <Row label="New file location" error={errors.dailyFolder}>
        <TextSetting label="Daily note folder" value={d.folder} disabled={disabled} placeholder="Vault root" trim onChange={(v) => daily({ folder: v }, false)} />
      </Row>
      <Row label="Template file location" description="A note rendered into each new daily note." error={errors.dailyTemplate}>
        <TextSetting label="Daily note template" value={d.template} disabled={disabled} placeholder="Templates/Daily note.md" trim onChange={(v) => daily({ template: v }, false)} />
      </Row>
      <Row label="Open daily note on startup">
        <Toggle label="Open daily note on startup" checked={d.openOnStartup} disabled={disabled} onChange={(v) => daily({ openOnStartup: v })} />
      </Row>
    </>
  );
}

function TemplatesSection({ settings: s, set, disabled, errors }: VaultSectionProps) {
  const t = s.templates;
  const templates = (patch: Partial<Settings['templates']>) => set({ ...s, templates: { ...t, ...patch } }, false);
  return (
    <>
      <Row label="Template folder location" error={errors.templatesFolder}>
        <TextSetting label="Template folder" value={t.folder} disabled={disabled} placeholder="Templates" trim onChange={(v) => templates({ folder: v })} />
      </Row>
      <Row label="Date format" description="Used by {{date}}." error={errors.dateFormat} warning={unsupportedTokens(t.dateFormat) ? formatError(t.dateFormat) : null}>
        <TextSetting label="Template date format" value={t.dateFormat} disabled={disabled} onChange={(v) => templates({ dateFormat: v })} />
      </Row>
      <Row label="Time format" description="Used by {{time}}." error={errors.timeFormat} warning={unsupportedTokens(t.timeFormat) ? formatError(t.timeFormat) : null}>
        <TextSetting label="Template time format" value={t.timeFormat} disabled={disabled} onChange={(v) => templates({ timeFormat: v })} />
      </Row>
      <FolderTemplates settings={s} set={set} disabled={disabled} errors={errors} />
    </>
  );
}

/** Folder templates (ROADMAP item 30): a folder and a template per row. */
function FolderTemplates({ settings: s, set, disabled, errors }: VaultSectionProps) {
  const t = s.templates;
  const rules = t.folderTemplates;
  const update = (next: FolderTemplate[], immediate = false) => set({ ...s, templates: { ...t, folderTemplates: next } }, immediate);
  const change = (i: number, patch: Partial<FolderTemplate>) => update(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <>
      <Row
        label="Folder templates"
        description={<>A new note created in a folder starts from its template; the deepest folder wins. An empty folder means every folder.</>}
        error={errors.folderTemplates}
      >
        <button type="button" className="button" disabled={disabled || rules.length >= 100} onClick={() => update([...rules, { folder: '', template: '' }], true)}>
          Add folder template
        </button>
      </Row>
      {rules.length > 0 && (
        <ul className="folder-templates">
          {rules.map((r, i) => (
            <li key={i} className="folder-template">
              <TextSetting label={`Folder of folder template ${i + 1}`} value={r.folder} disabled={disabled} placeholder="Every folder" trim onChange={(v) => change(i, { folder: v })} />
              <TextSetting label={`Template of folder template ${i + 1}`} value={r.template} disabled={disabled} placeholder="Templates/Meeting.md" trim onChange={(v) => change(i, { template: v })} />
              <button type="button" className="icon-button" aria-label={`Remove folder template ${i + 1}`} title="Remove" disabled={disabled} onClick={() => update(rules.filter((_, j) => j !== i), true)}>
                <Trash2 size={16} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function EditorSection({ settings: s, set, disabled }: VaultSectionProps) {
  const e = s.editor;
  const editor = (patch: Partial<Settings['editor']>) => set({ ...s, editor: { ...e, ...patch } });
  return (
    <>
      <Row label="Default view for new tabs">
        <Select
          label="Default view"
          value={e.defaultMode}
          disabled={disabled}
          options={[
            ['edit', 'Live Preview (editing)'],
            ['read', 'Locked (reading)'],
          ]}
          onChange={(v) => editor({ defaultMode: v })}
        />
      </Row>
      <Row label="Readable line length" description="Limit the line width of notes.">
        <Toggle label="Readable line length" checked={e.readableLineLength} disabled={disabled} onChange={(v) => editor({ readableLineLength: v })} />
      </Row>
      <Row label="Strict line breaks" description="Off (as in Obsidian): a single line break shows as a line break in embedded notes. A note itself always shows its lines as typed.">
        <Toggle label="Strict line breaks" checked={e.strictLineBreaks} disabled={disabled} onChange={(v) => editor({ strictLineBreaks: v })} />
      </Row>
    </>
  );
}

/** A number field that keeps what is typed and passes on the number (NaN while it is not one). */
function NumberSetting({ value, onChange, disabled, label, step, min }: { value: number; onChange(v: number): void; disabled: boolean; label: string; step: number; min: number }) {
  const [text, setText] = useState(String(value));
  const [shown, setShown] = useState(value);
  if (value !== shown) {
    setShown(value);
    if (Number(text) !== value) setText(String(value));
  }
  return (
    <input
      className="text-input setting-number"
      type="number"
      inputMode="decimal"
      step={step}
      min={min}
      value={text}
      disabled={disabled}
      aria-label={label}
      onChange={(e) => {
        setText(e.target.value);
        onChange(e.target.value.trim() === '' ? Number.NaN : Number(e.target.value));
      }}
    />
  );
}

const AI_PROVIDERS: Array<['claude-code' | 'api', string]> = [
  ['claude-code', 'Claude Code (your Claude subscription)'],
  ['api', 'Anthropic API (API key, billed per token)'],
];

const AI_MODELS: Array<[string, string]> = [
  ['claude-sonnet-5-5', 'Claude Sonnet 5.5 (recommended)'],
  ['claude-opus-5-5', 'Claude Opus 5.5 (best answers, twice the price)'],
  ['claude-haiku-5-5', 'Claude Haiku 5.5 (fastest, cheapest)'],
];

function AiSection({ settings: s, set, disabled, errors }: VaultSectionProps) {
  const a = s.ai ?? DEFAULT_SETTINGS.ai;
  const ai = (patch: Partial<Settings['ai']>, immediate = true) => set({ ...s, ai: { ...a, ...patch } }, immediate);
  const status = useQuery({ queryKey: AI_STATUS_KEY, queryFn: fetchAiStatus, staleTime: 10_000 });
  const aiJson = JSON.stringify(s.ai ?? null);
  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: AI_STATUS_KEY });
  }, [aiJson]);
  const st = status.data;
  return (
    <>
      <div className="banner banner-info ai-privacy" role="note">
        <Info size={14} aria-hidden />
        <span>
          Ask your vault, summaries and suggestions are written by Claude, Anthropic’s AI. When you use them, your question and the text of the notes it needs <strong>leave your tailnet</strong> for Anthropic, through Claude Code with your Claude subscription (the default; it counts against your plan’s usage limits) or through the Anthropic API (billed per token). Nothing is sent until you ask, and notes in the excluded folders below never are. Conversations stay on the device that had them.
        </span>
      </div>
      <Row label="Use Claude" description="Off by default. The server also needs the provider’s credential: a Claude Code token or an Anthropic API key (CASAOS.md or DEPLOY.md, “Ask your vault”).">
        <Toggle label="Use Claude for Ask and summaries" checked={a.enabled} disabled={disabled} onChange={(v) => ai({ enabled: v })} />
      </Row>
      <Row label="Provider" description="Claude Code runs on the server with your Claude Pro or Max subscription, for your personal use. The API needs a key and is billed per token.">
        <Select label="Provider" value={a.provider ?? 'claude-code'} disabled={disabled} options={AI_PROVIDERS} onChange={(v) => ai({ provider: v })} />
      </Row>
      <Row label="Model" description="Sonnet answers well for everyday questions. Opus is slower and costs twice as much.">
        <Select label="Model" value={a.model} disabled={disabled} options={AI_MODELS} onChange={(v) => ai({ model: v })} />
      </Row>
      <Row label="Never send" description="One folder or file path per line. These notes are never read for Claude; the excluded files of Files and links never are either." error={errors.aiExcludedPaths}>
        <textarea
          className="text-input"
          rows={3}
          aria-label="Folders never sent to Claude"
          disabled={disabled}
          defaultValue={a.excludedPaths.join('\n')}
          onChange={(e) =>
            ai(
              {
                excludedPaths: e.target.value
                  .split('\n')
                  .map((l) => l.trim().replace(/\/+$/, ''))
                  .filter(Boolean),
              },
              false,
            )
          }
        />
      </Row>
      <Row label="Context per request" description="The most characters of note text one request carries, earlier turns included (about 4 characters per token)." error={errors.aiMaxContext}>
        <NumberSetting label="Context per request in characters" value={a.maxContextChars} step={1000} min={4000} disabled={disabled} onChange={(v) => ai({ maxContextChars: v }, false)} />
      </Row>
      <Row label="Monthly budget (USD)" description="Requests stop once this month’s estimated spend reaches it: what the API bills, or with Claude Code the API value of your usage (it counts against your plan, not your card)." error={errors.aiBudget}>
        <NumberSetting label="Monthly budget in US dollars" value={a.monthlyBudgetUsd} step={1} min={0.5} disabled={disabled} onChange={(v) => ai({ monthlyBudgetUsd: v }, false)} />
      </Row>
      <dl className="about-list">
        <div className="about-row">
          <dt>Status</dt>
          <dd>{st ? (st.state === 'ready' ? (st.fake ? 'Ready (fake answers: development server)' : 'Ready') : (st.reason ?? st.state)) : status.isError ? errorMessage(status.error) : 'Loading…'}</dd>
        </div>
        {st && (
          <>
            <div className="about-row">
              <dt>{st.provider === 'api' ? 'API key' : 'Claude Code'}</dt>
              <dd>{st.fake ? 'Not needed: this development server gives fake answers' : st.provider !== 'api' && !st.cliInstalled ? 'The Claude Code CLI is not installed on the server' : st.keyPresent ? `${st.provider === 'api' ? 'Key' : 'Token'} found in ${st.keyFile}` : `Missing: put one in the server’s ${st.keyFile} file (CASAOS.md or DEPLOY.md, “Ask your vault”)`}</dd>
            </div>
            <div className="about-row">
              <dt>This month ({st.month})</dt>
              <dd>
                ${st.monthCostUsd.toFixed(2)} of ${st.monthlyBudgetUsd.toFixed(2)} · {st.monthRequests} {st.monthRequests === 1 ? 'request' : 'requests'} (estimated)
              </dd>
            </div>
          </>
        )}
      </dl>
    </>
  );
}

// ---------- reminders (ROADMAP item 9, DESIGN §6.38) ----------

function TestButton({ route, deviceId, label = 'Send a test' }: { route: ReminderRouteId; deviceId?: string; label?: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="button button-small"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        remindersApi
          .test({ route, deviceId })
          .then((r) => toast(r.sent ? 'Test reminder sent' : `Not sent: ${r.error ?? 'unknown error'}`, { kind: r.sent ? 'success' : 'error' }))
          .catch((e: unknown) => toastError(e))
          .finally(() => {
            setBusy(false);
            void queryClient.invalidateQueries({ queryKey: REMINDERS_STATUS_KEY });
          });
      }}
    >
      {label}
    </button>
  );
}

function notificationPermission(): NotificationPermission | 'unsupported' {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}

function thisDeviceText(support: PushSupport, subscribed: boolean, permission: NotificationPermission | 'unsupported'): string {
  if (support === 'ios-needs-install') return 'Add NotesApp to the Home Screen (Share › Add to Home Screen), open it from there, then come back here.';
  if (support !== 'supported') return 'This browser cannot receive Web Push.';
  if (subscribed) return 'Subscribed: reminders arrive here.';
  if (permission === 'denied') return 'Notifications are blocked for NotesApp in this browser’s settings.';
  return 'Not subscribed.';
}

function permissionText(permission: NotificationPermission | 'unsupported'): string {
  if (permission === 'granted') return 'Allowed in this browser.';
  if (permission === 'denied') return 'Blocked in this browser’s settings.';
  if (permission === 'unsupported') return 'This browser shows the message only.';
  return 'Not asked yet.';
}

export function RemindersSection({ settings: s, set, disabled, errors }: VaultSectionProps) {
  const r = s.reminders ?? DEFAULT_SETTINGS.reminders;
  const rem = (patch: Partial<Settings['reminders']>, immediate = true) => set({ ...s, reminders: { ...r, ...patch } }, immediate);
  const status = useQuery({ queryKey: REMINDERS_STATUS_KEY, queryFn: remindersApi.status, staleTime: 5_000 });
  const st = status.data;
  const [busy, setBusy] = useState(false);
  const [permission, setPermission] = useState(notificationPermission);
  const [myDevice, setMyDevice] = useState(thisDeviceId);
  const support = pushSupport();
  const refresh = () => void queryClient.invalidateQueries({ queryKey: REMINDERS_STATUS_KEY });
  const subscribed = !!myDevice && !!st?.webPush.devices.some((d) => d.id === myDevice);
  const zone = deviceZone();

  const toggleThisDevice = () => {
    setBusy(true);
    (subscribed ? unsubscribeThisDevice() : subscribeThisDevice().then(() => undefined))
      .then(() => toast(subscribed ? 'This device no longer receives reminders' : 'This device now receives reminders', { kind: 'success' }))
      .catch((e: unknown) => toast(e instanceof Error ? e.message : errorMessage(e), { kind: 'error' }))
      .finally(() => {
        setBusy(false);
        setMyDevice(thisDeviceId());
        setPermission(notificationPermission());
        refresh();
      });
  };

  return (
    <>
      <p className="setting-note">
        <Info size={14} aria-hidden /> Task reminders (set in a task’s details) and the daily-note nudge reach you through the routes switched on here. A reminder counts as delivered once one of them takes it; reminders missed while the server was down follow when it starts.
      </p>

      <h3 className="settings-subtitle">Web Push</h3>
      <Row label="Send by Web Push" description="To the devices below, even with NotesApp closed. On iPhone and iPad this needs iOS 16.4 or later and NotesApp added to the Home Screen. Each message is encrypted for its device; Apple, Google or Mozilla only relay it.">
        <Toggle label="Send reminders by Web Push" checked={r.webPush} disabled={disabled} onChange={(v) => rem({ webPush: v })} />
      </Row>
      {st && !st.webPush.available && <p className="field-error">{st.webPush.reason}</p>}
      <Row label="This device" description={thisDeviceText(support, subscribed, permission)}>
        <button type="button" className="button button-small" disabled={busy || support !== 'supported' || (st !== undefined && !st.webPush.available)} onClick={toggleThisDevice}>
          {subscribed ? 'Unsubscribe' : 'Subscribe this device'}
        </button>
      </Row>
      {st && st.webPush.devices.length > 0 && (
        <ul className="discarded-list" aria-label="Subscribed devices">
          {st.webPush.devices.map((d) => (
            <li key={d.id} className="discarded-item">
              <div className="discarded-head">
                <span className="discarded-name">
                  {d.name}
                  {d.id === myDevice && <span className="muted"> (this device)</span>}
                </span>
                <span className="muted">{d.lastSuccessAt ? `last reminder ${formatRelative(d.lastSuccessAt)}` : `added ${formatRelative(d.createdAt)}`}</span>
              </div>
              {d.lastError && <p className="field-error">{d.lastError}</p>}
              <div className="discarded-actions">
                <TestButton route="webPush" deviceId={d.id} />
                <button
                  type="button"
                  className="button button-small"
                  aria-label={`Remove ${d.name}`}
                  onClick={() =>
                    void removeDevice(d.id)
                      .catch((e: unknown) => toastError(e))
                      .finally(() => {
                        setMyDevice(thisDeviceId());
                        refresh();
                      })
                  }
                >
                  <Trash2 size={14} aria-hidden /> Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <h3 className="settings-subtitle">ntfy</h3>
      <Row label="Send through ntfy" description="To the ntfy app, with the server and topic of the server’s ntfy.json (CASAOS.md or DEPLOY.md, “Reminders”).">
        <Toggle label="Send reminders through ntfy" checked={r.ntfy} disabled={disabled} onChange={(v) => rem({ ntfy: v })} />
      </Row>
      <Row label="Title only" description="Send the task’s title and nothing else. With ntfy.sh the message leaves your tailnet; turn this off only with your own ntfy server.">
        <Toggle label="Send only the task title through ntfy" checked={r.ntfyTitleOnly} disabled={disabled} onChange={(v) => rem({ ntfyTitleOnly: v })} />
      </Row>
      <Row label="ntfy server" description={st ? (st.ntfy.configured ? `Configured: ${st.ntfy.server ?? ''}${st.ntfy.ownTopic ? ', with its own reminders topic' : ''}` : (st.ntfy.reason ?? 'Not configured')) : 'Loading…'}>
        <TestButton route="ntfy" />
      </Row>

      <h3 className="settings-subtitle">In the app</h3>
      <Row label="Show in open tabs" description="A message in every open NotesApp tab, and a system notification where this browser allows it. Nothing arrives while every tab is closed.">
        <Toggle label="Show reminders in open tabs" checked={r.inApp} disabled={disabled} onChange={(v) => rem({ inApp: v })} />
      </Row>
      <Row label="Browser notifications" description={permissionText(permission)}>
        <div className="setting-buttons">
          {permission === 'default' && (
            <button type="button" className="button button-small" onClick={() => void Notification.requestPermission().then(() => setPermission(notificationPermission()))}>
              Allow
            </button>
          )}
          <TestButton route="inApp" />
        </div>
      </Row>

      <h3 className="settings-subtitle">Daily note</h3>
      <Row label="Daily-note nudge" description="A reminder at this time when today’s daily note does not exist yet." error={errors.reminderTime}>
        <div className="setting-buttons">
          <input type="time" className="text-input" aria-label="Daily-note nudge time" value={r.dailyNoteTime} disabled={disabled} onChange={(e) => e.target.value && rem({ dailyNoteTime: e.target.value.slice(0, 5) }, false)} />
          <Toggle label="Daily-note nudge" checked={r.dailyNote} disabled={disabled} onChange={(v) => rem({ dailyNote: v })} />
        </div>
      </Row>

      <h3 className="settings-subtitle">Status</h3>
      <dl className="about-list">
        <div className="about-row">
          <dt>Time zone</dt>
          <dd>
            {st ? `${st.zone}${st.zoneReported ? '' : ' (the server’s: no device reported one yet)'}` : 'Loading…'}
            {st && zone && zone !== st.zone && (
              <>
                {' · '}
                <button
                  type="button"
                  className="button button-small"
                  onClick={() => {
                    reportZone();
                    setTimeout(refresh, 500);
                  }}
                >
                  Use this device’s ({zone})
                </button>
              </>
            )}
          </dd>
        </div>
        <div className="about-row">
          <dt>Last delivered</dt>
          <dd>{st?.lastDeliveredAt ? formatDateTime(st.lastDeliveredAt) : 'Nothing yet'}</dd>
        </div>
        {st?.lastError && (
          <div className="about-row">
            <dt>Last problem</dt>
            <dd>{`${st.lastError}${st.lastErrorAt ? ` (${formatRelative(st.lastErrorAt)})` : ''}`}</dd>
          </div>
        )}
        <div className="about-row">
          <dt>Next</dt>
          <dd>{st ? (st.upcoming.length === 0 ? 'No upcoming reminders' : st.upcoming.map((u) => `${u.title} (${u.at.replace('T', ' ')})`).join(' · ')) : status.isError ? errorMessage(status.error) : 'Loading…'}</dd>
        </div>
      </dl>
    </>
  );
}

const REASONS: Record<DiscardedRecord['reason'], string> = {
  'take-theirs': 'replaced by Take theirs',
  discard: 'discarded',
  'superseded-draft': 'older unsaved draft',
  'orphaned-draft': 'unsaved draft of a moved or deleted note',
};

function DiscardedEdits() {
  const [items, setItems] = useState<DiscardedRecord[] | null>(null);
  const [failed, setFailed] = useState(false);
  const tree = useTree().data;

  useEffect(() => {
    let cancelled = false;
    draftStore.listDiscarded().then(
      (list) => !cancelled && setItems(list),
      () => !cancelled && setFailed(true),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const take = async (item: DiscardedRecord) => {
    await draftStore.takeDiscarded(item.id).catch(() => null);
    setItems((list) => list?.filter((i) => i.id !== item.id) ?? null);
  };

  const copy = async (item: DiscardedRecord) => {
    try {
      await navigator.clipboard.writeText(item.text);
      toast('Copied to the clipboard');
    } catch {
      toast('The browser refused clipboard access', { kind: 'error' });
    }
  };

  const restore = async (item: DiscardedRecord) => {
    openPath(item.path);
    const session = documents.acquire(item.path, 'settings-restore');
    try {
      // An ordinary local edit: it autosaves, and Mod-Z brings back what the note had. Reopening a
      // note whose load failed reads it again first.
      if (!(await session.restoreText(item.text))) {
        // Nothing landed (offline, still failing to load, read-only): the record stays.
        toast(`${displayName(item.path)} cannot be edited right now. Open it when it can, then restore.`, { kind: 'error' });
        return;
      }
      await take(item);
      toast(`Restored the discarded text into ${displayName(item.path)}`);
    } finally {
      documents.release(session, 'settings-restore');
    }
  };

  if (failed) return <p className="field-error">This browser does not allow local storage, so discarded edits are not kept.</p>;
  if (items === null) return <p className="muted">Loading…</p>;
  if (items.length === 0) return <p className="muted">No edits were discarded on this device in the last 7 days.</p>;
  return (
    <ul className="discarded-list">
      {items.map((item) => (
        <li key={item.id} className="discarded-item">
          <div className="discarded-head">
            <span className="discarded-name">{displayName(item.path)}</span>
            <span className="muted">
              {REASONS[item.reason]} · <time title={formatDateTime(item.at)}>{formatRelative(item.at)}</time>
            </span>
          </div>
          <pre className="discarded-preview">{item.text.slice(0, 280)}{item.text.length > 280 ? '…' : ''}</pre>
          <div className="discarded-actions">
            <button type="button" className="button button-small" onClick={() => void copy(item)}>
              <Copy size={13} aria-hidden /> Copy
            </button>
            {tree?.byPath.has(item.path) && (
              <button type="button" className="button button-small" onClick={() => void restore(item)}>
                <RotateCcw size={13} aria-hidden /> Restore into note
              </button>
            )}
            <button type="button" className="button button-small" onClick={() => void take(item)}>
              <Trash2 size={13} aria-hidden /> Forget
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Turns the device's offline copies on or off; off removes them (drafts are kept). */
function setOfflineCopies(enabled: boolean): void {
  usePrefs.getState().update({ offlineNotes: enabled });
  setOfflineMedia(enabled);
  if (!enabled) void clearOfflineCopies().catch((e: unknown) => toastError(e));
}

function OfflineCopiesInfo({ enabled }: { enabled: boolean }) {
  const [kept, setKept] = useState<{ notes: number; chars: number } | null>(null);
  const [seq, setSeq] = useState(0);
  useEffect(() => {
    let cancelled = false;
    noteCache.index().then(
      (list) => !cancelled && setKept({ notes: list.length, chars: list.reduce((n, e) => n + e.chars, 0) }),
      () => !cancelled && setKept(null),
    );
    return () => {
      cancelled = true;
    };
  }, [enabled, seq]);
  return (
    <>
      The last 100 notes you opened, the notes list and note images stay on this device, so they open without a connection; edits made
      offline sync when it returns.
      {kept && kept.notes > 0 && (
        <>
          {' '}
          {kept.notes} {kept.notes === 1 ? 'note is' : 'notes are'} kept ({formatBytes(kept.chars)}).{' '}
          <button
            type="button"
            className="link-button"
            onClick={() =>
              void clearOfflineCopies().then(
                () => {
                  setSeq((n) => n + 1);
                  toast('Removed the offline copies from this device');
                },
                (e: unknown) => toastError(e),
              )
            }
          >
            Remove them
          </button>
        </>
      )}
    </>
  );
}

function DeviceSection() {
  const prefs = usePrefs();
  const draftsFailing = useUi((s) => s.draftsFailing);
  return (
    <>
      <p className="setting-note">
        <Laptop size={14} aria-hidden /> These preferences apply to this browser only.
      </p>
      <Row label="Theme">
        <Select<ThemePref>
          label="Theme"
          value={prefs.theme}
          options={[
            ['dark', 'Dark'],
            ['light', 'Light'],
            ['system', 'Follow the system'],
          ]}
          onChange={(theme) => prefs.update({ theme })}
        />
      </Row>
      <Row label="Markdown syntax" description="In Live Preview: always hidden, or shown for the element you are editing.">
        <Select<SyntaxVisibility>
          label="Markdown syntax"
          value={prefs.syntaxVisibility}
          options={[
            ['hide-all', 'Hide all'],
            ['reveal-at-cursor', 'Reveal at cursor'],
          ]}
          onChange={(syntaxVisibility) => prefs.update({ syntaxVisibility })}
        />
      </Row>
      <Row label="Spell check">
        <Toggle label="Spell check" checked={prefs.spellcheck} onChange={(spellcheck) => prefs.update({ spellcheck })} />
      </Row>
      <Row label="Autocorrect" description="On iPhone this also controls smart punctuation.">
        <Toggle label="Autocorrect" checked={prefs.autocorrect} onChange={(autocorrect) => prefs.update({ autocorrect })} />
      </Row>
      <Row label="Load remote images" description="Off: images from other sites show a placeholder until tapped.">
        <Toggle label="Load remote images" checked={prefs.loadRemoteImages} onChange={(loadRemoteImages) => prefs.update({ loadRemoteImages })} />
      </Row>
      <Row
        label="Vim key bindings"
        description={
          vimAvailable()
            ? 'Vim keys in the editor. :w saves, :q leaves the editor; the app’s hotkeys keep working. The mode shows in the status bar.'
            : 'Needs a keyboard with a mouse or trackpad; not used on a touch screen.'
        }
      >
        <Toggle label="Vim key bindings" checked={prefs.vimMode && vimAvailable()} disabled={!vimAvailable()} onChange={(vimMode) => prefs.update({ vimMode })} />
      </Row>
      <Row label="Keep recent notes for offline reading" description={<OfflineCopiesInfo enabled={prefs.offlineNotes} />}>
        <Toggle label="Keep recent notes for offline reading" checked={prefs.offlineNotes} onChange={(offlineNotes) => setOfflineCopies(offlineNotes)} />
      </Row>
      <VoiceRow />
      <Row label="Lock encrypted notes after" description="Unlocked encrypted notes and sections lock after this long without typing or tapping, and whenever the page reloads.">
        <Select<string>
          label="Lock encrypted notes after"
          value={String(prefs.encryptionLockMinutes)}
          options={ENCRYPTION_LOCK_CHOICES.map((m) => [String(m), m === 1 ? '1 minute' : `${m} minutes`])}
          onChange={(v) => prefs.update({ encryptionLockMinutes: Number(v) })}
        />
      </Row>
      <Row label="Lock encrypted notes when the app is hidden" description="Switching to another tab or app, or locking the phone, locks them at once.">
        <Toggle label="Lock encrypted notes when the app is hidden" checked={prefs.encryptionLockOnHide} onChange={(encryptionLockOnHide) => prefs.update({ encryptionLockOnHide })} />
      </Row>
      <h3 className="settings-subtitle">Recently discarded edits</h3>
      {draftsFailing && (
        <p className="field-error">
          <TriangleAlert size={13} aria-hidden /> Unsaved changes are not protected on this device: the browser refused to store drafts.
        </p>
      )}
      <OrphanDraftList />
      <DiscardedEdits />
    </>
  );
}

/** Voice notes (ROADMAP item 33): whether this device's recordings are transcribed, and by what. */
export function VoiceRow() {
  const transcribe = useVoice((s) => s.transcribe);
  const status = useQuery({ queryKey: queryKeys.transcription(), queryFn: () => api.getTranscriptionStatus(), staleTime: STALE.transcription }).data;
  const description = !status
    ? 'Voice notes are recorded with “Record voice note” (the microphone on the phone’s toolbar).'
    : status.enabled
      ? `New recordings are transcribed by ${status.service}, and the text is added under them.`
      : 'The server has no transcription service, so recordings are saved without text (DEPLOY.md, Voice notes).';
  return (
    <Row label="Transcribe voice notes" description={description}>
      <Toggle label="Transcribe voice notes" checked={transcribe} disabled={!status?.enabled} onChange={setTranscribeNewRecordings} />
    </Row>
  );
}

function AboutSection() {
  const status = useStatus().data;
  const me = useMe().data;
  const item = (label: string, value: ReactNode) => (
    <div className="about-row">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
  return (
    <dl className="about-list">
      {me && item('Signed in as', `${me.name} (${me.login})`)}
      {item('This page', <code>{pageBuild}</code>)}
      {status && (
        <>
          {item('Server', <code>{`${status.appVersion} · ${status.buildSha}`}</code>)}
          {item('Started', formatDateTime(status.startedAt))}
          {item('Vault', `${status.vault.notes} notes · ${status.vault.files} files · ${status.vault.folders} folders · ${formatBytes(status.vault.bytes)}`)}
          {item('History', status.git.enabled ? `${status.git.state}${status.git.lastCommitAt ? ` · last commit ${formatRelative(status.git.lastCommitAt)}` : ''}${status.git.lastError ? ` · ${status.git.lastError}` : ''}` : `disabled${status.git.reason ? `: ${status.git.reason}` : ''}`)}
          {status.git.enabled && status.disk.repoBytes !== null && item('History size', formatBytes(status.disk.repoBytes))}
          {status.git.enabled && status.git.largeFiles.limitBytes !== null &&
            item(
              'Kept out of history',
              `${status.git.largeFiles.files} ${status.git.largeFiles.files === 1 ? 'file' : 'files'} larger than ${formatLimit(status.git.largeFiles.limitBytes)}${status.git.largeFiles.files > 0 ? ` · ${formatBytes(status.git.largeFiles.bytes)}` : ''}`,
            )}
          {item('Mirror', mirrorSummary(status.mirror))}
          {item('File watcher', status.watcher.mode)}
          {item('Free disk space', formatBytes(status.disk.freeBytes))}
          {status.vault.skipped.length > 0 && item('Skipped files', status.vault.skipped.map((s) => `${s.name} (${s.reason})`).join(', '))}
        </>
      )}
      {item('Status page', <Link to="/x/status">Uptime, history, disk, backups and alerts</Link>)}
      {item('Compatibility report', <Link to="/x/compat">Obsidian settings, plugins and syntax this vault uses</Link>)}
    </dl>
  );
}

export default function SettingsPage() {
  usePageTitle('Settings');
  const location = useLocation();
  const phone = useBreakpoint() === 'phone';
  const query = useSettings();
  const newBuild = useUi((s) => s.newBuildAvailable);
  const { settings, update, saving } = useSettingsDraft(query.data);
  const segment = location.pathname.split('/')[2] ?? '';
  const section: SectionId | null = SECTIONS.some((s) => s.id === segment) ? (segment as SectionId) : phone ? null : 'files';
  const readOnly = query.data?.readOnly ?? false;
  const disabled = readOnly || newBuild || !query.data;
  const errors = validate(settings);
  const props: VaultSectionProps = { settings, set: (next, immediate = true) => update(next, immediate), disabled, errors };
  const title = SECTIONS.find((s) => s.id === section)?.title ?? 'Settings';

  return (
    <div className={`page settings-page${section === null ? ' is-index' : ''}`}>
      <nav className="settings-nav" aria-label="Settings sections">
        {phone && section === null && <h1 className="page-title">Settings</h1>}
        {SECTIONS.map((s) => (
          <NavLink key={s.id} to={`/settings/${s.id}`} replace={!phone} className={({ isActive }) => `settings-nav-item${isActive || (s.id === section && segment === '') ? ' is-active' : ''}`}>
            {s.title}
          </NavLink>
        ))}
      </nav>
      {section !== null && (
        <section className="settings-section" aria-labelledby="settings-section-title">
          <header className="page-header">
            {phone && (
              <NavLink to="/settings" className="icon-button" aria-label="All settings" title="All settings">
                <ArrowLeft size={18} />
              </NavLink>
            )}
            <h1 id="settings-section-title" className="page-title">
              {title}
            </h1>
            {saving && <span className="muted">Saving…</span>}
          </header>
          {section !== 'device' && section !== 'hotkeys' && section !== 'about' && section !== 'capture' && section !== 'publish' && (
            <>
              {readOnly && (
                <div className="banner banner-warning" role="status">
                  <Info size={14} aria-hidden /> Settings were written by a newer version of NotesApp and are read-only here.
                </div>
              )}
              {newBuild && (
                <div className="banner banner-info" role="status">
                  A new version is available. Reload before changing settings.
                </div>
              )}
              {query.isError && <p className="field-error">{errorMessage(query.error)}</p>}
            </>
          )}
          {section === 'files' && <FilesSection {...props} />}
          {section === 'daily' && <DailySection {...props} />}
          {section === 'templates' && <TemplatesSection {...props} />}
          {section === 'editor' && <EditorSection {...props} />}
          {section === 'hotkeys' && <HotkeysSection />}
          {section === 'capture' && <CaptureSettings />}
          {section === 'ai' && <AiSection {...props} />}
          {section === 'reminders' && <RemindersSection {...props} />}
          {section === 'publish' && <PublishSettings />}
          {section === 'device' && <DeviceSection />}
          {section === 'about' && <AboutSection />}
        </section>
      )}
    </div>
  );
}
