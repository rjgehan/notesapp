import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import type { Settings, SettingsResponse, SettingsUpdateRequest } from '../api/types';
import { DEFAULT_SETTINGS } from './settings';
import { applyDelta, SettingsWriter, WRITE_DEBOUNCE_MS } from './settingsWriter';

/** A settings endpoint with the version protocol and 60 ms of latency. */
function server() {
  let version = 1;
  let settings: Settings = structuredClone(DEFAULT_SETTINGS);
  const response = (): SettingsResponse => ({ settings: structuredClone(settings), version: `v${version}`, readOnly: false });
  let cache: SettingsResponse | undefined = response();
  const notices: Array<[string, string]> = [];
  const drafts: Array<Settings | null> = [];
  const put = vi.fn(async (req: SettingsUpdateRequest) => {
    await new Promise((r) => setTimeout(r, 60));
    if (req.baseVersion !== `v${version}`) {
      throw new ApiError({ type: 'urn:notesapp:problem:version-conflict', title: 'conflict', status: 409, code: 'version-conflict' });
    }
    settings = structuredClone(req.settings);
    version++;
    return response();
  });
  const writer = new SettingsWriter({
    current: () => cache,
    put,
    refetch: async () => (cache = response()),
    store: (saved) => (cache = saved),
    valid: () => true,
    onDraft: (d) => drafts.push(d),
    onSaving: () => {},
    notify: (message, kind) => notices.push([message, kind]),
    onError: (e) => {
      throw e;
    },
  });
  return {
    writer,
    put,
    notices,
    drafts,
    get settings() {
      return settings;
    },
    /** Another device writes. */
    foreign(change: (s: Settings) => void) {
      change(settings);
      version++;
    },
    view: () => writer.draft ?? cache!.settings,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('SettingsWriter', () => {
  it('two quick toggles both land, with no false "changed on another device" (FE-6)', async () => {
    const s = server();
    const first = { ...s.view(), files: { ...s.view().files, useWikilinks: false } };
    s.writer.update(first, true);
    await vi.advanceTimersByTimeAsync(20);
    const second = { ...first, files: { ...first.files, autoUpdateLinks: false } };
    s.writer.update(second, true);
    await vi.advanceTimersByTimeAsync(500);
    expect(s.settings.files).toMatchObject({ useWikilinks: false, autoUpdateLinks: false });
    expect(s.notices).toEqual([]);
    expect(s.put.mock.calls.map((c) => c[0].baseVersion)).toEqual(['v1', 'v2']);
    expect(s.writer.draft).toBeNull();
  });

  it('a real change from another device keeps both changes (FE-6)', async () => {
    const s = server();
    s.foreign((x) => (x.editor.readableLineLength = false));
    s.writer.update({ ...s.view(), files: { ...s.view().files, useWikilinks: false } }, true);
    await vi.advanceTimersByTimeAsync(500);
    expect(s.settings.files.useWikilinks).toBe(false);
    expect(s.settings.editor.readableLineLength).toBe(false);
    expect(s.notices.map(([m]) => m)).toEqual([expect.stringContaining('applied on top')]);
  });

  it('a debounced edit is written once typing pauses, staying on the page', async () => {
    const s = server();
    s.writer.update({ ...s.view(), templates: { ...s.view().templates, timeFormat: 'HH:mm:ss' } }, false);
    await vi.advanceTimersByTimeAsync(WRITE_DEBOUNCE_MS + 200);
    expect(s.settings.templates.timeFormat).toBe('HH:mm:ss');
    expect(s.put).toHaveBeenCalledTimes(1);
    expect(s.writer.draft).toBeNull();
  });

  it('a debounced edit is written when the page is left within the debounce (FE-7)', async () => {
    const s = server();
    s.writer.update({ ...s.view(), templates: { ...s.view().templates, folder: 'Tpl' } }, false);
    await vi.advanceTimersByTimeAsync(100);
    // Leaving Settings.
    s.writer.setAttached(false);
    void s.writer.flush();
    await vi.advanceTimersByTimeAsync(WRITE_DEBOUNCE_MS + 200);
    expect(s.settings.templates.folder).toBe('Tpl');
    expect(s.put).toHaveBeenCalledTimes(1);
  });
});

describe('applyDelta', () => {
  it('takes only the fields that were edited', () => {
    const base = DEFAULT_SETTINGS;
    const edited = { ...base, files: { ...base.files, useWikilinks: !base.files.useWikilinks } };
    const theirs = { ...base, editor: { ...base.editor, defaultMode: 'read' as const } };
    expect(applyDelta(base, edited, theirs)).toEqual({ ...theirs, files: { ...theirs.files, useWikilinks: !base.files.useWikilinks } });
  });
});
