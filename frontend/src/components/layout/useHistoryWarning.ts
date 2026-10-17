import { useStatus } from '../../api/hooks';
import { formatSince } from '../../features/format';

/** "History is not being saved" while /api/status reports git failing (DESIGN §6.18); null otherwise. */
export function useHistoryWarning(): string | null {
  const status = useStatus().data;
  if (!status || status.git.state !== 'failing') return null;
  return status.git.failingSince ? `History is not being saved (${formatSince(status.git.failingSince)})` : 'History is not being saved';
}
