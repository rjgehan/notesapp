// Offers to update heading links when a heading of the open note is renamed by typing (ROADMAP
// item 21, DESIGN §6.24). After the text settles, the outline is compared with the one the offer
// was last decided on; a single renamed heading that links or bookmarks point at gets a toast with
// "Update links". Changes from the server (another device, a link rewrite) never count as renames.
import { useEffect, useRef } from 'react';
import { headingsFromState, type OutlineHeading } from '../../editor/outline';
import { describeUpdates, detectHeadingRename, previewHeadingRename, updateHeadingLinks } from '../../features/headingRename';
import { toast, useToasts } from '../../state/toasts';
import type { DocumentSession } from '../../sync/DocumentSession';
import { useSessionChangeCount } from '../../sync/useTextDocument';

/** How long the text must rest before an edit counts as a finished rename. */
export const SETTLE_MS = 1500;
const OFFER_MS = 20_000;

export function useHeadingRenameOffers(session: DocumentSession, active: boolean): void {
  const changes = useSessionChangeCount(session);
  const baseline = useRef<OutlineHeading[] | null>(null);
  const remoteSeen = useRef(session.getRemoteChangeCount());
  const offer = useRef<{ key: string; toastId: number } | null>(null);

  // The outline as loaded is the first baseline.
  useEffect(() => {
    if (active && baseline.current === null && session.getSnapshot().loaded) baseline.current = headingsFromState(session.editorState);
  });

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      const snapshot = session.getSnapshot();
      if (!snapshot.loaded || snapshot.status === 'conflict' || snapshot.status === 'deleted' || snapshot.status === 'readonly') return;
      const now = headingsFromState(session.editorState);
      const remote = session.getRemoteChangeCount();
      if (baseline.current === null || remote !== remoteSeen.current) {
        baseline.current = now;
        remoteSeen.current = remote;
        return;
      }
      const rename = detectHeadingRename(baseline.current, now);
      if (!rename) {
        baseline.current = now;
        return;
      }
      const key = `${rename.index}\u0000${rename.from}\u0000${rename.to}`;
      if (offer.current?.key === key) return;
      const path = session.path;
      void previewHeadingRename(path, rename.from, rename.to).then((preview) => {
        if (cancelled || session.path !== path) return;
        if (offer.current) useToasts.getState().dismiss(offer.current.toastId);
        offer.current = null;
        if (!preview) {
          // Nothing points at the old text: the rename is simply accepted.
          baseline.current = headingsFromState(session.editorState);
          return;
        }
        const toastId = toast(`Heading renamed to “${rename.to}”. Update ${describeUpdates(preview)} that pointed at “${rename.from}”?`, {
          timeout: OFFER_MS,
          action: {
            label: 'Update links',
            run: () => {
              offer.current = null;
              baseline.current = headingsFromState(session.editorState);
              void updateHeadingLinks(path, rename.from, rename.to);
            },
          },
        });
        offer.current = { key, toastId };
      });
    }, SETTLE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [changes, active, session]);
}
