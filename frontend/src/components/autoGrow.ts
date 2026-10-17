import { useLayoutEffect, type RefObject } from 'react';

/** Sizes a textarea to its content (titles wrap instead of scrolling). */
export function autoGrow(el: HTMLTextAreaElement): void {
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}

/** Keeps a textarea sized to its content, also when its width changes (layout, rotation). */
export function useAutoGrow(ref: RefObject<HTMLTextAreaElement | null>): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    autoGrow(el);
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      autoGrow(el);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
}
