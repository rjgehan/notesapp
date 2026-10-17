// THE scroll container of the workspace on every breakpoint (DESIGN §6.16): the inline title and
// properties scroll away with the text, and CodeMirror sizes to its content inside it. After a
// pointer navigation it takes the focus (§6.19), so keys scroll the note and focus is never left
// on the control that opened a closed overlay.
import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { useLocation } from 'react-router';
import { useFocusRequests } from '../../features/focus';
import { WorkspaceScrollContext } from './workspaceScroller';

export function WorkspaceScroll({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const { pathname } = useLocation();
  const focusRequest = useFocusRequests((s) => s.workspace);

  // A different note starts at the top; heading and line targets scroll from there.
  useLayoutEffect(() => {
    if (ref.current) ref.current.scrollTop = 0;
  }, [pathname]);

  // Runs after the new view's own layout effects, so an editor that took focus keeps it.
  useLayoutEffect(() => {
    const el = ref.current;
    if (focusRequest > 0 && el && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
  }, [focusRequest]);

  return (
    <WorkspaceScrollContext.Provider value={ref}>
      <div ref={ref} className="workspace-scroll" id="workspace-scroll" tabIndex={-1}>
        {children}
      </div>
    </WorkspaceScrollContext.Provider>
  );
}
