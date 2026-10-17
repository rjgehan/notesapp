// Attachment name sanitizer (DESIGN §4.4 "Attachment names", API.md §9.3) and the ` 1`, ` 2`
// de-duplication shared by the mock's create, upload, trash and restore flows.
import { isIgnoredName, utf8Length } from '../../features/paths';

const WINDOWS_RESERVED_BASE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
// eslint-disable-next-line no-control-regex
const REPLACED = /[\u0000-\u001f\u007f:*?"<>|#^[\]]|%%/g;

function splitExt(name: string): [string, string] {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? [name, ''] : [name.slice(0, dot), name.slice(dot)];
}

/** Truncates `base` on a code-point boundary so that `base + ext` fits `maxBytes` of UTF-8. */
function truncateToBytes(base: string, ext: string, maxBytes: number): string {
  const budget = maxBytes - utf8Length(ext);
  let out = '';
  let used = 0;
  for (const cp of base) {
    const len = utf8Length(cp);
    if (used + len > budget) break;
    out += cp;
    used += len;
  }
  return out;
}

// Known file-kind extensions (DESIGN §4.2). A name that is only a dot plus one of these (`.png`)
// is an extension without a basename, whereas `.env` is a dot-file whose name is `env`.
const KNOWN_EXTENSIONS = new Set(
  (
    'md txt markdown json canvas excalidraw sheet tasks csv tsv yaml yml png jpg jpeg gif webp avif bmp svg ' +
    'mp3 m4a ogg wav flac 3gp mp4 mov ogv webm mkv pdf'
  ).split(' '),
);

export function sanitizeAttachmentName(input: string): string {
  let name = input.slice(Math.max(input.lastIndexOf('/'), input.lastIndexOf('\\')) + 1);
  name = name.normalize('NFC');
  name = name.replace(REPLACED, '-');
  name = name.replace(/\s+/g, ' ');
  const bareExtension = /^\.([^.]+)$/.exec(name.trim());
  if (bareExtension && KNOWN_EXTENSIONS.has(bareExtension[1].toLowerCase())) return 'attachment.' + bareExtension[1];
  name = name.replace(/^[. ]+/, '').replace(/[. ]+$/, '');
  let [base, ext] = splitExt(name);
  if (WINDOWS_RESERVED_BASE.test(base)) base = '_' + base;
  name = base + ext;
  if (isIgnoredName(name)) {
    ext = ext + '.file';
    name = base + ext;
  }
  if (utf8Length(name) > 240) base = truncateToBytes(base, ext, 240);
  if (base === '') base = 'attachment';
  return base + ext;
}

/** Inserts ` n` before the extension: `a.png` → `a 1.png`. */
export function numbered(name: string, n: number): string {
  if (n === 0) return name;
  const [base, ext] = splitExt(name);
  return `${base} ${n}${ext}`;
}
