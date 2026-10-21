// The app's own source files as text, for tests that guard stylesheets (Vitest hands CSS imports to
// tests empty, `?raw` included). Node's fs is loaded by a computed name: the app's TypeScript
// config has no Node types. Tests run from the frontend folder.
interface NodeFs {
  readdirSync(path: string, options: { recursive: true }): string[];
  readFileSync(path: string, encoding: 'utf8'): string;
}

/** Every file under `src/` whose name ends with `suffix`, by its path from `src/` (with `/`). */
export async function sourceFiles(suffix: string): Promise<Record<string, string>> {
  const name = 'node:fs';
  const fs = (await import(/* @vite-ignore */ name)) as NodeFs;
  const src = `${(globalThis as unknown as { process: { cwd(): string } }).process.cwd()}/src`;
  const out: Record<string, string> = {};
  for (const file of fs.readdirSync(src, { recursive: true })) {
    const path = file.split('\\').join('/');
    if (path.endsWith(suffix)) out[path] = fs.readFileSync(`${src}/${path}`, 'utf8');
  }
  return out;
}
