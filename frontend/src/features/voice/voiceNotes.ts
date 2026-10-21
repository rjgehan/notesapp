// Voice notes (ROADMAP item 33, DESIGN §6.21): record in the app, save the audio as an attachment, embed it
// where the cursor was, and, when the server has a transcription service, put the transcript under the
// embed as a quote. The text lands in the note, so search finds it like anything typed.
//
// The insertion points are upload widgets (DESIGN §6.6 #10): positions in the editor state that follow
// every edit, never document text. While the audio uploads and the service transcribes, the note can be
// edited, closed and reopened; the embed and then the transcript go where the cursor was.
import { create } from 'zustand';
import { api } from '../../api/endpoints';
import { ApiError, errorMessage, TransientError } from '../../api/client';
import { currentTree } from '../../api/hooks';
import { queryClient } from '../../api/queryClient';
import { queryKeys, STALE } from '../../api/queryKeys';
import type { AttachmentResult, TranscriptionStatus } from '../../api/types';
import { newIdempotencyKey } from '../../state/clientId';
import { toast } from '../../state/toasts';
import type { DocumentSession } from '../../sync/DocumentSession';
import { applyAttachmentResult } from '../../sync/applyEvents';
import { documents } from '../../sync/instance';
import { syncTarget } from '../../sync/liveSync';
import { resolve } from '../links';
import { lastSegment } from '../paths';
import { parseMarkdownDestination, parseWikiBody } from '../syntax';
import { canRecord, extensionFor, recordingErrorMessage, recordingName, VoiceRecorder } from './recorder';

// ---------- per-device preference ----------

const PREFS_KEY = 'notesapp:voice';

/** Whether new recordings are transcribed (when the server can), on this device. On unless turned off. */
export function transcribeNewRecordings(): boolean {
  try {
    return localStorage.getItem(PREFS_KEY) !== 'no-transcripts';
  } catch {
    return true;
  }
}

export function setTranscribeNewRecordings(on: boolean): void {
  try {
    if (on) localStorage.removeItem(PREFS_KEY);
    else localStorage.setItem(PREFS_KEY, 'no-transcripts');
  } catch {
    // This page load only.
  }
  useVoice.setState({ transcribe: on });
}

// ---------- text ----------

/** The embed on a line of its own (the cursor may be mid-line, or before text). */
export function embedInsertion(doc: string, pos: number, markdown: string): string {
  return (pos > 0 && doc[pos - 1] !== '\n' ? '\n' : '') + markdown + (pos < doc.length && doc[pos] !== '\n' ? '\n' : '');
}

/**
 * The transcript as a quote right under the embed at `pos`: on a new line, and ending a block, so the
 * text after it is not drawn into the quote (Markdown continues a quote into the next line otherwise).
 */
export function transcriptInsertion(doc: string, pos: number, text: string): string {
  const quote = text
    .trim()
    .split(/\r?\n/)
    .map((line) => (line.trim() ? `> ${line.trim()}` : '>'))
    .join('\n');
  const before = pos > 0 && doc[pos - 1] !== '\n' ? '\n' : '';
  const rest = doc.slice(pos);
  const after = rest === '' || rest === '\n' || rest.startsWith('\n\n') ? '' : rest.startsWith('\n') ? '\n' : '\n\n';
  return before + quote + after;
}

/** An audio or video embed on the line of `cursor`: its file and where the embed ends. */
export function recordingEmbedAt(doc: string, cursor: number, source: string): { path: string; end: number } | null {
  const lineStart = doc.lastIndexOf('\n', cursor - 1) + 1;
  const lineEnd = doc.indexOf('\n', cursor) < 0 ? doc.length : doc.indexOf('\n', cursor);
  const line = doc.slice(lineStart, lineEnd);
  const tree = currentTree();
  const candidates: Array<{ path: string; start: number; end: number }> = [];
  for (const m of line.matchAll(/!\[\[([^\]\n]+)\]\]|!\[[^\]\n]*\]\(([^)\n]+)\)/g)) {
    let target: string;
    if (m[1] !== undefined) target = parseWikiBody(m[1]).target;
    else target = parseMarkdownDestination(m[2]).target;
    const path = resolve(target, source, tree.links);
    const kind = path ? tree.byPath.get(path)?.kind : undefined;
    if (path && (kind === 'audio' || kind === 'video')) candidates.push({ path, start: lineStart + m.index, end: lineStart + m.index + m[0].length });
  }
  const hit = candidates.find((c) => cursor >= c.start && cursor <= c.end) ?? candidates[0];
  return hit ? { path: hit.path, end: hit.end } : null;
}

/** Why a transcription failed: the server's own words (its generic texts, such as "too large to edit", do not fit). */
export function transcriptionErrorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.problem.detail || e.problem.title;
  if (e instanceof TransientError) return 'the server could not be reached';
  return errorMessage(e);
}

// ---------- the recording panel's state ----------

export type VoicePhase = 'idle' | 'starting' | 'recording' | 'paused' | 'saving';

interface VoiceState {
  phase: VoicePhase;
  /** The note the recording goes into. */
  path: string | null;
  elapsed: number;
  level: number;
  transcribe: boolean;
}

export const useVoice = create<VoiceState>()(() => ({ phase: 'idle', path: null, elapsed: 0, level: 0, transcribe: transcribeNewRecordings() }));

interface Active {
  recorder: VoiceRecorder;
  session: DocumentSession;
  /** The widget that marks where the recording goes, while it is made; it follows every edit. */
  mark: number | null;
  startedAt: Date;
  holder: string;
  timer: ReturnType<typeof setInterval> | null;
}

let active: Active | null = null;
let holders = 0;

/** The recorder and whether this browser can record; tests replace them. */
let makeRecorder = (): VoiceRecorder => new VoiceRecorder();
let recordingSupported = (): boolean => canRecord();

export function setRecorderFactory(factory: () => VoiceRecorder): () => void {
  const previous = [makeRecorder, recordingSupported] as const;
  makeRecorder = factory;
  recordingSupported = () => true;
  return () => {
    [makeRecorder, recordingSupported] = previous;
  };
}

/** The transcription service's status, fetched once in a while. */
export function transcriptionStatus(): Promise<TranscriptionStatus> {
  return queryClient.fetchQuery({ queryKey: queryKeys.transcription(), queryFn: () => api.getTranscriptionStatus(), staleTime: STALE.transcription });
}

/**
 * Starts recording a voice note into the note of `session`, at its cursor. Call it inside the user's tap
 * (the level meter's audio context needs the gesture on iOS).
 */
export function startVoiceNote(session: DocumentSession): void {
  if (active) {
    toast('A recording is already running');
    return;
  }
  if (!recordingSupported()) {
    toast(window.isSecureContext === false ? 'Recording needs the app’s HTTPS address.' : 'This browser cannot record audio.', { kind: 'error' });
    return;
  }
  if (!session.isEditable()) {
    toast('This note cannot be edited right now.', { kind: 'error' });
    return;
  }
  const recorder = makeRecorder();
  const holder = `voice-note-${++holders}`;
  // The note stays open for the recording, whatever the user opens meanwhile.
  documents.hold(session, holder);
  // A selection stays: the recording goes after it.
  const at = session.insertionRange().to;
  const a: Active = { recorder, session, mark: session.beginUpload({ from: at, to: at }, 'voice note', 'input', 'Recording'), startedAt: new Date(), holder, timer: null };
  active = a;
  useVoice.setState({ phase: 'starting', path: session.path, elapsed: 0, level: 0 });
  recorder.onEnded = (blob) => {
    if (active !== a) return;
    toast('The recording stopped because the microphone went away. What was recorded is saved.');
    void save(a, blob);
  };
  void transcriptionStatus().catch(() => null);
  recorder.start().then(
    () => {
      if (active !== a) return;
      useVoice.setState({ phase: 'recording' });
      a.timer = setInterval(() => {
        if (active === a) useVoice.setState({ elapsed: recorder.elapsed(), level: recorder.level() });
      }, 100);
    },
    (e: unknown) => {
      if (active !== a) return;
      end(a);
      toast(recordingErrorMessage(e), { kind: 'error' });
    },
  );
}

export function pauseVoiceNote(): void {
  if (!active) return;
  active.recorder.pause();
  useVoice.setState({ phase: 'paused', level: 0, elapsed: active.recorder.elapsed() });
}

export function resumeVoiceNote(): void {
  if (!active) return;
  active.recorder.resume();
  useVoice.setState({ phase: 'recording' });
}

/** Stops and saves the recording into its note. */
export async function finishVoiceNote(): Promise<void> {
  const a = active;
  if (!a) return;
  useVoice.setState({ phase: 'saving' });
  const blob = await a.recorder.stop();
  await save(a, blob);
}

/** Stops and throws the recording away. */
export function cancelVoiceNote(): void {
  const a = active;
  if (!a) return;
  a.recorder.cancel();
  end(a);
}

function end(a: Active): void {
  if (a.timer) clearInterval(a.timer);
  if (active === a) active = null;
  if (a.mark !== null) a.session.cancelUpload(a.mark);
  a.mark = null;
  documents.release(a.session, a.holder);
  useVoice.setState({ phase: 'idle', path: null, elapsed: 0, level: 0 });
}

async function save(a: Active, blob: Blob | null): Promise<void> {
  if (active !== a) return;
  if (a.timer) clearInterval(a.timer);
  active = null;
  try {
    if (!blob || blob.size === 0) {
      toast('Nothing was recorded.');
      return;
    }
    const name = recordingName(extensionFor(blob.type || a.recorder.mimeType), a.startedAt);
    const file = new File([blob], name, { type: blob.type || a.recorder.mimeType });
    let transcribe = false;
    if (useVoice.getState().transcribe) transcribe = (await transcriptionStatus().catch(() => null))?.enabled === true;
    const pos = a.mark === null ? null : a.session.uploadPosition(a.mark);
    if (a.mark !== null) a.session.cancelUpload(a.mark);
    a.mark = null;
    // The mark is gone when the note's text was replaced meanwhile (Take theirs): the cursor then.
    await insertRecording(a.session, file, pos === null ? a.session.insertionRange() : { from: pos, to: pos }, transcribe);
  } finally {
    end(a);
  }
}

// ---------- saving and transcribing ----------

/**
 * Uploads a recording for the note of `session` and embeds it at `range`; with `transcribe`, its
 * transcript follows under the embed. A failed upload keeps the recording in memory: the toast's
 * Retry sends it again.
 */
export async function insertRecording(session: DocumentSession, file: File, range: { from: number; to: number }, transcribe: boolean): Promise<void> {
  const uploadId = session.beginUpload(range, file.name, 'input');
  // Both widgets wait at the cursor; once the embed is in, the transcript's moves after it.
  const transcriptId = uploadId !== null && transcribe ? session.beginUpload({ from: range.from, to: range.from }, file.name, 'input', 'Transcribing') : null;
  let result: AttachmentResult;
  try {
    result = await api.uploadAttachment(file.name, session.path, file, { idempotencyKey: newIdempotencyKey() });
    applyAttachmentResult(syncTarget, result);
  } catch (e) {
    if (uploadId !== null) session.cancelUpload(uploadId);
    if (transcriptId !== null) session.cancelUpload(transcriptId);
    toast(`${file.name}: ${errorMessage(e)}`, {
      kind: 'error',
      timeout: 0,
      action: { label: 'Retry', run: () => void insertRecording(session, file, session.insertionRange(), transcribe) },
    });
    return;
  }
  const inserted = uploadId !== null && session.finishUpload(uploadId, (doc, pos) => embedInsertion(doc, pos, result.markdown));
  if (!inserted) {
    if (transcriptId !== null) session.cancelUpload(transcriptId);
    toast(`Saved ${result.file.path}, but the note could not be edited to embed it.`, { kind: 'error', timeout: 0 });
    return;
  }
  // The panel is done; the transcript follows when the service has it (the widget says so meanwhile).
  if (transcriptId !== null) void transcribeInto(session, result.file.path, transcriptId);
}

/** Transcribes `audioPath` into the waiting widget `widgetId` of `session`. */
async function transcribeInto(session: DocumentSession, audioPath: string, widgetId: number): Promise<void> {
  const holder = `voice-transcript-${++holders}`;
  documents.hold(session, holder);
  const name = lastSegment(audioPath);
  try {
    const result = await api.transcribe(audioPath);
    if (!result.text.trim()) {
      session.cancelUpload(widgetId);
      toast(`No speech was recognized in ${name}.`);
      return;
    }
    if (!session.finishUpload(widgetId, (doc, pos) => transcriptInsertion(doc, pos, result.text))) {
      toast(`${name} was transcribed, but the note could not be edited to add the text.`, { kind: 'error' });
    }
  } catch (e) {
    session.cancelUpload(widgetId);
    toast(`Transcribing ${name} failed: ${transcriptionErrorMessage(e)}`, {
      kind: 'error',
      timeout: 0,
      action: { label: 'Retry', run: () => transcribeRecordingInNote(session, audioPath) },
    });
  } finally {
    documents.release(session, holder);
  }
}

/** Transcribes the recording embedded at the end position `end` (an embed in the note's text). */
export function transcribeEmbed(session: DocumentSession, audioPath: string, end: number): void {
  const widgetId = session.beginUpload({ from: end, to: end }, lastSegment(audioPath), 'input', 'Transcribing');
  if (widgetId === null) {
    toast('This note cannot be edited right now.', { kind: 'error' });
    return;
  }
  void transcribeInto(session, audioPath, widgetId);
}

/** Retry: finds the recording's embed in the note again (the text has moved on) and transcribes it there. */
function transcribeRecordingInNote(session: DocumentSession, audioPath: string): void {
  const doc = session.getText();
  const name = lastSegment(audioPath);
  for (let at = doc.indexOf(name); at >= 0; at = doc.indexOf(name, at + 1)) {
    const embed = recordingEmbedAt(doc, at, session.path);
    if (embed && embed.path === audioPath) {
      transcribeEmbed(session, audioPath, embed.end);
      return;
    }
  }
  toast(`The embed of ${name} is no longer in the note.`, { kind: 'error' });
}

/** "Transcribe recording": the audio embed on the cursor's line. */
export async function transcribeAtCursor(session: DocumentSession): Promise<void> {
  const status = await transcriptionStatus().catch(() => null);
  if (!status?.enabled) {
    toast('Transcription is off: the server has no transcription service (DEPLOY.md, Voice notes).', { kind: 'error' });
    return;
  }
  const { from } = session.insertionRange();
  const embed = recordingEmbedAt(session.getText(), from, session.path);
  if (!embed) {
    toast('Place the cursor on the line of an audio embed to transcribe it.');
    return;
  }
  transcribeEmbed(session, embed.path, embed.end);
}
