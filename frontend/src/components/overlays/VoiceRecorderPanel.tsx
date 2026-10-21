// The recording panel of a voice note (ROADMAP item 33, DESIGN §6.30): time, level, pause, done and discard,
// and whether this recording is transcribed. It floats above the workspace (and the phone's toolbar), and
// stays while the user moves around the app; the recording still goes into the note it was started in.
import { useQuery } from '@tanstack/react-query';
import { Check, Mic, Pause, Play, Trash2 } from 'lucide-react';
import { api } from '../../api/endpoints';
import { queryKeys, STALE } from '../../api/queryKeys';
import { displayName } from '../../features/paths';
import { formatDuration } from '../../features/voice/recorder';
import { cancelVoiceNote, finishVoiceNote, pauseVoiceNote, resumeVoiceNote, setTranscribeNewRecordings, useVoice } from '../../features/voice/voiceNotes';
import { confirmAction } from '../../state/dialogs';

/** Discarding a recording longer than this asks first. */
const CONFIRM_DISCARD_MS = 10_000;

export function VoiceRecorderPanel() {
  const { phase, path, elapsed, level, transcribe } = useVoice();
  const status = useQuery({ queryKey: queryKeys.transcription(), queryFn: () => api.getTranscriptionStatus(), staleTime: STALE.transcription, enabled: phase !== 'idle' });
  if (phase === 'idle') return null;

  const recording = phase === 'recording';
  const busy = phase === 'starting' || phase === 'saving';
  const discard = () => {
    if (elapsed < CONFIRM_DISCARD_MS) {
      cancelVoiceNote();
      return;
    }
    void confirmAction({ title: 'Discard recording?', message: `${formatDuration(elapsed)} of audio will be thrown away.`, confirmLabel: 'Discard', danger: true }).then((ok) => {
      if (ok) cancelVoiceNote();
    });
  };

  return (
    <section className={`voice-panel is-${phase}`} aria-label="Voice note">
      <div className="voice-panel-main">
        <Mic size={16} className="voice-mic" aria-hidden />
        <span className="voice-time" role="timer" aria-label={`Recorded ${formatDuration(elapsed)}`}>
          {formatDuration(elapsed)}
        </span>
        <span className="voice-meter" aria-hidden>
          <span className="voice-meter-level" style={{ transform: `scaleX(${recording ? Math.max(0.04, level) : 0})` }} />
        </span>
        <span className="voice-status" aria-live="polite">
          {phase === 'starting' ? 'Starting…' : phase === 'saving' ? 'Saving…' : phase === 'paused' ? 'Paused' : 'Recording'}
        </span>
      </div>
      <div className="voice-panel-row">
        <span className="voice-target" title={path ?? undefined}>
          Into {path ? displayName(path) : 'the note'}
        </span>
        {status.data?.enabled && (
          <label className="voice-transcribe">
            <input type="checkbox" checked={transcribe} disabled={phase === 'saving'} onChange={(e) => setTranscribeNewRecordings(e.target.checked)} /> Transcribe
          </label>
        )}
      </div>
      <div className="voice-panel-actions">
        <button type="button" className="button" disabled={busy} onClick={discard} aria-label="Discard recording">
          <Trash2 size={15} aria-hidden /> Discard
        </button>
        <button type="button" className="button" disabled={busy} onClick={recording ? pauseVoiceNote : resumeVoiceNote}>
          {recording ? <Pause size={15} aria-hidden /> : <Play size={15} aria-hidden />} {recording ? 'Pause' : 'Resume'}
        </button>
        <button type="button" className="button button-primary" disabled={busy} onClick={() => void finishVoiceNote()}>
          <Check size={15} aria-hidden /> Done
        </button>
      </div>
    </section>
  );
}
