// Scroll requests for the open note (Outline panel): by source line, so a repeated click scrolls
// again and duplicate headings (or headings containing `#`) reach the exact one. Heading links
// and search hits keep using the route (`#Heading`, `?line=`).
import { create } from 'zustand';

interface NoteScrollState {
  path: string | null;
  /** 0-based source line. */
  line: number;
  /** Bumped by every request, so the same line can be requested again. */
  seq: number;
}

export const useNoteScroll = create<NoteScrollState>()(() => ({ path: null, line: 0, seq: 0 }));

/** Scrolls the open note at `path` so that 0-based `line` is at the top. */
export function requestNoteScroll(path: string, line: number): void {
  useNoteScroll.setState((s) => ({ path, line, seq: s.seq + 1 }));
}
