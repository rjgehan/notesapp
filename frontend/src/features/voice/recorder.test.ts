import { describe, expect, it, vi } from 'vitest';
import { canRecord, extensionFor, formatDuration, MIME_PREFERENCES, pickMimeType, recordingErrorMessage, recordingName, VoiceRecorder, type RecorderEnv } from './recorder';

describe('recording formats and names', () => {
  it('prefer AAC in MP4, then Opus in WebM or Ogg, then whatever the browser has', () => {
    const only = (...types: string[]) => (t: string) => types.includes(t);
    expect(pickMimeType(only(...MIME_PREFERENCES))).toBe('audio/mp4;codecs=mp4a.40.2');
    // iOS Safari before AAC was named: plain audio/mp4.
    expect(pickMimeType(only('audio/mp4'))).toBe('audio/mp4');
    expect(pickMimeType(only('audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'))).toBe('audio/webm;codecs=opus');
    expect(pickMimeType(only('audio/ogg;codecs=opus', 'audio/webm'))).toBe('audio/ogg;codecs=opus');
    expect(pickMimeType(only())).toBe('');
    expect(pickMimeType(undefined)).toBe('');
  });

  it('name files by what was recorded, as Obsidian does', () => {
    expect(extensionFor('audio/mp4;codecs=mp4a.40.2')).toBe('m4a');
    expect(extensionFor('audio/mp4')).toBe('m4a');
    expect(extensionFor('video/mp4')).toBe('m4a');
    expect(extensionFor('audio/webm;codecs=opus')).toBe('webm');
    expect(extensionFor('audio/ogg; codecs=opus')).toBe('ogg');
    expect(extensionFor('audio/wav')).toBe('wav');
    expect(extensionFor('')).toBe('webm');
    expect(recordingName('m4a', new Date(2026, 9, 21, 14, 30, 5))).toBe('Recording 20261021143005.m4a');
  });

  it('format durations', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(7_900)).toBe('0:07');
    expect(formatDuration(754_000)).toBe('12:34');
    expect(formatDuration(3_723_000)).toBe('1:02:03');
    expect(formatDuration(-5)).toBe('0:00');
  });

  it('explain why recording could not start', () => {
    expect(recordingErrorMessage(new DOMException('x', 'NotAllowedError'))).toMatch(/refused/);
    expect(recordingErrorMessage(new DOMException('x', 'NotFoundError'))).toBe('No microphone was found.');
    expect(recordingErrorMessage(new DOMException('x', 'NotReadableError'))).toMatch(/in use/);
    expect(recordingErrorMessage(new DOMException('x', 'NotSupportedError'))).toMatch(/cannot record/);
    expect(recordingErrorMessage(new Error('boom'))).toBe('Recording could not start: boom');
    expect(recordingErrorMessage(null)).toBe('Recording could not start.');
  });
});

// ---------- the recorder against a fake MediaRecorder ----------

class FakeTrack extends EventTarget {
  stopped = false;
  stop() {
    this.stopped = true;
  }
}

function fakeStream() {
  const track = new FakeTrack();
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
  return { stream, track };
}

class FakeRecorder extends EventTarget {
  static instances: FakeRecorder[] = [];
  static supported = ['audio/mp4;codecs=mp4a.40.2'];
  static isTypeSupported(t: string) {
    return FakeRecorder.supported.includes(t);
  }
  state: 'inactive' | 'recording' | 'paused' = 'inactive';
  readonly mimeType: string;
  readonly options: MediaRecorderOptions;
  timeslice: number | undefined;
  constructor(_stream: MediaStream, options: MediaRecorderOptions = {}) {
    super();
    this.options = options;
    this.mimeType = options.mimeType ?? 'audio/webm';
    FakeRecorder.instances.push(this);
  }
  start(timeslice?: number) {
    this.timeslice = timeslice;
    this.state = 'recording';
  }
  pause() {
    this.state = 'paused';
  }
  resume() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    queueMicrotask(() => this.dispatchEvent(new Event('stop')));
  }
  /** Delivers a piece of audio, as the timeslice does. */
  data(bytes: string) {
    const e = new Event('dataavailable') as Event & { data: Blob };
    e.data = new Blob([bytes]);
    this.dispatchEvent(e);
  }
}

function env(overrides: Partial<RecorderEnv> = {}) {
  let now = 1000;
  const { stream, track } = fakeStream();
  const released = vi.fn(() => Promise.resolve());
  const e: RecorderEnv & { advance(ms: number): void } = {
    getUserMedia: vi.fn(() => Promise.resolve(stream)),
    MediaRecorder: FakeRecorder as unknown as typeof MediaRecorder,
    wakeLock: () => Promise.resolve({ release: released }),
    now: () => now,
    advance: (ms) => {
      now += ms;
    },
    ...overrides,
  };
  return { env: e, track, released };
}

describe('VoiceRecorder', () => {
  it('records the microphone in pieces and hands over the audio of the type it recorded', async () => {
    const { env: e, track, released } = env();
    const r = new VoiceRecorder(e);
    await r.start();
    expect(e.getUserMedia).toHaveBeenCalledWith({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const rec = FakeRecorder.instances.at(-1)!;
    expect(rec.options).toEqual({ mimeType: 'audio/mp4;codecs=mp4a.40.2', audioBitsPerSecond: 64_000 });
    expect(rec.timeslice).toBe(1000);
    expect(r.status).toBe('recording');
    expect(r.mimeType).toBe('audio/mp4;codecs=mp4a.40.2');
    rec.data('abc');
    e.advance(2000);
    r.pause();
    e.advance(5000);
    expect(r.elapsed()).toBe(2000);
    r.resume();
    e.advance(1500);
    rec.data('de');
    const blob = await r.stop();
    expect(blob?.type).toBe('audio/mp4;codecs=mp4a.40.2');
    expect(await blob?.text()).toBe('abcde');
    expect(r.elapsed()).toBe(3500);
    expect(track.stopped).toBe(true);
    await Promise.resolve();
    expect(released).toHaveBeenCalled();
  });

  it('lets the browser choose the format when it names none of the preferred ones', async () => {
    FakeRecorder.supported = [];
    try {
      const r = new VoiceRecorder(env().env);
      await r.start();
      expect(FakeRecorder.instances.at(-1)!.options).toEqual({ audioBitsPerSecond: 64_000 });
      expect(r.mimeType).toBe('audio/webm');
    } finally {
      FakeRecorder.supported = ['audio/mp4;codecs=mp4a.40.2'];
    }
  });

  it('throws the audio away on cancel and releases the microphone', async () => {
    const onEnded = vi.fn();
    const { env: e, track } = env();
    const r = new VoiceRecorder(e);
    r.onEnded = onEnded;
    await r.start();
    FakeRecorder.instances.at(-1)!.data('abc');
    r.cancel();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(track.stopped).toBe(true);
    expect(onEnded).not.toHaveBeenCalled();
    expect(await r.stop()).toBeNull();
  });

  it('keeps what it has when the microphone goes away by itself', async () => {
    const onEnded = vi.fn();
    const { env: e, track } = env();
    const r = new VoiceRecorder(e);
    r.onEnded = onEnded;
    await r.start();
    FakeRecorder.instances.at(-1)!.data('partial');
    track.dispatchEvent(new Event('ended'));
    await vi.waitFor(() => expect(onEnded).toHaveBeenCalledTimes(1));
    expect(await (onEnded.mock.calls[0][0] as Blob).text()).toBe('partial');
  });

  it('hands nothing over for a recording without audio', async () => {
    const r = new VoiceRecorder(env().env);
    await r.start();
    expect(await r.stop()).toBeNull();
  });

  it('passes on a refused microphone, and refuses without MediaRecorder', async () => {
    const refused = new DOMException('denied', 'NotAllowedError');
    const r = new VoiceRecorder(env({ getUserMedia: () => Promise.reject(refused) }).env);
    await expect(r.start()).rejects.toBe(refused);
    expect(r.status).toBe('idle');
    await expect(new VoiceRecorder(env({ MediaRecorder: undefined }).env).start()).rejects.toMatchObject({ name: 'NotSupportedError' });
    expect(canRecord(env({ MediaRecorder: undefined }).env)).toBe(false);
    expect(canRecord(env({ getUserMedia: undefined }).env)).toBe(false);
    expect(canRecord(env().env)).toBe(true);
  });

  it('releases a microphone granted after the recording was cancelled', async () => {
    let grant!: (s: MediaStream) => void;
    const { stream, track } = fakeStream();
    const r = new VoiceRecorder(env({ getUserMedia: () => new Promise((resolve) => (grant = resolve)) }).env);
    const started = r.start();
    r.cancel();
    grant(stream);
    await started;
    expect(track.stopped).toBe(true);
    expect(r.status).toBe('stopped');
  });

  it('measures the input level with an analyser', async () => {
    const analyser = { fftSize: 0, getByteTimeDomainData: (data: Uint8Array) => data.fill(128).set([128, 192, 64], 0) };
    const context = { createAnalyser: () => analyser, createMediaStreamSource: () => ({ connect: vi.fn() }), resume: () => Promise.resolve(), close: vi.fn(() => Promise.resolve()) };
    const AudioContext = vi.fn(function (this: unknown) {
      return context;
    }) as unknown as typeof window.AudioContext;
    const r = new VoiceRecorder(env({ AudioContext }).env);
    expect(r.level()).toBe(0);
    await r.start();
    expect(r.level()).toBe(0.5);
    await r.stop();
    expect(context.close).toHaveBeenCalled();
  });
});
