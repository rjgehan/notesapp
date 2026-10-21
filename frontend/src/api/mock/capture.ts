// Quick capture for the in-memory mock (dev only): an approximation of the server's append
// (API.md §8.5), enough to exercise the capture box, the share target and the offline queue.
import { dayjs } from '../../features/dates';
import { joinPath } from '../../features/paths';
import type { AttachmentResult, CaptureRequest, CaptureResult } from '../types';
import type { MockVault } from './vault';

export function mockCapture(vault: MockVault, req: CaptureRequest, attachment: AttachmentResult | null, origin: string): CaptureResult {
  const settings = vault.getSettings().settings;
  const now = dayjs(`${req.date ?? dayjs().format('YYYY-MM-DD')} ${req.time ?? dayjs().format('HH:mm')}`);
  const target = req.target ?? 'inbox';
  const path = target === 'daily' ? joinPath(settings.dailyNotes.folder, now.format(settings.dailyNotes.format) + '.md') : 'Inbox.md';
  const time = now.format(settings.templates.timeFormat);
  const stamp = target === 'inbox' ? `${now.format(settings.templates.dateFormat)} ${time}` : time;
  const parts = [req.text?.trim(), req.url && !(req.text ?? '').includes(req.url) ? `<${req.url}>` : null, attachment?.markdown].filter((p): p is string => !!p);
  const [first, ...rest] = parts.join('\n').split('\n');
  const entry = `- ${stamp} ${first}${rest.map((l) => (l ? `\n  ${l}` : '\n')).join('')}\n`;
  let existing: string | null;
  try {
    existing = vault.readFile(path).content;
  } catch {
    existing = null;
  }
  if (existing === null) {
    const result = vault.createFile({ path, content: entry, onConflict: 'fail' }, origin);
    return { ...result, target, attachment: attachment?.file ?? null };
  }
  const current = vault.readFile(path);
  const content = existing + (existing === '' || existing.endsWith('\n') ? '' : '\n') + entry;
  const result = vault.saveFile(path, { content, baseVersion: current.version }, origin);
  return { ...result, target, attachment: attachment?.file ?? null };
}
