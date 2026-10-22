// Scripts in notes (ROADMAP items 40 and 17, DESIGN §6.43): the app's side of
// `NoteContext.runScript`. A ```` ```script ```` block runs as written; a ```` ```dataview ````
// block is the script `show(query(…))`. The sandbox's API calls are answered from the server's
// index (`GET /api/notes/query`), the open notes' current text (else the file), the tree's link
// resolution and the editor's formula engine. What the script showed comes back as escaped
// Markdown (output.ts).
import { currentTree, fetchTextFile } from '../api/hooks';
import type { ScriptOutcome, ScriptRequest } from '../editor/context';
import { resolve } from '../features/links';
import { documents } from '../sync/instance';
import { queryNotes } from './api';
import { outputMarkdown } from './output';
import { runScript } from './runner';

/** The script a ```` ```dataview ```` block stands for. */
export function dataviewScript(query: string): string {
  return `show(query(${JSON.stringify(query)}))`;
}

/** Runs a script block of the note at `path`. */
export async function runNoteScript(path: string, request: ScriptRequest): Promise<ScriptOutcome> {
  const code = request.kind === 'dataview' ? dataviewScript(request.source) : request.source;
  const result = await runScript(code, {
    path,
    queryNotes,
    async readText(p) {
      const open = documents.get(p);
      if (open) return open.getText();
      return (await fetchTextFile(p)).content;
    },
    resolve: (target) => resolve(target, path, currentTree().links),
    evaluate: request.evaluate,
  });
  return {
    markdown: outputMarkdown(result.output),
    // A query's error has no line of its own: the block's one line is not worth a number.
    error: result.error ? { ...result.error, line: request.kind === 'dataview' ? null : result.error.line } : null,
    reads: result.reads,
  };
}
