// The star in a note's header (DESIGN §6.23): bookmarks the open file, or removes its bookmark.
import { Star } from 'lucide-react';
import { isFileBookmarked, toggleFileBookmark, useBookmarks } from '../features/bookmarkStore';

export function BookmarkToggle({ path }: { path: string }) {
  const { items } = useBookmarks();
  const on = isFileBookmarked(items, path);
  const label = on ? 'Remove bookmark' : 'Bookmark this file';
  return (
    <button type="button" className={`icon-button bookmark-toggle${on ? ' is-on' : ''}`} aria-pressed={on} aria-label={label} title={label} onClick={() => void toggleFileBookmark(path)}>
      <Star size={16} fill={on ? 'currentColor' : 'none'} />
    </button>
  );
}
