// Writes vault settings with the version protocol (API.md §5, DESIGN §5.12): `PUT /api/settings
// {settings, baseVersion}`. Writes are serialized: one request in flight, the newest edit queued
// behind it and sent with the version the previous write returned, so two quick changes never
// conflict with each other. A conflict is therefore a real change from another device: the edit
// is re-applied on top of the server's settings (only the fields this tab changed), once.
// Debounced edits are written when the page is left, never dropped.
import { isProblem } from '../api/client';
import type { Settings, SettingsResponse, SettingsUpdateRequest } from '../api/types';

export const WRITE_DEBOUNCE_MS = 600;

export interface SettingsWriterDeps {
  /** The cached settings (the server state this tab last saw). */
  current(): SettingsResponse | undefined;
  put(req: SettingsUpdateRequest): Promise<SettingsResponse>;
  /** Reads the server's settings now (after a conflict). */
  refetch(): Promise<SettingsResponse>;
  /** Caches the server's answer. */
  store(saved: SettingsResponse): void;
  /** True when `settings` passes validation (an invalid draft is shown, never sent). */
  valid(settings: Settings): boolean;
  /** The draft shown in the form (null: show the server's settings). */
  onDraft(draft: Settings | null): void;
  onSaving(saving: boolean): void;
  notify(message: string, kind: 'info' | 'error'): void;
  onError(error: unknown): void;
}

const SECTIONS = ['files', 'dailyNotes', 'templates', 'editor'] as const;

/** `onto` with every field where `edited` differs from `base` taken from `edited`. */
export function applyDelta(base: Settings, edited: Settings, onto: Settings): Settings {
  const out = { ...onto };
  for (const section of SECTIONS) {
    const b = base[section] as unknown as Record<string, unknown>;
    const e = edited[section] as unknown as Record<string, unknown>;
    let next: Record<string, unknown> | null = null;
    for (const key of Object.keys(e)) {
      if (JSON.stringify(e[key]) === JSON.stringify(b[key])) continue;
      next ??= { ...(onto[section] as unknown as Record<string, unknown>) };
      next[key] = e[key];
    }
    if (next) (out as Record<string, unknown>)[section] = next;
  }
  return out;
}

export class SettingsWriter {
  private readonly deps: SettingsWriterDeps;
  /** The draft shown in the form: the server's settings plus this tab's unsaved edits. */
  private latest: Settings | null = null;
  /** A write waiting for the one in flight. */
  private pending: Settings | null = null;
  private inFlight: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** The form is mounted: draft and saving changes reach it. */
  private attached = true;

  constructor(deps: SettingsWriterDeps) {
    this.deps = deps;
  }

  setAttached(attached: boolean): void {
    this.attached = attached;
  }

  private showDraft(draft: Settings | null): void {
    if (this.attached) this.deps.onDraft(draft);
  }

  private showSaving(saving: boolean): void {
    if (this.attached) this.deps.onSaving(saving);
  }

  get draft(): Settings | null {
    return this.latest;
  }

  /** A change in the form: written at once (toggles, selects) or after a pause in typing. */
  update(next: Settings, immediate: boolean): void {
    this.latest = next;
    this.showDraft(next);
    this.clearTimer();
    if (!this.deps.valid(next)) return;
    if (immediate) void this.write(next);
    else
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush();
      }, WRITE_DEBOUNCE_MS);
  }

  /** Writes a debounced edit now (leaving Settings, hiding the page); resolves when settled. */
  flush(): Promise<void> {
    const waiting = this.timer !== null;
    this.clearTimer();
    if (waiting && this.latest && this.deps.valid(this.latest)) return this.write(this.latest);
    return this.inFlight ?? Promise.resolve();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private write(next: Settings): Promise<void> {
    if (this.inFlight) {
      this.pending = next;
      return this.inFlight;
    }
    this.showSaving(true);
    this.inFlight = (async () => {
      try {
        let item: Settings | null = next;
        while (item) {
          await this.writeOnce(item);
          item = this.pending;
          this.pending = null;
        }
      } finally {
        this.inFlight = null;
        this.showSaving(false);
      }
    })();
    return this.inFlight;
  }

  private async writeOnce(next: Settings): Promise<void> {
    const current = this.deps.current();
    if (!current) return;
    try {
      const saved = await this.deps.put({ settings: next, baseVersion: current.version });
      this.deps.store(saved);
      if (this.latest === next) this.showServer();
      return;
    } catch (e) {
      if (!isProblem(e, 'version-conflict')) {
        this.deps.onError(e);
        return;
      }
    }
    // Another device changed the settings meanwhile: this tab's edits go on top of theirs.
    try {
      const fresh = await this.deps.refetch();
      const saved = await this.deps.put({ settings: applyDelta(current.settings, next, fresh.settings), baseVersion: fresh.version });
      this.deps.store(saved);
      if (this.latest === next) this.showServer();
      else if (this.latest) this.rebase(current.settings, saved.settings);
      this.deps.notify('Settings were also changed on another device; your change was applied on top of theirs', 'info');
    } catch (e) {
      if (isProblem(e, 'version-conflict')) {
        this.pending = null;
        this.showServer();
        this.deps.notify('Settings were changed on another device; showing their version', 'error');
      } else {
        this.deps.onError(e);
      }
    }
  }

  /** Newer edits (shown, or queued) move onto the server's settings after a conflict. */
  private rebase(base: Settings, server: Settings): void {
    if (this.latest) {
      this.latest = applyDelta(base, this.latest, server);
      this.showDraft(this.latest);
    }
    if (this.pending) this.pending = this.latest;
  }

  private showServer(): void {
    this.latest = null;
    this.showDraft(null);
  }
}
