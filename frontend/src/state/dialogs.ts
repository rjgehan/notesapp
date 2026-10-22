// Promise-based prompt, confirm and choice dialogs (DESIGN §6.5 PromptDialog, ConfirmDialog).
// The dialog components are bundled eagerly and focus synchronously (§6.13).
import { create } from 'zustand';

export interface PromptRequest {
  kind: 'prompt';
  title: string;
  label: string;
  value: string;
  placeholder?: string;
  confirmLabel?: string;
  /** Selects this range of `value` initially (e.g. the basename without its extension). */
  selection?: [number, number];
  /** Inline validation shown before sending; a message, or null when valid. */
  validate?(value: string): string | null;
  /** A password field: the value is masked and never autocapitalized. */
  secret?: boolean;
  resolve(value: string | null): void;
}

export interface ConfirmRequest {
  kind: 'confirm';
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  resolve(ok: boolean): void;
}

export interface Choice<T extends string = string> {
  id: T;
  label: string;
  primary?: boolean;
  danger?: boolean;
}

export interface ChoiceRequest {
  kind: 'choice';
  title: string;
  message: string;
  choices: Choice[];
  resolve(id: string | null): void;
}

/**
 * A passphrase for an encrypted note or section (DESIGN §6.33). The passphrase never leaves the
 * dialog except into `submit`, which turns it into a key and answers with an error to show
 * inline (a wrong passphrase) or null, which closes the dialog with `resolve(true)`.
 */
export interface PassphraseRequest {
  kind: 'passphrase';
  /** `unlock` asks once and shows the hint; `create` asks twice, asks for a hint and for the no-recovery acknowledgement. */
  mode: 'unlock' | 'create';
  title: string;
  message?: string;
  /** unlock: the stored hint; create: the hint field's initial value. */
  hint?: string;
  confirmLabel?: string;
  submit(passphrase: string, hint: string): Promise<string | null>;
  resolve(ok: boolean): void;
}

export type SecretResult = { action: 'save'; text: string; hint: string } | { action: 'decrypt'; text: string } | null;

/** The decrypted text of an inline section, editable; it is encrypted again on Save. */
export interface SecretRequest {
  kind: 'secret';
  title: string;
  text: string;
  hint: string;
  /** New sections start empty and cannot be decrypted permanently. */
  isNew?: boolean;
  resolve(result: SecretResult): void;
}

export type DialogRequest = (PromptRequest | ConfirmRequest | ChoiceRequest | PassphraseRequest | SecretRequest) & { id: number };

interface DialogState {
  stack: DialogRequest[];
  open(request: DialogRequest): void;
  close(id: number): void;
}

let nextId = 1;

export const useDialogs = create<DialogState>()((set) => ({
  stack: [],
  open: (request) => set((s) => ({ stack: [...s.stack, request] })),
  close: (id) => set((s) => ({ stack: s.stack.filter((d) => d.id !== id) })),
}));

function push<T>(build: (resolve: (v: T) => void, id: number) => DialogRequest): Promise<T> {
  return new Promise<T>((resolve) => {
    const id = nextId++;
    useDialogs.getState().open(
      build((v) => {
        useDialogs.getState().close(id);
        resolve(v);
      }, id),
    );
  });
}

export function promptText(opts: Omit<PromptRequest, 'kind' | 'resolve'>): Promise<string | null> {
  return push<string | null>((resolve, id) => ({ ...opts, kind: 'prompt', id, resolve }));
}

export function confirmAction(opts: Omit<ConfirmRequest, 'kind' | 'resolve'>): Promise<boolean> {
  return push<boolean>((resolve, id) => ({ ...opts, kind: 'confirm', id, resolve }));
}

export function askPassphrase(opts: Omit<PassphraseRequest, 'kind' | 'resolve'>): Promise<boolean> {
  return push<boolean>((resolve, id) => ({ ...opts, kind: 'passphrase', id, resolve }));
}

export function editSecret(opts: Omit<SecretRequest, 'kind' | 'resolve'>): Promise<SecretResult> {
  return push<SecretResult>((resolve, id) => ({ ...opts, kind: 'secret', id, resolve }));
}

export function chooseAction<T extends string>(opts: { title: string; message: string; choices: Choice<T>[] }): Promise<T | null> {
  return push<T | null>((resolve, id) => ({ ...opts, kind: 'choice', id, resolve: resolve as (v: string | null) => void }));
}
