// Drag handle that resizes a sidebar (desktop). Keyboard: arrow keys resize by 16 px.
import type { KeyboardEvent, PointerEvent } from 'react';

interface Props {
  side: 'left' | 'right';
  width: number;
  min: number;
  max: number;
  onResize(width: number): void;
}

export function Resizer({ side, width, min, max, onResize }: Props) {
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    document.body.classList.add('is-resizing');
    const move = (ev: globalThis.PointerEvent) => {
      const delta = ev.clientX - startX;
      onResize(side === 'left' ? startWidth + delta : startWidth - delta);
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      document.body.classList.remove('is-resizing');
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const grow = side === 'left' ? 'ArrowRight' : 'ArrowLeft';
    const shrink = side === 'left' ? 'ArrowLeft' : 'ArrowRight';
    if (e.key === grow) onResize(width + 16);
    else if (e.key === shrink) onResize(width - 16);
    else return;
    e.preventDefault();
  };

  return (
    <div
      className={`resizer resizer-${side}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${side} sidebar`}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    />
  );
}
