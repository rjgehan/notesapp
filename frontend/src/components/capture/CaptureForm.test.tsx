import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, TransientError } from '../../api/client';
import { api, httpEndpoints, installEndpoints } from '../../api/endpoints';
import type { CaptureRequest, CaptureResult } from '../../api/types';
import { captureQueue, fileCaption, flushCaptures, useCaptureQueue } from '../../features/captureSync';
import { isApple } from '../../features/platform';
import { CaptureForm } from './CaptureForm';

const mod = isApple ? { metaKey: true } : { ctrlKey: true };

const result = (target: 'inbox' | 'daily' = 'inbox'): CaptureResult => ({
  file: { path: 'Inbox.md', name: 'Inbox.md', basename: 'Inbox', extension: 'md', kind: 'note', size: 10, mtime: '2026-10-16T10:00:00.000Z', version: 'v1', aliases: [] },
  created: false,
  createdFolders: [],
  target,
  attachment: null,
});

beforeEach(async () => {
  for (const i of await captureQueue.list()) await captureQueue.remove(i.id!);
});

afterEach(() => {
  installEndpoints(httpEndpoints);
});

describe('quick capture form', () => {
  it('focuses the text at once and saves with Mod-Enter, with the device’s date and time', async () => {
    const capture = vi.fn(async (_req: CaptureRequest) => result());
    installEndpoints({ ...api, capture });
    const onDone = vi.fn();
    render(<CaptureForm onDone={onDone} />);
    const field = screen.getByRole('textbox', { name: 'Capture text' });
    expect(field).toHaveFocus();
    fireEvent.change(field, { target: { value: 'Call the plumber' } });
    fireEvent.keyDown(field, { key: 'Enter', ...mod });
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(onDone.mock.calls[0][0]).toMatchObject({ status: 'sent', result: { file: { path: 'Inbox.md' } } });
    const req = capture.mock.calls[0][0];
    expect(req).toMatchObject({ text: 'Call the plumber', target: 'inbox' });
    expect(req.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(req.time).toMatch(/^\d{2}:\d{2}$/);
    expect(await captureQueue.list()).toEqual([]);
  });

  it('switches to today’s note and remembers it', async () => {
    const capture = vi.fn(async (_req: CaptureRequest) => result('daily'));
    installEndpoints({ ...api, capture });
    render(<CaptureForm onDone={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Today' }));
    expect(screen.getByRole('button', { name: 'Today' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.change(screen.getByRole('textbox', { name: 'Capture text' }), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(capture).toHaveBeenCalled());
    expect(capture.mock.calls[0][0].target).toBe('daily');
    expect(localStorage.getItem('notesapp:captureTarget')).toBe('daily');
  });

  it('offline, the capture waits on the device and goes out when the connection returns', async () => {
    const capture = vi.fn(async (_req: CaptureRequest, _opts?: { idempotencyKey?: string }): Promise<CaptureResult> => {
      throw new TransientError('Failed to fetch');
    });
    installEndpoints({ ...api, capture });
    const onDone = vi.fn();
    render(<CaptureForm onDone={onDone} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Capture text' }), { target: { value: 'On the plane' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(onDone.mock.calls[0][0]).toEqual({ status: 'queued' });
    expect(useCaptureQueue.getState().waiting).toBe(1);
    const key = capture.mock.calls[0][1]?.idempotencyKey;
    expect(key).toBeTruthy();

    capture.mockImplementation(async () => result());
    const { sent } = await flushCaptures();
    expect(sent).toHaveLength(1);
    // The retry is the same capture: the same idempotency key, the time it was made.
    expect(capture.mock.calls[1][1]?.idempotencyKey).toBe(key);
    expect(capture.mock.calls[1][0].time).toBe(capture.mock.calls[0][0].time);
    expect(useCaptureQueue.getState().waiting).toBe(0);
  });

  it('a refused capture keeps the text in the form and shows why', async () => {
    const capture = vi.fn(async (): Promise<CaptureResult> => {
      throw new ApiError({ type: 'urn:notesapp:problem:invalid-name', title: 'Invalid name', status: 400, code: 'invalid-name', detail: 'bad' });
    });
    installEndpoints({ ...api, capture });
    const onDone = vi.fn();
    render(<CaptureForm onDone={onDone} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Capture text' }), { target: { value: 'keep me' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('alert');
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'Capture text' })).toHaveValue('keep me');
    expect(await captureQueue.list()).toEqual([]);
  });

  it('shows a shared link and can drop it', () => {
    render(<CaptureForm onDone={() => {}} initial={{ text: '', url: 'https://example.com/a', title: 'A page' }} />);
    expect(screen.getByText('A page')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove the link' }));
    expect(screen.queryByText('A page')).toBeNull();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('captions a shared picture with the text, then the page title and link', () => {
    expect(fileCaption('Whiteboard', null, null)).toBe('Whiteboard');
    expect(fileCaption('', 'A page', 'https://example.com/p')).toBe('A page https://example.com/p');
    expect(fileCaption('About A page', 'A page', 'https://example.com/p')).toBe('About A page https://example.com/p');
    expect(fileCaption(null, null, null)).toBeNull();
  });
});
