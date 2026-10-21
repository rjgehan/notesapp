// The PDF view that shows the open file, for the palette commands the descriptor contributes (DESIGN §6.8.2).
// Eager and tiny: the commands exist before PDF.js is loaded.
import type { PdfController } from './controller';

export interface ActivePdf {
  path: string;
  controller: PdfController;
  /** Opens the find bar and focuses its field, synchronously (iOS opens the keyboard only inside the tap). */
  openFind(): void;
  toggleThumbnails(): void;
  toggleDarkPages(): void;
}

let active: ActivePdf | null = null;

export function setActivePdf(pdf: ActivePdf): () => void {
  active = pdf;
  return () => {
    if (active === pdf) active = null;
  };
}

/** The PDF view of `path`, when it is the one shown. */
export function activePdf(path: string | null): ActivePdf | null {
  return active && path !== null && active.path === path ? active : null;
}
