import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api/endpoints';
import { queryClient } from '../../api/queryClient';
import { setTranscribeNewRecordings } from '../../features/voice/voiceNotes';
import { TextSetting, VoiceRow } from './SettingsPage';

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
