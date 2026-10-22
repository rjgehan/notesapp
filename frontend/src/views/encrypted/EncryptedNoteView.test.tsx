import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import { MemoryRouter } from 'react-router';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { httpEndpoints, installEndpoints } from '../../api/endpoints';
import { createMockEndpoints } from '../../api/mock';
import { MockVault } from '../../api/mock/vault';
import { queryClient } from '../../api/queryClient';
import type { FileEntry } from '../../api/types';
import { PassphraseDialog } from '../../components/overlays/EncryptionDialogs';
import { decryptPayload, deriveKey } from '../../features/encryption/cipher';
import { lock, resetKeyringForTests } from '../../features/encryption/keyring';
import { decodePayload, parseEncryptedFile, serializeEncryptedFile } from '../../features/encryption/meld';
import { documents } from '../../sync/instance';
import EncryptedNoteView from './EncryptedNoteView';

// Made with Node's crypto in the plugin's v2 format (see cipher.test.ts).
const PASS = 'correct horse battery staple';
const V2 = 'AAECAwQFBgcICQoLDA0OD/Dg0MCwoJCAcGBQQDAgEACrsoTj31BFp/0kZclovXUwtfxEYrfkMTA+IESxsfk2+AYujp7x4gue6vCN0sWz';
const PLAIN = 'Bank PIN: 4242 ✓\nsecond line';

let vault: MockVault;

afterEach(() => {
  queryClient.clear();
  resetKeyringForTests();
});

afterAll(() => installEndpoints(httpEndpoints));

function setup(): FileEntry {
  vault = new MockVault(false);
  vault.createFile({ path: 'Safe/Bank.mdenc', content: serializeEncryptedFile({ version: '2.0', hint: 'the usual', encodedData: V2 }) }, 'other-device-1');
  installEndpoints(createMockEndpoints(vault, { latency: 0, failures: [] }));
  return vault.getTree().files.find((f) => f.path === 'Safe/Bank.mdenc')!;
}

function show(entry: FileEntry) {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/n/Safe/Bank.mdenc']}>
        <EncryptedNoteView path={entry.path} entry={entry} mode="edit" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function enter(passphrase: string) {
  fireEvent.change(screen.getByLabelText('Passphrase'), { target: { value: passphrase } });
  fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
}

describe('EncryptedNoteView (item 27)', () => {
  it('reports a wrong passphrase, opens with the right one, saves only ciphertext and locks', async () => {
    const entry = setup();
    const { container } = show(entry);
    expect(await screen.findByText('This note is encrypted')).toBeInTheDocument();
    expect(screen.getByText('the usual')).toBeInTheDocument();
    expect(screen.getByText(/no way to recover/)).toBeInTheDocument();

    await enter('wrong passphrase');
    expect(await screen.findByRole('alert', {}, { timeout: 5000 })).toHaveTextContent('Wrong passphrase');
    expect(container.querySelector('.cm-content')).toBeNull();

    await enter(PASS);
    await waitFor(() => expect(container.querySelector('.cm-content')).not.toBeNull(), { timeout: 5000 });
    const content = container.querySelector<HTMLElement>('.cm-content')!;
    expect(content.textContent).toContain('Bank PIN: 4242');
    // No cloud spell checker or autocorrect sees decrypted text.
    expect(content.getAttribute('spellcheck')).toBe('false');
    expect(content.getAttribute('autocorrect')).toBe('off');

    const view = EditorView.findFromDOM(content)!;
    act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: '\nthird line' }, userEvent: 'input' }));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1400));
    });
    const stored = vault.readFile('Safe/Bank.mdenc').content;
    expect(stored).not.toContain('third');
    expect(stored).not.toContain('4242');
    const file = parseEncryptedFile(stored);
    expect(file).toMatchObject({ version: '2.0', hint: 'the usual' });
    const payload = decodePayload(file.encodedData, 2);
    expect(await decryptPayload(payload, await deriveKey(PASS, payload.salt, 2))).toBe(PLAIN + '\nthird line');
    // The session (and so its drafts and the offline copy) holds the ciphertext only.
    expect(documents.get('Safe/Bank.mdenc')?.getText()).toBe(stored);

    act(() => lock());
    await waitFor(() => expect(screen.getByText('This note is encrypted')).toBeInTheDocument());
    expect(container.querySelector('.cm-content')).toBeNull();
    expect(container.textContent).not.toContain('4242');
  }, 20_000);
});

describe('PassphraseDialog (item 27)', () => {
  it('asks twice, refuses short or different passphrases, and needs the no-recovery acknowledgement', async () => {
    const submitted: string[] = [];
    let resolved: boolean | null = null;
    render(
      <PassphraseDialog
        request={{
          kind: 'passphrase',

          mode: 'create',
          title: 'New encrypted note',
          submit: async (passphrase, hint) => {
            submitted.push(`${passphrase}|${hint}`);
            return null;
          },
          resolve: (ok) => {
            resolved = ok;
          },
        }}
      />,
    );
    const encrypt = screen.getByRole('button', { name: 'Encrypt' });
    const [first, second] = screen.getAllByLabelText(/passphrase/i).filter((el) => el instanceof HTMLInputElement && el.type === 'password');
    expect(first.getAttribute('autocomplete')).toBe('off');
    fireEvent.change(first, { target: { value: 'short' } });
    fireEvent.change(second, { target: { value: 'short' } });
    expect(encrypt).toBeDisabled();
    fireEvent.change(first, { target: { value: 'four random words here' } });
    fireEvent.change(second, { target: { value: 'four random words there' } });
    fireEvent.click(screen.getByRole('checkbox'));
    expect(encrypt).toBeDisabled();
    fireEvent.change(second, { target: { value: 'four random words here' } });
    fireEvent.change(screen.getByLabelText(/Hint/), { target: { value: ' my hint ' } });
    expect(screen.getByText(/gone for good/)).toBeInTheDocument();
    expect(encrypt).toBeEnabled();
    fireEvent.click(encrypt);
    await waitFor(() => expect(resolved).toBe(true));
    expect(submitted).toEqual(['four random words here|my hint']);
  });
});
