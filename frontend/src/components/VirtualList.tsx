// Fixed-row-height windowing (DESIGN §6.15) for the file tree, tags and long panel lists.
import { forwardRef, useCallback, useImperativeHandle, useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactNode } from 'react';

export interface VirtualListHandle {
  /** Scrolls the minimum amount needed to show row `index`. */
  scrollToIndex(index: number): void;
  element(): HTMLDivElement | null;
}

interface Props extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  count: number;
  rowHeight: number;
  renderRow(index: number): ReactNode;
  overscan?: number;
  /** Used before the container has been measured (and in environments without layout). */
  fallbackHeight?: number;
}

export const VirtualList = forwardRef<VirtualListHandle, Props>(function VirtualList(
  { count, rowHeight, renderRow, overscan = 8, fallbackHeight = 800, className, ...rest },
  ref,
) {
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(0);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setHeight(el.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const scrollToIndex = useCallback(
    (index: number) => {
      const el = scroller.current;
      if (!el) return;
      const top = index * rowHeight;
      const viewport = el.clientHeight || fallbackHeight;
      if (top < el.scrollTop) el.scrollTop = top;
      else if (top + rowHeight > el.scrollTop + viewport) el.scrollTop = top + rowHeight - viewport;
      setScrollTop(el.scrollTop);
    },
    [rowHeight, fallbackHeight],
  );

  useImperativeHandle(ref, () => ({ scrollToIndex, element: () => scroller.current }), [scrollToIndex]);

  const viewport = height || fallbackHeight;
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const last = Math.min(count, Math.ceil((scrollTop + viewport) / rowHeight) + overscan);
  const rows: ReactNode[] = [];
  for (let i = first; i < last; i++) {
    rows.push(
      <div key={i} role="none" className="virtual-row" style={{ position: 'absolute', top: i * rowHeight, left: 0, right: 0, height: rowHeight }}>
        {renderRow(i)}
      </div>,
    );
  }

  return (
    <div
      ref={scroller}
      className={`virtual-list${className ? ' ' + className : ''}`}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      {...rest}
    >
      <div role="none" className="virtual-spacer" style={{ position: 'relative', height: count * rowHeight }}>
        {rows}
      </div>
    </div>
  );
});
