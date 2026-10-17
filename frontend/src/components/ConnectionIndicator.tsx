// Connection and offline indicator (DESIGN §6.18): Live (green), Reconnecting (amber), Offline
// (red). A labelled item in the desktop status bar, a dot on the phone TopBar title.
import { useUi, type ConnectionState } from '../state/ui';

const LABEL: Record<ConnectionState, string> = {
  live: 'Live',
  reconnecting: 'Reconnecting…',
  offline: 'Offline',
};

const TITLE: Record<ConnectionState, string> = {
  live: 'Connected: changes from other devices appear live',
  reconnecting: 'Reconnecting to the server',
  offline: 'Offline: edits are saved on this device and will sync when the connection returns',
};

export function ConnectionIndicator({ compact = false }: { compact?: boolean }) {
  const connection = useUi((s) => s.connection);
  if (compact) {
    return <span className={`connection-dot is-${connection}`} role="img" aria-label={`Connection: ${LABEL[connection]}`} title={TITLE[connection]} />;
  }
  return (
    <span className={`status-item connection-indicator is-${connection}`} title={TITLE[connection]}>
      <span className={`connection-dot is-${connection}`} aria-hidden />
      {LABEL[connection]}
    </span>
  );
}
