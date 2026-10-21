// The canvas on screen, for palette commands (registered eagerly, while the view is a lazy chunk).

export interface ActiveCanvas {
  path: string;
  addCard(): void;
  addFile(): void;
  addMedia(): void;
  addLink(): void;
  groupSelection(): void;
  zoomToFit(): void;
  zoomToSelection(): void;
  undo(): void;
  redo(): void;
}

let active: ActiveCanvas | null = null;

export function setActiveCanvas(c: ActiveCanvas): void {
  active = c;
}

export function clearActiveCanvas(c: ActiveCanvas): void {
  if (active === c) active = null;
}

export function activeCanvas(path: string | null): ActiveCanvas | null {
  return active && path !== null && active.path === path ? active : null;
}
