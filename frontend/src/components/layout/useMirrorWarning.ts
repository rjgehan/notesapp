import { useStatus } from '../../api/hooks';
import type { MirrorStatus } from '../../api/types';
import { mirrorWarning } from '../../features/mirror';

/** The mirror's warning while /api/status reports it failing or diverged (DESIGN §6.18); null otherwise. */
export function useMirrorWarning(): { text: string; mirror: MirrorStatus } | null {
  const mirror = useStatus().data?.mirror;
  const text = mirrorWarning(mirror);
  return mirror && text ? { text, mirror } : null;
}
