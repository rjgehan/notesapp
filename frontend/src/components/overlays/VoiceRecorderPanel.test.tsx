import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api/endpoints';
import { queryClient } from '../../api/queryClient';
import { cancelVoiceNote, finishVoiceNote, pauseVoiceNote, resumeVoiceNote, useVoice } from '../../features/voice/voiceNotes';
import { useDialogs } from '../../state/dialogs';
import { VoiceRecorderPanel } from './VoiceRecorderPanel';

vi.mock('../../features/voice/voiceNotes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../features/voice/voiceNotes')>()),
  cancelVoiceNote: vi.fn(),
  finishVoiceNote: vi.fn(() => Promise.resolve()),
  pauseVoiceNote: vi.fn(),
  resumeVoiceNote: vi.fn(),
}));

function show() {
  return render(
    <QueryClientProvider client={queryClient}>
      <VoiceRecorderPanel />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.spyOn(api, 'getTranscriptionStatus').mockResolvedValue({ enabled: true, service: 'whisper-asr at http://whisper:9000', language: null, maxBytes: 1 });
});

afterEach(() => {
  useVoice.setState({ phase: 'idle', path: null, elapsed: 0, level: 0, transcribe: true });
  queryClient.clear();
});

describe('VoiceRecorderPanel', () => {
  it('shows nothing until a recording starts', () => {
    const { container } = show();
    expect(container).toBeEmptyDOMElement();
    expect(api.getTranscriptionStatus).not.toHaveBeenCalled();
  });

  it('shows the time, the level and the note while recording, with pause and done', async () => {
    act(() => useVoice.setState({ phase: 'recording', path: 'Ideas/Kitchen.md', elapsed: 75_400, level: 0.5 }));
    show();
    expect(screen.getByRole('timer')).toHaveTextContent('1:15');
    expect(screen.getByText('Recording')).toBeInTheDocument();
    expect(screen.getByText('Into Kitchen')).toBeInTheDocument();
    expect(document.querySelector('.voice-meter-level')).toHaveStyle({ transform: 'scaleX(0.5)' });
    fireEvent.click(screen.getByRole('button', { name: /Pause/ }));
    expect(pauseVoiceNote).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Done/ }));
    expect(finishVoiceNote).toHaveBeenCalled();
    act(() => useVoice.setState({ phase: 'paused' }));
    fireEvent.click(screen.getByRole('button', { name: /Resume/ }));
    expect(resumeVoiceNote).toHaveBeenCalled();
    // The transcription choice appears once the server says it can.
    const box = await screen.findByRole('checkbox', { name: 'Transcribe' });
    expect(box).toBeChecked();
    fireEvent.click(box);
    expect(useVoice.getState().transcribe).toBe(false);
    expect(localStorage.getItem('notesapp:voice')).toBe('no-transcripts');
  });

  it('hides the transcription choice when the server has no service', async () => {
    vi.mocked(api.getTranscriptionStatus).mockResolvedValue({ enabled: false, service: null, language: null, maxBytes: 1 });
    act(() => useVoice.setState({ phase: 'recording', path: 'a.md' }));
    show();
    await act(() => Promise.resolve());
    expect(screen.queryByRole('checkbox', { name: 'Transcribe' })).toBeNull();
  });

  it('discards a short recording at once and asks first for a longer one', async () => {
    act(() => useVoice.setState({ phase: 'recording', path: 'a.md', elapsed: 4_000 }));
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Discard recording' }));
    expect(cancelVoiceNote).toHaveBeenCalledTimes(1);
    act(() => useVoice.setState({ elapsed: 65_000 }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard recording' }));
    expect(cancelVoiceNote).toHaveBeenCalledTimes(1);
    const request = useDialogs.getState().stack.at(-1)!;
    expect(request).toMatchObject({ kind: 'confirm', title: 'Discard recording?', message: '1:05 of audio will be thrown away.' });
    await act(async () => (request as { resolve(ok: boolean): void }).resolve(true));
    expect(cancelVoiceNote).toHaveBeenCalledTimes(2);
  });

  it('disables its buttons while starting and saving', () => {
    act(() => useVoice.setState({ phase: 'saving', path: 'a.md' }));
    show();
    expect(screen.getByText('Saving…')).toBeInTheDocument();
    for (const b of screen.getAllByRole('button')) expect(b).toBeDisabled();
  });
});
