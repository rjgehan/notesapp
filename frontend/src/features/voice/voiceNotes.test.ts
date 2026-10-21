import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api/endpoints';
import { MockVault } from '../../api/mock/vault';
import { queryClient } from '../../api/queryClient';
import { queryKeys } from '../../api/queryKeys';
import type { AttachmentResult, FileEntry, TranscriptionResult } from '../../api/types';
import { ApiError } from '../../api/client';
import { pendingUploads } from '../../editor/uploads';
import { useToasts } from '../../state/toasts';
import { DocumentSession } from '../../sync/DocumentSession';
import { fakeApi, sessionDeps } from '../../test/fakes';
import type { VoiceRecorder } from './recorder';
import {
  cancelVoiceNote,
  embedInsertion,
  finishVoiceNote,
  insertRecording,
  pauseVoiceNote,
  recordingEmbedAt,
  resumeVoiceNote,
  setRecorderFactory,
  setTranscribeNewRecordings,
  startVoiceNote,
  transcribeAtCursor,
  transcribeNewRecordings,
  transcriptInsertion,
  useVoice,
} from './voiceNotes';

function entry(path: string, kind: FileEntry['kind']): FileEntry {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return { path, name, basename: name, extension: name.slice(name.lastIndexOf('.') + 1), kind, size: 10, mtime: '2026-10-21T10:00:00.000Z', version: null, aliases: [] };
}

function setTree(...files: FileEntry[]) {
  queryClient.setQueryData(queryKeys.tree(), { eventId: 'e.1', folders: [], files });
}

async function open(content: string) {
  const vault = new MockVault(false);
  vault.createFile({ path: 'Notes/a.md', content }, 'other-device-1');
  const session = new DocumentSession('Notes/a.md', sessionDeps(fakeApi(vault).api));
  await session.ready;
  return session;
}

function attachment(name: string): AttachmentResult {
  return {
    file: { ...entry(`Attachments/${name}`, name.endsWith('.webm') ? 'video' : 'audio'), size: 3 },
    created: true,
    createdFolders: [],
    linkText: name,
    markdown: `![[${name}]]`,
  };
}

async function settle() {
  for (let i = 0; i < 20; i++) await act(() => Promise.resolve());
}

beforeEach(() => {
  setTree(entry('Notes/a.md', 'note'), entry('Attachments/Memo.m4a', 'audio'), entry('Attachments/Clip.webm', 'video'), entry('Attachments/pic.png', 'image'));
  vi.spyOn(api, 'getTranscriptionStatus').mockResolvedValue({ enabled: true, service: 'whisper-asr at http://whisper:9000', language: null, maxBytes: 1 << 20 });
});

afterEach(() => {
  cancelVoiceNote();
  queryClient.clear();
  useToasts.setState({ toasts: [] });
});

describe('voice note text', () => {
  it('puts the embed on a line of its own', () => {
    expect(embedInsertion('', 0, '![[r.m4a]]')).toBe('![[r.m4a]]');
    expect(embedInsertion('Hello\n', 6, '![[r.m4a]]')).toBe('![[r.m4a]]');
    expect(embedInsertion('Hello', 5, '![[r.m4a]]')).toBe('\n![[r.m4a]]');
    expect(embedInsertion('Hello', 0, '![[r.m4a]]')).toBe('![[r.m4a]]\n');
    expect(embedInsertion('Hello world', 6, '![[r.m4a]]')).toBe('\n![[r.m4a]]\n');
  });

  it('keeps the transcript between an embed inserted before text and that text', async () => {
    const session = await open('Typed text.');
    vi.spyOn(api, 'uploadAttachment').mockResolvedValue(attachment('Recording 3.m4a'));
    vi.spyOn(api, 'transcribe').mockResolvedValue({ path: 'Attachments/Recording 3.m4a', text: 'Hi.', language: null, millis: 1 });
    await insertRecording(session, new File(['a'], 'Recording 3.m4a', { type: 'audio/mp4' }), { from: 0, to: 0 }, true);
    await settle();
    expect(session.getText()).toBe('![[Recording 3.m4a]]\n> Hi.\n\nTyped text.');
    session.dispose();
  });

  it('quotes the transcript under the embed and ends the quote before the text that follows', () => {
    const doc = '![[r.m4a]]';
    expect(transcriptInsertion(doc, doc.length, ' Buy milk. ')).toBe('\n> Buy milk.');
    expect(transcriptInsertion(doc + '\n', doc.length, 'a\n\nb')).toBe('\n> a\n>\n> b');
    expect(transcriptInsertion(doc + '\n\nNext', doc.length, 'a')).toBe('\n> a');
    // A following line would otherwise be drawn into the quote.
    expect(transcriptInsertion(doc + '\nNext', doc.length, 'a')).toBe('\n> a\n');
    expect(transcriptInsertion(doc + ' and more', doc.length, 'a')).toBe('\n> a\n\n');
  });

  it('finds the audio or video embed on the cursor’s line', () => {
    const doc = 'Intro ![[pic.png]]\nToday ![[Memo.m4a]] and ![](../Attachments/Clip.webm)\nEnd';
    const line2 = doc.indexOf('Today');
    expect(recordingEmbedAt(doc, line2, 'Notes/a.md')).toEqual({ path: 'Attachments/Memo.m4a', end: doc.indexOf('.m4a]]') + 6 });
    expect(recordingEmbedAt(doc, doc.indexOf('Clip'), 'Notes/a.md')).toEqual({ path: 'Attachments/Clip.webm', end: doc.indexOf('.webm)') + 6 });
    expect(recordingEmbedAt(doc, 2, 'Notes/a.md')).toBeNull();
    expect(recordingEmbedAt(doc, doc.length, 'Notes/a.md')).toBeNull();
  });

  it('remembers per device whether new recordings are transcribed', () => {
    expect(transcribeNewRecordings()).toBe(true);
    setTranscribeNewRecordings(false);
    expect(transcribeNewRecordings()).toBe(false);
    expect(useVoice.getState().transcribe).toBe(false);
    setTranscribeNewRecordings(true);
    expect(transcribeNewRecordings()).toBe(true);
  });
});

describe('insertRecording', () => {
  it('embeds the recording where the widget waited, then its transcript under it', async () => {
    const session = await open('First line.\nSecond line.');
    let uploaded!: (r: AttachmentResult) => void;
    let transcribed!: (r: TranscriptionResult) => void;
    const upload = vi.spyOn(api, 'uploadAttachment').mockImplementation(() => new Promise((r) => (uploaded = r)));
    const transcribe = vi.spyOn(api, 'transcribe').mockImplementation(() => new Promise((r) => (transcribed = r)));
    const file = new File(['abc'], 'Recording 20261021143005.m4a', { type: 'audio/mp4' });
    const done = insertRecording(session, file, { from: 11, to: 11 }, true);
    expect(pendingUploads(session.editorState).map((u) => [u.pos, u.verb ?? 'Uploading'])).toEqual([
      [11, 'Uploading'],
      [11, 'Transcribing'],
    ]);
    expect(upload).toHaveBeenCalledWith('Recording 20261021143005.m4a', 'Notes/a.md', file, { idempotencyKey: expect.any(String) });
    // The user keeps typing before the upload lands.
    session.applyEdit({ from: 0, to: 0, insert: 'Typed. ' });
    uploaded(attachment('Recording 20261021143005.m4a'));
    await done;
    expect(session.getText()).toBe('Typed. First line.\n![[Recording 20261021143005.m4a]]\nSecond line.');
    expect(transcribe).toHaveBeenCalledWith('Attachments/Recording 20261021143005.m4a');
    transcribed({ path: 'Attachments/Recording 20261021143005.m4a', text: 'Call the plumber.', language: 'en', millis: 9 });
    await settle();
    expect(session.getText()).toBe('Typed. First line.\n![[Recording 20261021143005.m4a]]\n> Call the plumber.\n\nSecond line.');
    expect(pendingUploads(session.editorState)).toEqual([]);
    session.dispose();
  });

  it('keeps the recording for a retry when the upload fails', async () => {
    const session = await open('');
    const upload = vi.spyOn(api, 'uploadAttachment').mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(attachment('Recording 1.m4a'));
    await insertRecording(session, new File(['abc'], 'Recording 1.m4a', { type: 'audio/mp4' }), { from: 0, to: 0 }, false);
    expect(session.getText()).toBe('');
    const toast = useToasts.getState().toasts.at(-1)!;
    expect(toast.message).toBe('Recording 1.m4a: offline');
    expect(toast.timeout).toBe(0);
    toast.action!.run();
    await vi.waitFor(() => expect(session.getText()).toBe('![[Recording 1.m4a]]'));
    expect(upload).toHaveBeenCalledTimes(2);
    session.dispose();
  });

  it('says so when no speech was recognized, and offers a retry when transcribing fails', async () => {
    const session = await open('');
    vi.spyOn(api, 'uploadAttachment').mockResolvedValue(attachment('Recording 2.m4a'));
    const transcribe = vi
      .spyOn(api, 'transcribe')
      .mockResolvedValueOnce({ path: 'Attachments/Recording 2.m4a', text: '  ', language: null, millis: 1 })
      .mockRejectedValueOnce(new ApiError({ type: 'x', title: 'Transcription failed', status: 503, code: 'transcription-failed', detail: 'The transcription service failed: cannot connect to http://whisper:9000' }))
      .mockResolvedValueOnce({ path: 'Attachments/Recording 2.m4a', text: 'Finally.', language: null, millis: 1 });
    setTree(entry('Notes/a.md', 'note'), entry('Attachments/Recording 2.m4a', 'audio'));
    await insertRecording(session, new File(['a'], 'Recording 2.m4a', { type: 'audio/mp4' }), { from: 0, to: 0 }, true);
    await settle();
    expect(useToasts.getState().toasts.at(-1)?.message).toBe('No speech was recognized in Recording 2.m4a.');
    expect(session.getText()).toBe('![[Recording 2.m4a]]');

    session.applyEdit({ from: 0, to: 0, insert: 'Intro\n' });
    await transcribeAtCursor(session);
    await settle();
    const failed = useToasts.getState().toasts.at(-1)!;
    expect(failed.message).toBe('Transcribing Recording 2.m4a failed: The transcription service failed: cannot connect to http://whisper:9000');
    // Retry finds the embed again, wherever the text moved it.
    session.applyEdit({ from: 0, to: 0, insert: 'More\n' });
    failed.action!.run();
    await settle();
    expect(session.getText()).toBe('More\nIntro\n![[Recording 2.m4a]]\n> Finally.');
    expect(transcribe).toHaveBeenCalledTimes(3);
    session.dispose();
  });

  it('transcribes nothing at the cursor without a recording there, or without a service', async () => {
    const session = await open('Just text');
    const transcribe = vi.spyOn(api, 'transcribe');
    await transcribeAtCursor(session);
    expect(useToasts.getState().toasts.at(-1)?.message).toBe('Place the cursor on the line of an audio embed to transcribe it.');
    queryClient.clear();
    vi.spyOn(api, 'getTranscriptionStatus').mockResolvedValue({ enabled: false, service: null, language: null, maxBytes: 1 });
    await transcribeAtCursor(session);
    expect(useToasts.getState().toasts.at(-1)?.message).toMatch(/^Transcription is off/);
    expect(transcribe).not.toHaveBeenCalled();
    session.dispose();
  });
});

// ---------- the whole flow, with a fake recorder ----------

class FakeVoiceRecorder {
  mimeType = 'audio/mp4';
  onEnded: ((blob: Blob | null) => void) | null = null;
  status = 'idle';
  startResult: Promise<void> = Promise.resolve();
  blob: Blob | null = new Blob(['audio'], { type: 'audio/mp4' });
  ms = 0;
  start() {
    this.status = 'recording';
    return this.startResult;
  }
  pause() {
    this.status = 'paused';
  }
  resume() {
    this.status = 'recording';
  }
  stop() {
    this.status = 'stopped';
    return Promise.resolve(this.blob);
  }
  cancel() {
    this.status = 'stopped';
  }
  elapsed() {
    return this.ms;
  }
  level() {
    return 0.3;
  }
}

describe('recording a voice note', () => {
  let recorder: FakeVoiceRecorder;
  let restore: () => void;

  beforeEach(() => {
    recorder = new FakeVoiceRecorder();
    restore = setRecorderFactory(() => recorder as unknown as VoiceRecorder);
  });

  afterEach(() => restore());

  it('marks its place, follows edits, and saves into the note with the transcript', async () => {
    // No editor showed this note yet (the reading view on the phone): the recording goes at the end.
    const session = await open('Line one.\nLine two.');
    vi.spyOn(api, 'uploadAttachment').mockImplementation(async (name) => attachment(name));
    vi.spyOn(api, 'transcribe').mockImplementation(async (path) => ({ path, text: 'Remember the keys.', language: 'en', millis: 3 }));
    startVoiceNote(session);
    expect(useVoice.getState()).toMatchObject({ phase: 'starting', path: 'Notes/a.md' });
    expect(pendingUploads(session.editorState)).toEqual([expect.objectContaining({ verb: 'Recording', label: 'voice note' })]);
    await settle();
    expect(useVoice.getState().phase).toBe('recording');
    pauseVoiceNote();
    expect(useVoice.getState().phase).toBe('paused');
    resumeVoiceNote();
    session.applyEdit({ from: 0, to: 0, insert: '# Title\n' });
    await act(() => finishVoiceNote());
    await settle();
    expect(useVoice.getState().phase).toBe('idle');
    const text = session.getText();
    expect(text).toMatch(/^# Title\nLine one\.\nLine two\.\n!\[\[Recording \d{14}\.m4a\]\]\n> Remember the keys\.$/);
    expect(pendingUploads(session.editorState)).toEqual([]);
    session.dispose();
  });

  it('removes the mark when the recording is discarded or cannot start', async () => {
    const session = await open('Text');
    startVoiceNote(session);
    await settle();
    cancelVoiceNote();
    expect(pendingUploads(session.editorState)).toEqual([]);
    expect(useVoice.getState().phase).toBe('idle');

    recorder.startResult = Promise.reject(new DOMException('denied', 'NotAllowedError'));
    startVoiceNote(session);
    await settle();
    expect(pendingUploads(session.editorState)).toEqual([]);
    expect(useToasts.getState().toasts.at(-1)?.message).toMatch(/Microphone access was refused/);
    expect(session.getText()).toBe('Text');
    session.dispose();
  });

  it('saves nothing for an empty recording, and only one recording runs at a time', async () => {
    const session = await open('Text');
    const upload = vi.spyOn(api, 'uploadAttachment');
    recorder.blob = null;
    startVoiceNote(session);
    startVoiceNote(session);
    expect(useToasts.getState().toasts.at(-1)?.message).toBe('A recording is already running');
    await settle();
    await act(() => finishVoiceNote());
    expect(useToasts.getState().toasts.at(-1)?.message).toBe('Nothing was recorded.');
    expect(upload).not.toHaveBeenCalled();
    expect(session.getText()).toBe('Text');
    session.dispose();
  });

  it('saves what it has when the microphone goes away, and skips the transcript when turned off', async () => {
    const session = await open('');
    setTranscribeNewRecordings(false);
    vi.spyOn(api, 'uploadAttachment').mockImplementation(async (name) => attachment(name));
    const transcribe = vi.spyOn(api, 'transcribe');
    startVoiceNote(session);
    await settle();
    recorder.onEnded!(new Blob(['partial'], { type: 'audio/webm;codecs=opus' }));
    await settle();
    expect(session.getText()).toMatch(/^!\[\[Recording \d{14}\.webm\]\]$/);
    expect(transcribe).not.toHaveBeenCalled();
    expect(useToasts.getState().toasts.some((t) => t.message.startsWith('The recording stopped'))).toBe(true);
    setTranscribeNewRecordings(true);
    session.dispose();
  });
});

describe('transcriptionErrorMessage', () => {
  it('uses the server’s words, and says when the server could not be reached', async () => {
    const { transcriptionErrorMessage } = await import('./voiceNotes');
    const { TransientError } = await import('../../api/client');
    expect(transcriptionErrorMessage(new ApiError({ type: 'x', title: 'Too large', status: 413, code: 'too-large', detail: 'Recordings larger than 25 MB are not transcribed (notes.transcription.max-size)' }))).toBe(
      'Recordings larger than 25 MB are not transcribed (notes.transcription.max-size)',
    );
    expect(transcriptionErrorMessage(new ApiError({ type: 'x', title: 'Transcription is off', status: 409, code: 'transcription-off' }))).toBe('Transcription is off');
    expect(transcriptionErrorMessage(new TransientError('HTTP 502', 502))).toBe('the server could not be reached');
    expect(transcriptionErrorMessage(new Error('boom'))).toBe('boom');
  });
});
