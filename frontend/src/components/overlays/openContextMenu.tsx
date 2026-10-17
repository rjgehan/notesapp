// Opens a ContextMenu from outside React (the editor's table grid, DESIGN §6.6.1): the menu gets a
// root of its own, unmounted once it closes.
import { createRoot } from 'react-dom/client';
import { ContextMenu, type MenuEntry } from './ContextMenu';

export function openContextMenu(at: { x: number; y: number }, label: string, items: MenuEntry[]): void {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    // Not inside the menu's own event handler: React unmounts a root only outside its rendering.
    setTimeout(() => {
      root.unmount();
      host.remove();
    }, 0);
  };
  root.render(<ContextMenu x={at.x} y={at.y} label={label} items={items} onClose={close} />);
}
