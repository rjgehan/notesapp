import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api/endpoints';
import { queryClient } from '../../api/queryClient';
import { setTranscribeNewRecordings } from '../../features/voice/voiceNotes';
import { RemindersSection, TextSetting, VoiceRow } from './SettingsPage';
import { remindersApi } from '../../features/reminders/client';
import { DEFAULT_SETTINGS } from '../../features/settings';
import type { RemindersStatus, Settings } from '../../api/types';

function Folder({ onValue }: { onValue(v: string): void }) {
  const [value, setValue] = useState('');
  return (
    <TextSetting
      label="Daily note folder"
      value={value}
      disabled={false}
      trim
      onChange={(v) => {
        setValue(v);
        onValue(v);
      }}
    />
  );
}

describe('TextSetting (FE-5, ux)', () => {
  it('keeps a typed space between words, and the setting receives the trimmed value', () => {
    const values: string[] = [];
    render(<Folder onValue={(v) => values.push(v)} />);
    const input = screen.getByLabelText<HTMLInputElement>('Daily note folder');
    // Key by key, each keystroke appending to what the field shows.
    for (const ch of 'Daily Notes ') fireEvent.change(input, { target: { value: input.value + ch } });
    expect(input.value).toBe('Daily Notes ');
    expect(values.at(-1)).toBe('Daily Notes');
  });
});

describe('Transcribe voice notes (ROADMAP item 33)', () => {
  // Cleared before each test: the previous test's view is unmounted only after its afterEach hooks.
  beforeEach(() => queryClient.clear());
  afterEach(() => setTranscribeNewRecordings(true));

  const show = () =>
    render(
      <QueryClientProvider client={queryClient}>
        <VoiceRow />
      </QueryClientProvider>,
    );

  it('names the server’s service and turns transcripts off on this device', async () => {
    vi.spyOn(api, 'getTranscriptionStatus').mockResolvedValue({ enabled: true, service: 'whisper-asr at http://notesapp-whisper:9000', language: null, maxBytes: 1 });
    show();
    expect(await screen.findByText(/transcribed by whisper-asr at http:\/\/notesapp-whisper:9000/)).toBeInTheDocument();
    const toggle = screen.getByRole('switch', { name: 'Transcribe voice notes' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(localStorage.getItem('notesapp:voice')).toBe('no-transcripts');
  });

  it('explains that recordings are saved without text while the server has no service', async () => {
    vi.spyOn(api, 'getTranscriptionStatus').mockResolvedValue({ enabled: false, service: null, language: null, maxBytes: 1 });
    show();
    expect(await screen.findByText(/saved without text \(DEPLOY\.md, Voice notes\)/)).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Transcribe voice notes' })).toBeDisabled();
  });
});

describe('Settings › Reminders (ROADMAP item 9)', () => {
  beforeEach(() => queryClient.clear());

  const status: RemindersStatus = {
    zone: 'Europe/Berlin',
    zoneReported: true,
    serverZone: 'UTC',
    webPush: { available: true, reason: null, publicKey: 'BKEY', devices: [{ id: 'dev1', name: 'iPhone · Safari', createdAt: '2026-10-16T12:00:00Z', lastSuccessAt: null, lastError: 'iPhone · Safari: the push service answered HTTP 500', lastErrorAt: null }] },
    ntfy: { configured: false, reason: 'ntfy.json is not in the secrets directory', server: null, ownTopic: false },
    inApp: { connections: 1 },
    lastDeliveredAt: null,
    lastError: null,
    lastErrorAt: null,
    upcoming: [{ taskId: 't1', title: 'Pay rent', at: '2026-10-17T09:00' }],
  };

  function Harness({ onSet }: { onSet(s: Settings): void }) {
    const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
    return (
      <QueryClientProvider client={queryClient}>
        <RemindersSection
          settings={settings}
          disabled={false}
          errors={{}}
          set={(next) => {
            setSettings(next);
            onSet(next);
          }}
        />
      </QueryClientProvider>
    );
  }

  it('switches routes on, shows the server’s state and sends a test', async () => {
    vi.spyOn(remindersApi, 'status').mockResolvedValue(status);
    const test = vi.spyOn(remindersApi, 'test').mockResolvedValue({ sent: true, error: null });
    const saved: Settings[] = [];
    render(<Harness onSet={(s) => saved.push(s)} />);
    expect(await screen.findByText('iPhone · Safari')).toBeInTheDocument();
    expect(screen.getByText('ntfy.json is not in the secrets directory')).toBeInTheDocument();
    expect(screen.getByText('Pay rent (2026-10-17 09:00)')).toBeInTheDocument();
    expect(screen.getByText(/HTTP 500/)).toBeInTheDocument();

    for (const name of ['Send reminders by Web Push', 'Send reminders through ntfy', 'Show reminders in open tabs']) {
      const toggle = screen.getByRole('switch', { name });
      expect(toggle).toHaveAttribute('aria-checked', 'false');
      fireEvent.click(toggle);
    }
    expect(saved.at(-1)?.reminders).toMatchObject({ webPush: true, ntfy: true, inApp: true, ntfyTitleOnly: true });

    fireEvent.click(screen.getAllByRole('button', { name: 'Send a test' })[0]);
    expect(test).toHaveBeenCalledWith({ route: 'webPush', deviceId: 'dev1' });
  });
});
