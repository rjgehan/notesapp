// The title placeholders of a note created from a template (DESIGN §6.12). Kept apart from
// templates.ts, which loads on first use together with its YAML library.

/**
 * `text` with the lines that differ between two renders of a template (`before` and `after`,
 * which differ only where `{{title}}` was) updated, each where it occurs exactly once: the new
 * note's title placeholders follow its name even if the body was already edited.
 */
export function retitleText(text: string, before: string, after: string): string {
  const old = before.split('\n');
  const next = after.split('\n');
  if (old.length !== next.length) return text;
  const lines = text.split('\n');
  for (let i = 0; i < old.length; i++) {
    if (old[i] === next[i]) continue;
    const at = lines.indexOf(old[i]);
    if (at < 0 || lines.indexOf(old[i], at + 1) >= 0) continue;
    lines[at] = next[i];
  }
  return lines.join('\n');
}
