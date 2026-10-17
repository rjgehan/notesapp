import { act, fireEvent, render } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Overlay } from './Drawer';

function touch(target: Element, type: string, x: number, y: number): Event {
  const e = new Event(type, { bubbles: true, cancelable: true });
  const point = { clientX: x, clientY: y, identifier: 1, target };
  Object.defineProperty(e, 'touches', { value: type === 'touchend' ? [] : [point] });
  target.dispatchEvent(e);
  return e;
}

function Sheet({ onClose }: { onClose(): void }) {
  return (
    <Overlay open side="bottom" label="Note panels" onClose={onClose}>
      <div className="list" style={{ overflowY: 'auto' }}>
        <p>Content</p>
      </div>
    </Overlay>
  );
}

function setup(onClose = vi.fn()) {
  const view = render(<Sheet onClose={onClose} />);
  const panel = view.container.querySelector<HTMLElement>('.overlay-panel')!;
  Object.defineProperty(panel, 'offsetHeight', { value: 600 });
  const grip = view.container.querySelector<HTMLElement>('.sheet-grip')!;
  const list = view.container.querySelector<HTMLElement>('.list')!;
  return { onClose, panel, grip, list };
}

describe('bottom sheet', () => {
  it('closes when its handle is dragged down far enough', () => {
    const { onClose, panel, grip } = setup();
    fireEvent.pointerDown(grip, { button: 0, clientY: 100 });
    fireEvent.pointerMove(grip, { clientY: 180 });
    expect(panel.style.getPropertyValue('--sheet-drag')).toBe('80px');
    expect(panel).toHaveClass('is-dragging');
    fireEvent.pointerMove(grip, { clientY: 400 });
    fireEvent.pointerUp(grip, { clientY: 400 });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(panel).not.toHaveClass('is-dragging');
  });

  it('springs back after a short drag', () => {
    const { onClose, panel, grip } = setup();
    vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(1000);
    fireEvent.pointerDown(grip, { button: 0, clientY: 100 });
    fireEvent.pointerMove(grip, { clientY: 160 });
    fireEvent.pointerUp(grip, { clientY: 160 });
    expect(onClose).not.toHaveBeenCalled();
    expect(panel.style.getPropertyValue('--sheet-drag')).toBe('');
  });

  it('closes on a downward swipe that starts with the content at its top', () => {
    const { onClose, list } = setup();
    Object.defineProperty(list, 'scrollHeight', { value: 2000 });
    Object.defineProperty(list, 'clientHeight', { value: 400 });
    touch(list, 'touchstart', 50, 100);
    expect(touch(list, 'touchmove', 50, 110).defaultPrevented).toBe(true);
    touch(list, 'touchmove', 50, 400);
    touch(list, 'touchend', 50, 400);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('lets scrolled content scroll instead of closing', () => {
    const { onClose, list } = setup();
    Object.defineProperty(list, 'scrollHeight', { value: 2000 });
    Object.defineProperty(list, 'clientHeight', { value: 400 });
    list.scrollTop = 120;
    touch(list, 'touchstart', 50, 100);
    expect(touch(list, 'touchmove', 50, 110).defaultPrevented).toBe(false);
    touch(list, 'touchmove', 50, 400);
    touch(list, 'touchend', 50, 400);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('never turns an upward swipe into a drag', () => {
    const { onClose, list } = setup();
    touch(list, 'touchstart', 50, 300);
    expect(touch(list, 'touchmove', 50, 290).defaultPrevented).toBe(false);
    touch(list, 'touchmove', 50, 500);
    touch(list, 'touchend', 50, 500);
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('overlay focus', () => {
  function Harness({ grab }: { grab?: boolean }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Open
        </button>
        <input aria-label="Title" />
        <Overlay open={open} side="left" label="Sidebar" onClose={() => setOpen(false)}>
          <button
            type="button"
            onClick={() => {
              if (grab) document.querySelector<HTMLInputElement>('input[aria-label="Title"]')!.focus();
              setOpen(false);
            }}
          >
            Inside
          </button>
        </Overlay>
      </>
    );
  }

  it('closes on Esc and returns the focus to the opener', () => {
    const view = render(<Harness />);
    const opener = view.getByRole('button', { name: 'Open' });
    opener.focus();
    fireEvent.click(opener);
    expect(view.container.querySelector('.overlay')).toHaveClass('is-open');
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(view.container.querySelector('.overlay')).not.toHaveClass('is-open');
    expect(document.activeElement).toBe(opener);
  });

  it('keeps a focus that an action inside it moved elsewhere', () => {
    const view = render(<Harness grab />);
    const opener = view.getByRole('button', { name: 'Open' });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.click(view.getByRole('button', { name: 'Inside' }));
    expect(document.activeElement).toBe(view.getByRole('textbox', { name: 'Title' }));
  });
});
