// options.html: NotesApp's address and the switches. Saving asks for the host permissions it needs
// (NotesApp's origin, plus every site when images are downloaded); permissions.request must run
// in the click itself, before anything is awaited.
import { ext, type Browser } from './browser';
import { ALL_SITES, appPattern, normalizeAppUrl, readSettings } from './settings';

export function wantedOrigins(appUrl: string, downloadImages: boolean): string[] {
  return downloadImages ? [appPattern(appUrl), ...ALL_SITES] : [appPattern(appUrl)];
}

function input(id: string): HTMLInputElement {
  return document.getElementById(id) as HTMLInputElement;
}

async function load(b: Browser): Promise<void> {
  const s = readSettings(await b.storage.sync.get(null));
  input('appUrl').value = s.appUrl;
  input('folder').value = s.folder;
  input('downloadImages').checked = s.downloadImages;
  input('autoSave').checked = s.autoSave;
}

function setup(): void {
  const b = ext();
  const status = document.getElementById('status')!;
  void load(b);
  document.getElementById('form')!.addEventListener('submit', (e) => {
    e.preventDefault();
    const appUrl = normalizeAppUrl(input('appUrl').value);
    if (!appUrl) {
      status.textContent = 'Enter NotesApp’s https:// address.';
      return;
    }
    const downloadImages = input('downloadImages').checked;
    const asked = b.permissions.request({ origins: wantedOrigins(appUrl, downloadImages) });
    void asked.then(async (granted) => {
      if (!granted) {
        status.textContent = 'The browser did not allow it, so nothing was saved.';
        return;
      }
      const s = readSettings({ appUrl, folder: input('folder').value, downloadImages, autoSave: input('autoSave').checked });
      await b.storage.sync.set({ ...s });
      input('appUrl').value = s.appUrl;
      input('folder').value = s.folder;
      status.textContent = 'Saved.';
    });
  });
}

if (typeof document !== 'undefined' && document.getElementById('form')) setup();
