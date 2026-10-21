// `/settings` and `/settings/<section>` (DESIGN §5.12, §6.4), a lazy chunk. Vault settings are
// written with the version protocol (`PUT /api/settings {settings, baseVersion}`); "This device"
// holds the per-device preferences and the recently discarded edits.
import { ArrowLeft, Copy, Info, Laptop, RotateCcw, Trash2, TriangleAlert } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router';
import { errorMessage } from '../../api/client';
import { api } from '../../api/endpoints';
import { useMe, useSettings, useStatus, useTree } from '../../api/hooks';
import { queryClient } from '../../api/queryClient';
import { queryKeys } from '../../api/queryKeys';
import type { Settings, SettingsResponse } from '../../api/types';
import { unsupportedTokens } from '../../features/dates';
import { formatBytes, formatDateTime, formatRelative } from '../../features/format';
import { openPath } from '../../features/navigation';
import { displayName, newNameError, pathSafetyError } from '../../features/paths';
import { DEFAULT_SETTINGS } from '../../features/settings';
import { pageBuild } from '../../state/buildCheck';
import { usePrefs, type SyntaxVisibility, type ThemePref } from '../../state/prefs';
import { toast } from '../../state/toasts';
import { useUi } from '../../state/ui';
import type { DiscardedRecord } from '../../sync/drafts';
import { documents, draftStore } from '../../sync/instance';
import { useBreakpoint } from '../layout/useBreakpoint';
import { OrphanDraftList } from '../OrphanDrafts';
import { usePageTitle } from './usePageTitle';
import { toastError } from '../../features/errors';
import { SettingsWriter } from '../../features/settingsWriter';

const SECTIONS = [
  { id: 'files', title: 'Files and links' },
  { id: 'daily', title: 'Daily notes' },
  { id: 'templates', title: 'Templates' },
  { id: 'editor', title: 'Editor' },
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
  const paths = s.files.excludedPaths;
  if (paths.length > 100) add('excludedPaths', 'At most 100 paths');
  else add('excludedPaths', paths.map((p) => pathSafetyError(p)).find((e) => e) ?? null);
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

interface VaultSectionProps {
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
          {item('File watcher', status.watcher.mode)}
          {item('Free disk space', formatBytes(status.disk.freeBytes))}
          {status.vault.skipped.length > 0 && item('Skipped files', status.vault.skipped.map((s) => `${s.name} (${s.reason})`).join(', '))}
        </>
      )}
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
          {section !== 'device' && section !== 'about' && (
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
          {section === 'device' && <DeviceSection />}
          {section === 'about' && <AboutSection />}
        </section>
      )}
    </div>
  );
}
