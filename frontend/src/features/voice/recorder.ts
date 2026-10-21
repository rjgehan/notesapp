// Recording audio in the browser (ROADMAP item 33, DESIGN §6.21): MediaRecorder over the microphone, with
// the format each browser records best (iOS Safari: AAC in MP4; Chrome: AAC in MP4 where it can, else Opus
// in WebM; Firefox: Opus in Ogg), a level meter for the panel, and a screen wake lock so the phone does
// not sleep mid-sentence. Kept apart from the UI so it can be tested with fakes.
import { dayjs } from '../dates';

/** Formats in order of preference: AAC/MP4 plays on every device (the iPhone too) and Whisper reads them all. */
export const MIME_PREFERENCES = ['audio/mp4;codecs=mp4a.40.2', 'audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg'];

/** Speech needs little: 64 kbit/s is about 0.5 MB a minute, so a long memo stays well under the upload limit. */
export const AUDIO_BITS_PER_SECOND = 64_000;

/** The first supported format, or '' to let the browser choose. */
export function pickMimeType(isTypeSupported: ((type: string) => boolean) | undefined): string {
  if (!isTypeSupported) return '';
  return MIME_PREFERENCES.find((t) => isTypeSupported(t)) ?? '';
}

/** The file extension for a recorded MIME type (`audio/mp4` is `.m4a`, as Obsidian and iOS name it). */
export function extensionFor(mimeType: string): string {
  const type = mimeType.split(';')[0].trim().toLowerCase();
  switch (type) {
    case 'audio/mp4':
    case 'audio/x-m4a':
    case 'audio/aac':
    case 'video/mp4':
      return 'm4a';
    case 'audio/ogg':
      return 'ogg';
    case 'audio/wav':
    case 'audio/wave':
      return 'wav';
    case 'audio/mpeg':
      return 'mp3';
    default:
      // audio/webm, and browsers that report nothing (Chrome's default is WebM).
      return 'webm';
  }
}

/** `Recording YYYYMMDDHHmmss.<ext>` in local time, the name Obsidian's audio recorder gives. */
export function recordingName(extension: string, startedAt: Date): string {
  return `Recording ${dayjs(startedAt).format('YYYYMMDDHHmmss')}.${extension}`;
}

/** `0:07`, `12:34`, `1:02:03`. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

/** What the user can do about a failed start. */
export function recordingErrorMessage(e: unknown): string {
  const name = e instanceof DOMException || e instanceof Error ? e.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Microphone access was refused. Allow the microphone for this site in the browser’s settings and try again.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No microphone was found.';
    case 'NotReadableError':
    case 'AbortError':
      return 'The microphone is in use by another app.';
    case 'NotSupportedError':
      return 'This browser cannot record audio.';
    default:
      return e instanceof Error && e.message ? `Recording could not start: ${e.message}` : 'Recording could not start.';
  }
}

export interface RecorderEnv {
  getUserMedia?(constraints: MediaStreamConstraints): Promise<MediaStream>;
  MediaRecorder?: typeof MediaRecorder;
  AudioContext?: typeof AudioContext;
  wakeLock?(): Promise<{ release(): Promise<void> } | null>;
  now(): number;
}

export function browserEnv(): RecorderEnv {
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  const win = typeof window === 'undefined' ? undefined : (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext });
  return {
    getUserMedia: nav?.mediaDevices?.getUserMedia ? (c) => nav.mediaDevices.getUserMedia(c) : undefined,
    MediaRecorder: typeof MediaRecorder === 'undefined' ? undefined : MediaRecorder,
    AudioContext: win?.AudioContext ?? win?.webkitAudioContext,
    wakeLock: nav && 'wakeLock' in nav ? () => (nav as Navigator & { wakeLock: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock.request('screen').catch(() => null) : undefined,
    now: () => performance.now(),
  };
}

/** True when this browser can record at all (in a secure context, with MediaRecorder). */
export function canRecord(env: RecorderEnv = browserEnv()): boolean {
  return !!env.getUserMedia && !!env.MediaRecorder;
}

export type RecorderStatus = 'idle' | 'starting' | 'recording' | 'paused' | 'stopped';

/**
 * One recording. `start()` asks for the microphone; `stop()` resolves with the audio (the chunks
 * MediaRecorder delivered, of its actual type). The recording also ends by itself when the microphone
 * goes away (another app took it, the phone locked): `onEnded` then gets what was recorded.
 */
export class VoiceRecorder {
  readonly #env: RecorderEnv;
  #status: RecorderStatus = 'idle';
  #recorder: MediaRecorder | null = null;
  #stream: MediaStream | null = null;
  #chunks: Blob[] = [];
  #mimeType = '';
  #elapsedBefore = 0;
  #runningSince: number | null = null;
  #audio: { context: AudioContext; analyser: AnalyserNode; data: Uint8Array<ArrayBuffer> } | null = null;
  #wakeLock: { release(): Promise<void> } | null = null;
  #done: Promise<Blob | null> | null = null;
  #cancelled = false;
  #endedByItself = false;
  /** Called when the recording ended without `stop()` or `cancel()`. */
  onEnded: ((blob: Blob | null) => void) | null = null;

  constructor(env: RecorderEnv = browserEnv()) {
    this.#env = env;
    // The meter's AudioContext is created here, inside the tap: iOS starts it suspended otherwise.
    if (env.AudioContext) {
      try {
        const context = new env.AudioContext();
        const analyser = context.createAnalyser();
        analyser.fftSize = 512;
        this.#audio = { context, analyser, data: new Uint8Array(new ArrayBuffer(analyser.fftSize)) };
      } catch {
        this.#audio = null;
      }
    }
  }

  get status(): RecorderStatus {
    return this.#status;
  }

  /** The recorded MIME type (known once recording started). */
  get mimeType(): string {
    return this.#mimeType;
  }

  async start(): Promise<void> {
    const { getUserMedia, MediaRecorder: Recorder } = this.#env;
    if (!getUserMedia || !Recorder) throw new DOMException('This browser cannot record audio', 'NotSupportedError');
    this.#status = 'starting';
    let stream: MediaStream;
    try {
      stream = await getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
      this.#status = 'idle';
      this.#closeAudio();
      throw e;
    }
    if (this.#cancelled) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    this.#stream = stream;
    const mimeType = pickMimeType((t) => Recorder.isTypeSupported(t));
    const recorder = new Recorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: AUDIO_BITS_PER_SECOND });
    this.#recorder = recorder;
    this.#done = new Promise((resolve) => {
      recorder.addEventListener('dataavailable', (e: BlobEvent) => {
        if (e.data && e.data.size > 0) this.#chunks.push(e.data);
      });
      recorder.addEventListener('stop', () => {
        const ended = this.#endedByItself || this.#status !== 'stopped';
        this.#finish();
        const blob = this.#cancelled || this.#chunks.length === 0 ? null : new Blob(this.#chunks, { type: this.#mimeType });
        resolve(blob);
        if (ended && !this.#cancelled) this.onEnded?.(blob);
      });
    });
    // The microphone going away (another app, an unplugged headset) ends the recording with what it has.
    for (const track of stream.getAudioTracks()) {
      track.addEventListener('ended', () => {
        if (this.#status === 'stopped') return;
        this.#endedByItself = true;
        this.#stopRecorder();
      });
    }
    // A timeslice: the audio arrives in pieces, so a recording cut short by the phone keeps most of it.
    recorder.start(1000);
    this.#mimeType = recorder.mimeType || mimeType;
    this.#status = 'recording';
    this.#runningSince = this.#env.now();
    if (this.#audio) {
      try {
        this.#audio.context.createMediaStreamSource(stream).connect(this.#audio.analyser);
        void this.#audio.context.resume?.().catch(() => {});
      } catch {
        this.#closeAudio();
      }
    }
    void this.#env.wakeLock?.().then((lock) => {
      if (this.#status === 'recording' || this.#status === 'paused') this.#wakeLock = lock;
      else void lock?.release().catch(() => {});
    });
  }

  pause(): void {
    if (this.#status !== 'recording' || !this.#recorder) return;
    this.#recorder.pause();
    this.#elapsedBefore = this.elapsed();
    this.#runningSince = null;
    this.#status = 'paused';
  }

  resume(): void {
    if (this.#status !== 'paused' || !this.#recorder) return;
    this.#recorder.resume();
    this.#runningSince = this.#env.now();
    this.#status = 'recording';
  }

  /** Ends the recording; resolves with the audio, or null when nothing was recorded. */
  stop(): Promise<Blob | null> {
    if (!this.#done) {
      this.#cancelled = true;
      this.#finish();
      return Promise.resolve(null);
    }
    this.#stopRecorder();
    return this.#done;
  }

  /** Ends the recording and throws the audio away. */
  cancel(): void {
    this.#cancelled = true;
    if (this.#done) this.#stopRecorder();
    else this.#finish();
  }

  /** Recorded time in ms, pauses excluded. */
  elapsed(): number {
    return this.#elapsedBefore + (this.#runningSince === null ? 0 : this.#env.now() - this.#runningSince);
  }

  /** The input level, 0–1 (the peak of the last few milliseconds), for the meter. */
  level(): number {
    if (!this.#audio || this.#status !== 'recording') return 0;
    const { analyser, data } = this.#audio;
    analyser.getByteTimeDomainData(data);
    let peak = 0;
    for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
    return Math.min(1, peak / 128);
  }

  #stopRecorder(): void {
    const recorder = this.#recorder;
    if (this.#status === 'stopped' || !recorder) return;
    this.#elapsedBefore = this.elapsed();
    this.#runningSince = null;
    this.#status = 'stopped';
    if (recorder.state !== 'inactive') recorder.stop();
    // The microphone is released at once (the recording indicator goes), not when `stop` arrives.
    for (const track of this.#stream?.getTracks() ?? []) track.stop();
  }

  #finish(): void {
    this.#status = 'stopped';
    this.#runningSince = null;
    for (const track of this.#stream?.getTracks() ?? []) track.stop();
    this.#stream = null;
    this.#closeAudio();
    void this.#wakeLock?.release().catch(() => {});
    this.#wakeLock = null;
  }

  #closeAudio(): void {
    void this.#audio?.context.close().catch(() => {});
    this.#audio = null;
  }
}
