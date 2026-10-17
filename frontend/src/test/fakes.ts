// Test doubles for the sync layer.
import { vi } from 'vitest';
import type { Endpoints, SaveOptions } from '../api/endpoints';
import type { SaveFileRequest } from '../api/types';
import { MockVault } from '../api/mock/vault';
import { orphanRecord, rekeyPlan, type DiscardedRecord, type DraftRecord, type DraftStore } from '../sync/drafts';
import type { SessionDeps } from '../sync/DocumentSession';
import { MoveMap } from '../sync/moves';

export class MemoryDraftStore implements DraftStore {
  drafts = new Map<string, DraftRecord>();
  discarded: DiscardedRecord[] = [];
  private nextId = 1;
  failPuts = false;

  private key(path: string, clientId: string) {
    return JSON.stringify([path, clientId]);
  }
  async put(d: DraftRecord) {
    if (this.failPuts) throw new DOMException('Quota exceeded', 'QuotaExceededError');
    this.drafts.set(this.key(d.path, d.clientId), structuredClone(d));
  }
  async remove(path: string, clientId: string) {
    this.drafts.delete(this.key(path, clientId));
  }
  async listForPath(path: string) {
    return [...this.drafts.values()].filter((d) => d.path === path).map((d) => structuredClone(d));
  }
  async listAll() {
    return [...this.drafts.values()].map((d) => structuredClone(d));
  }
  async rekey(from: string, to: string) {
    const plan = rekeyPlan([...this.drafts.values()], from, to);
    for (const d of plan.displaced) await this.discard(orphanRecord(d));
    for (const [old] of plan.moves) this.drafts.delete(this.key(old.path, old.clientId));
    for (const [, next] of plan.moves) this.drafts.set(this.key(next.path, next.clientId), next);
  }
  async discard(r: Omit<DiscardedRecord, 'id'>) {
    const id = this.nextId++;
    this.discarded.push({ ...r, id });
    return id;
  }
  async takeDiscarded(id: number) {
    const i = this.discarded.findIndex((d) => d.id === id);
    return i < 0 ? null : this.discarded.splice(i, 1)[0];
  }
  async listDiscarded() {
    return [...this.discarded];
  }
  async prune() {}
  forPath(path: string) {
    return [...this.drafts.values()].filter((d) => d.path === path);
  }
}

/** A fake API over a MockVault whose saves can be held open or made to fail. */
export function fakeApi(vault: MockVault, origin = 'me-0000001') {
  const failures: Array<() => never> = [];
  let gate: { promise: Promise<void>; release: () => void } | null = null;
  const readFile = vi.fn(async (path: string) => structuredClone(vault.readFile(path)));
  const saveFile = vi.fn(async (path: string, req: SaveFileRequest, _opts?: SaveOptions) => {
    const fail = failures.shift();
    if (gate) await gate.promise;
    if (fail) fail();
    return structuredClone(vault.saveFile(path, req, origin));
  });
  const api = { readFile, saveFile };
  return {
    api,
    failNext(fn: () => never) {
      failures.push(fn);
    },
    /** Holds every save until the returned function is called. */
    holdSaves(): () => void {
      let release!: () => void;
      const promise = new Promise<void>((r) => (release = r));
      gate = { promise, release };
      return () => {
        gate = null;
        release();
      };
    },
  };
}

export function sessionDeps(api: Pick<Endpoints, 'readFile' | 'saveFile'>, overrides: Partial<SessionDeps> = {}): SessionDeps & { drafts: MemoryDraftStore; notices: string[] } {
  const notices: string[] = [];
  const drafts = new MemoryDraftStore();
  return {
    api,
    drafts,
    moves: new MoveMap(),
    clientId: 'tab-a-000001',
    liveDraftOwners: async () => new Set<string>(),
    onWriteResult: () => {},
    onRekey: () => true,
    onChange: () => {},
    notify: (n) => notices.push(n.message),
    onDraftWrite: () => {},
    caughtUp: () => true,
    notices,
    ...overrides,
  } as SessionDeps & { drafts: MemoryDraftStore; notices: string[] };
}
