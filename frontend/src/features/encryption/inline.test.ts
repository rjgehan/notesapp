import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { httpEndpoints, installEndpoints } from '../../api/endpoints';
import { createMockEndpoints } from '../../api/mock';
import { MockVault } from '../../api/mock/vault';
import { queryClient } from '../../api/queryClient';
import { useDialogs, type DialogRequest } from '../../state/dialogs';
import { usePrefs } from '../../state/prefs';
import { documents } from '../../sync/instance';
import { checkIdle, noteActivity } from './autoLock';
import { decryptPayload, deriveKey } from './cipher';
import { encryptSelection, openSection } from './inline';
import { isUnlocked, resetKeyringForTests } from './keyring';
import { decodePayload, findSections } from './meld';

const PASS = 'correct horse battery staple';
const V2 = 'AAECAwQFBgcICQoLDA0OD/Dg0MCwoJCAcGBQQDAgEACrsoTj31BFp/0kZclovXUwtfxEYrfkMTA+IESxsfk2+AYujp7x4gue6vCN0sWz';

afterEach(() => {
  queryClient.clear();
  resetKeyringForTests();
  useDialogs.setState({ stack: [] });
});

afterAll(() => installEndpoints(httpEndpoints));

let seq = 0;

async function session(content: string) {
  const path = `Bank ${++seq}.md`;
  const vault = new MockVault(false);
  vault.createFile({ path, content }, 'other-device-1');
  installEndpoints(createMockEndpoints(vault, { latency: 0, failures: [] }));
  const s = documents.acquire(path, 'inline-test');
  await s.ready;
  return { s, vault };
}

/** Waits for the next dialog of `kind` and answers it. */
async function answer<K extends DialogRequest['kind']>(kind: K, act: (d: Extract<DialogRequest, { kind: K }>) => void | Promise<void>): Promise<void> {
  for (let i = 0; i < 400; i++) {
    const d = useDialogs.getState().stack.at(-1);
    if (d && d.kind === kind) {
      await act(d as Extract<DialogRequest, { kind: K }>);
      return;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`no ${kind} dialog`);
}

async function decrypt(base64: string): Promise<string | null> {
  const p = decodePayload(base64, 2);
  return decryptPayload(p, await deriveKey(PASS, p.salt, 2));
}

describe('inline encrypted sections (item 27)', () => {
  it('opens a section in a dialog and saves it encrypted again; the note never holds plaintext', async () => {
    const { s } = await session(`PIN: %%🔐β 💡usual💡${V2} 🔐%% end\n`);
    const section = findSections(s.getText())[0];
    const done = openSection(s, section);
    await answer('passphrase', async (d) => {
      expect(d.hint).toBe('usual');
      expect(await d.submit('nope', '')).toMatch(/Wrong passphrase/);
      expect(await d.submit(PASS, '')).toBeNull();
      d.resolve(true);
    });
    await answer('secret', (d) => {
      expect(d.text).toBe('Bank PIN: 4242 ✓\nsecond line');
      d.resolve({ action: 'save', text: 'new PIN 9999', hint: 'changed' });
    });
    await done;
    const text = s.getText();
    expect(text).not.toContain('9999');
    expect(text.startsWith('PIN: %%🔐β 💡changed💡')).toBe(true);
    expect(text.endsWith(' 🔐%% end\n')).toBe(true);
    const updated = findSections(text)[0];
    expect(await decrypt(updated.base64)).toBe('new PIN 9999');
    // Unlocked for the session: no passphrase the second time.
    const again = openSection(s, updated);
    await answer('secret', (d) => {
      expect(d.text).toBe('new PIN 9999');
      d.resolve(null);
    });
    await again;
    documents.release(s, 'inline-test');
  }, 20_000);

  it('encrypts a selection in place with a new passphrase', async () => {
    const { s } = await session('Wifi: hunter2 thanks\n');
    const done = encryptSelection(s, { from: 6, to: 13 });
    await answer('passphrase', async (d) => {
      expect(d.mode).toBe('create');
      expect(d.message).toMatch(/version history/);
      expect(await d.submit(PASS, 'router')).toBeNull();
      d.resolve(true);
    });
    await done;
    const text = s.getText();
    expect(text).not.toContain('hunter2');
    const section = findSections(text)[0];
    expect(section.hint).toBe('router');
    expect(await decrypt(section.base64)).toBe('hunter2');
    documents.release(s, 'inline-test');
  }, 20_000);
});

describe('auto-lock (item 27)', () => {
  it('locks after the idle limit and not before', async () => {
    const { s } = await session(`x %%🔐β ${V2} 🔐%%\n`);
    const done = openSection(s, findSections(s.getText())[0]);
    await answer('passphrase', async (d) => {
      await d.submit(PASS, '');
      d.resolve(true);
    });
    await answer('secret', (d) => d.resolve(null));
    await done;
    usePrefs.setState({ encryptionLockMinutes: 5 });
    noteActivity(1_000_000);
    expect(checkIdle(1_000_000 + 4 * 60_000)).toBe(false);
    expect(isUnlocked()).toBe(true);
    expect(checkIdle(1_000_000 + 5 * 60_000)).toBe(true);
    expect(isUnlocked()).toBe(false);
    documents.release(s, 'inline-test');
  }, 20_000);
});
