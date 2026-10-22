// THE scroll container of a pane on every breakpoint (DESIGN §6.16, §6.40): the inline title and
// properties scroll away with the text, and CodeMirror sizes to its content inside it. After a
// pointer navigation the active pane's container takes the focus (§6.19), so keys scroll the note
// and focus is never left on the control that opened a closed overlay.
import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { useFocusRequests } from '../../features/focus';
import { WorkspaceScrollContext } from './workspaceScroller';

/** Scroll positions per tab and route, for coming back to a tab (inactive tabs are unmounted). */
const positions = new Map<string, number>();
const MAX_POSITIONS = 200;

interface Props {
  pathname: string;
  /** The tab shown (DESIGN §6.40); its scroll position is restored when it is shown again. */
  scrollKey?: string;
  active?: boolean;
  children: ReactNode;
}

export function WorkspaceScroll({ pathname, scrollKey = '', active = true, children }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const focusRequest = useFocusRequests((s) => s.workspace);
  const key = `${scrollKey}|${pathname}`;

  const shownKey = useRef(scrollKey);

  // A different note starts at the top (heading and line targets scroll from there); a tab shown
  // again returns to where it was, once its content has laid out.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const switched = shownKey.current !== scrollKey;
    shownKey.current = scrollKey;
    const saved = switched && scrollKey ? positions.get(key) : undefined;
    el.scrollTop = saved ?? 0;
    if (!saved) return;
    const frame = requestAnimationFrame(() => {
      if (el.scrollTop === 0) el.scrollTop = saved;
    });
    return () => cancelAnimationFrame(frame);
  }, [key, scrollKey]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !scrollKey) return;
    const onScroll = () => {
      positions.delete(key);
      positions.set(key, el.scrollTop);
      if (positions.size > MAX_POSITIONS) positions.delete(positions.keys().next().value!);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [key, scrollKey]);

  // Runs after the new view's own layout effects, so an editor that took focus keeps it.
  useLayoutEffect(() => {
    const el = ref.current;
    if (active && focusRequest > 0 && el && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
    // Only a new request moves the focus, not a pane becoming active.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest]);

  return (
    <WorkspaceScrollContext.Provider value={ref}>
      <div ref={ref} className="workspace-scroll" id={active ? 'workspace-scroll' : undefined} tabIndex={-1}>
        {children}
      </div>
    </WorkspaceScrollContext.Provider>
  );
}
