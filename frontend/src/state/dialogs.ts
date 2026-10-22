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

/** Several answers at once, any of them empty (a template's questions, DESIGN §6.12). */
export interface FieldsRequest {
  kind: 'fields';
  title: string;
  fields: { label: string; value: string }[];
  confirmLabel?: string;
  resolve(values: string[] | null): void;
}

export type DialogRequest = (PromptRequest | ConfirmRequest | ChoiceRequest | FieldsRequest) & { id: number };

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

export function chooseAction<T extends string>(opts: { title: string; message: string; choices: Choice<T>[] }): Promise<T | null> {
  return push<T | null>((resolve, id) => ({ ...opts, kind: 'choice', id, resolve: resolve as (v: string | null) => void }));
}

/** The answers in field order, or null when cancelled. */
export function promptFields(opts: Omit<FieldsRequest, 'kind' | 'resolve'>): Promise<string[] | null> {
  return push<string[] | null>((resolve, id) => ({ ...opts, kind: 'fields', id, resolve }));
}
