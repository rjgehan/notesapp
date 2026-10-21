// The PDF view (ROADMAP item 32, DESIGN §6.8.2), registered like every built-in view. PDF.js renders the
// pages in the app, so iOS shows every page (its iframe showed only the first), with thumbnails, find,
// zoom, text selection and `#page=N` links; `![[file.pdf#page=3]]` embeds the same viewer. The view and
// the embed are lazy chunks that carry PDF.js; this module and its commands stay small.
import { FileText } from 'lucide-react';
import { linkTo } from '../../features/fileOps';
import type { Command } from '../../features/commands';
import { promptText } from '../../state/dialogs';
import { toast } from '../../state/toasts';
import { registerView } from '../registry';
import { activePdf } from './active';
import { pageSubpath } from './subpath';

function pdfCommand(id: string, name: string, run: (pdf: NonNullable<ReturnType<typeof activePdf>>) => void, hotkey?: string): Command {
  return {
    id,
    name,
    hotkey,
    when: (c) => activePdf(c.activePath) !== null,
    run: (c) => {
      const pdf = activePdf(c.activePath);
      if (pdf) run(pdf);
    },
  };
}

async function copyPageLink(path: string, page: number): Promise<void> {
  try {
    await navigator.clipboard.writeText(linkTo(path, null, pageSubpath(page)));
    toast(`Link to page ${page} copied`);
  } catch {
    toast('The browser refused clipboard access', { kind: 'error' });
  }
}

export const pdfCommands: Command[] = [
  pdfCommand('pdf.find', 'Find in PDF', (pdf) => pdf.openFind(), 'Mod-f'),
  pdfCommand('pdf.goToPage', 'Go to page…', (pdf) => {
    const { pages, page } = pdf.controller.getState();
    void promptText({
      title: 'Go to page',
      label: `Page (1–${pages})`,
      value: String(page),
      confirmLabel: 'Go',
      validate: (v) => (/^\d+$/.test(v.trim()) && Number(v) >= 1 && Number(v) <= pages ? null : `Enter a page from 1 to ${pages}`),
    }).then((v) => {
      if (v) pdf.controller.goToPage(Number(v));
    });
  }),
  pdfCommand('pdf.copyPageLink', 'Copy link to current PDF page', (pdf) => void copyPageLink(pdf.path, pdf.controller.getState().page)),
  pdfCommand('pdf.zoomIn', 'Zoom in', (pdf) => pdf.controller.zoomIn()),
  pdfCommand('pdf.zoomOut', 'Zoom out', (pdf) => pdf.controller.zoomOut()),
  pdfCommand('pdf.fitWidth', 'Zoom to page width', (pdf) => pdf.controller.setScaleValue('page-width')),
  pdfCommand('pdf.fitPage', 'Zoom to whole page', (pdf) => pdf.controller.setScaleValue('page-fit')),
  pdfCommand('pdf.thumbnails', 'Toggle page thumbnails', (pdf) => pdf.toggleThumbnails()),
  pdfCommand('pdf.darkPages', 'Toggle dark PDF pages', (pdf) => pdf.toggleDarkPages()),
];

export function registerPdfView(): void {
  registerView({
    id: 'pdf',
    match: (e) => (e.kind === 'pdf' ? 2 : 0),
    icon: FileText,
    textual: false,
    modes: ['read'],
    load: () => import('./PdfView'),
    loadEmbed: () => import('./PdfEmbed'),
    commands: pdfCommands,
  });
}
