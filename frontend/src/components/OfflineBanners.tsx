// Offline mode banners (DESIGN §6.18, §6.21): the offline state, the notes list shown from the
// device's snapshot, and notes whose edits made offline now conflict with a newer version.
import { CloudOff, History, TriangleAlert } from 'lucide-react';
import { useLocation } from 'react-router';
import { formatDateTime } from '../features/format';
import { openPath } from '../features/navigation';
import { displayName, pathFromLocation } from '../features/paths';
import { useOffline } from '../offline/offlineStore';
import { useUi } from '../state/ui';
import { documents } from '../sync/instance';

/** Notes waiting for the conflict banner, except the open one (its banner is already showing). */
function useReviewList(): string[] {
  const review = useOffline((s) => s.review);
  // Re-rendered whenever a session enters or leaves conflict (the save summary changes).
  const summary = useUi((s) => s.saveSummary);
  const open = pathFromLocation(useLocation().pathname);
  const conflicts = summary === 'conflict' ? documents.all().filter((s) => s.currentStatus === 'conflict').map((s) => s.path) : [];
  return [...new Set([...conflicts, ...review])].filter((p) => p !== open);
}

export function OfflineBanners({ offline }: { offline: boolean }) {
  const snapshotAt = useOffline((s) => s.treeSnapshotAt);
  const dismissReview = useOffline((s) => s.dismissReview);
  const review = useReviewList();
  return (
    <>
      {offline && (
        <div className="banner banner-warning" role="status">
          <CloudOff size={14} aria-hidden /> Offline: edits are saved on this device and will sync when the connection returns.
        </div>
      )}
      {snapshotAt !== null && (
        <div className="banner banner-info" role="status">
          <History size={14} aria-hidden /> Showing this device&rsquo;s copy of your notes from {formatDateTime(snapshotAt)} until the server answers.
        </div>
      )}
      {review.length > 0 && (
        <div className="banner banner-warning" role="alert">
          <TriangleAlert size={14} aria-hidden />
          {review.length === 1
            ? `Your edits to ${displayName(review[0])} conflict with a newer version.`
            : `Your edits to ${review.length} notes conflict with newer versions.`}
          <button
            type="button"
            className="button button-small"
            onClick={() => {
              dismissReview(review[0]);
              openPath(review[0]);
            }}
          >
            Review{review.length > 1 ? ` ${displayName(review[0])}` : ''}
          </button>
        </div>
      )}
    </>
  );
}
