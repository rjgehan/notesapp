// Demo vault for the dev mock. It exercises every feature the reading view and editor support.
import { bigBoard, CANVAS_NOTE, PROJECT_BOARD } from './canvasSeed';

const WELCOME = `---
aliases: [Start here]
tags: [meta, welcome]
created: 2026-10-01
---
# Welcome to NotesApp

This vault is served by the **in-memory mock** (\`VITE_MOCK_API=1\`). Everything you change lives in this browser tab until you reload.

## Linking

- A wikilink: [[Projects/Plan|the plan]]. Type \`[[Road\` to find the same note by its alias.
- A heading link: [[Plan B#Risks]] and a link to a note that does not exist yet: [[Someday ideas]].
- A Markdown link: [Alpha spec](Projects/Alpha/Spec.md) and an external one: [Obsidian](https://obsidian.md).
- Tags: #welcome, #project/alpha and #🚀 work everywhere outside \`#code\`.

Type \`[[\` in edit mode to link a note, \`[[Note#\` for its headings and \`#\` for tags.

## Formatting

Single line breaks
are kept, as in Obsidian. ==Highlighted text== stands out, and %%this comment is hidden%% in reading view.

> [!note] Quotes render as blockquotes.
> - [ ] A task inside a quote

### Tasks

- [x] Open the welcome note
- [ ] Toggle a checkbox in reading view
- [ ] Switch modes with Mod-E

| Feature | Shortcut |
| --- | --- |
| Toggle reading view | \`Mod-E\` |
| Save now | \`Mod-S\` |
| Follow link | \`Mod-Enter\` |

\`\`\`ts
const greeting: string = 'hello [[not a link]] #not-a-tag';
\`\`\`

## Embeds

![[diagram.svg|320]]

![[Plan B#Risks]]

A footnote reference.[^1]

[^1]: Footnotes render at the bottom of the note.

%%
A block comment.
It spans several lines and never renders.
%%
`;

const PLAN = `---
aliases: [Roadmap]
tags: [project]
due: 2026-11-01
---
# Plan

See [[Welcome]] and #project/alpha.

## Milestones

1. Draft the [[Spec]]
2. Review with the team
3. Ship it 🎉

## Notes

The alternative is in [[Plan B]].
`;

const PLAN_ROOT = `# Plan (root)

A second note named **Plan** at the vault root. Links to \`[[Plan]]\` resolve here first, so
autocomplete inserts a path-qualified link for [[Projects/Plan]].
`;

const PLAN_B = `---
tags: [idea]
---
# Plan B

If the main [[Plan]] fails.

## Risks

- Scope creep
- Not enough coffee

## Mitigations

- Keep the scope small. #focus
`;

const SPEC = `# Spec

Back to [[../Plan|the project plan]]. Sibling notes: [[./notes]].

## Requirements

- Never lose a keystroke
- Work on the phone
`;

const ALPHA_NOTES = `# Alpha notes

Meeting notes for #project/alpha. The spec is [[Spec]].
`;

const ARCHIVE_SPEC = `# Old spec

Superseded by [[Projects/Alpha/Spec]].
`;

const OLD = `# Old

From 2025. Mentions Plan without linking it.
`;

const BOOKS = `---
tags: [reading]
---
# Book list

- [x] The Pragmatic Programmer
- [ ] Designing Data-Intensive Applications
- [ ] A Philosophy of Software Design
  - [ ] Chapter 4: Modules should be deep
`;

const DAILY_TEMPLATE = `---
tags: [daily]
---
# {{title}}

## Log

- {{time}}
`;

const MEETING_TEMPLATE = `---
tags: [meeting]
---
## Meeting {{date:dddd, MMMM Do YYYY}}

- Attendees:
- Notes:
`;

const WINDOWS_NOTE = '# Imported from Windows\r\n\r\nThis note uses CRLF line endings.\r\n\r\n- [ ] Toggle me: the file stays CRLF\r\n';

const DIAGRAM_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="300" viewBox="0 0 640 300">
  <rect width="640" height="300" rx="18" fill="#262626"/>
  <g font-family="system-ui, sans-serif" font-size="18" fill="#dadada" text-anchor="middle">
    <rect x="40" y="110" width="150" height="80" rx="12" fill="#8a5cf5"/>
    <text x="115" y="156">Browser</text>
    <rect x="245" y="110" width="150" height="80" rx="12" fill="#363636"/>
    <text x="320" y="156">Tailscale</text>
    <rect x="450" y="110" width="150" height="80" rx="12" fill="#363636"/>
    <text x="525" y="156">Spring Boot</text>
  </g>
  <g stroke="#a68af9" stroke-width="3"><line x1="190" y1="150" x2="245" y2="150"/><line x1="395" y1="150" x2="450" y2="150"/></g>
</svg>
`;

// Rich Markdown pack (ROADMAP item 3): callouts, code, math and Mermaid, plus a transclusion.
const RICH = `---
tags: [demo]
---
# Rich Markdown

Callouts, highlighted code, math and diagrams. Edit any block: only that block renders again.

## Callouts

> [!note]
> A plain note callout with **Markdown** inside and a [[Welcome|link]].

> [!tip] Custom title with \`code\`
> Tips, hints and *important* things.

> [!faq]- Folded by default (click to open)
> Hidden until opened.
> - [ ] A task inside a callout

> [!example]+ Foldable, open
> > [!warning] Nested warning
> > Callouts nest.
> >
> > > [!bug] Three levels deep

> [!abstract]
> Also \`summary\` and \`tldr\`.

> [!info] Info

> [!todo] Todo

> [!success] Success

> [!question] Question

> [!failure] Failure

> [!danger] Danger

> [!quote] Quote
> Simplicity is prerequisite for reliability.

> [!recipe|wide] Unknown types use the note style

## Code

\`\`\`ts
// TypeScript
export function greet(name: string): string {
  const now = new Date();
  return \`Hello, \${name}! It is \${now.getHours()}h.\`;
}
\`\`\`

\`\`\`python
def fib(n: int) -> int:
    """Return the n-th Fibonacci number."""
    return n if n < 2 else fib(n - 1) + fib(n - 2)
\`\`\`

\`\`\`bash
for f in *.md; do echo "$f"; done  # shell
\`\`\`

\`\`\`json
{ "name": "notesapp", "rich": true, "version": 3 }
\`\`\`

\`\`\`sql
SELECT title, COUNT(*) AS links FROM notes WHERE tag = 'demo' GROUP BY title;
\`\`\`

\`\`\`unknown-language
Shown as plain text.
\`\`\`

## Math

Inline: $e^{i\\pi} + 1 = 0$, and the price stays text: $5 and $10. Chemistry: $\\ce{H2O}$.

$$
\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}
$$

$$
\\begin{aligned}
\\nabla \\cdot \\mathbf{E} &= \\frac{\\rho}{\\varepsilon_0} \\\\
\\nabla \\times \\mathbf{B} &= \\mu_0 \\mathbf{J} + \\mu_0 \\varepsilon_0 \\frac{\\partial \\mathbf{E}}{\\partial t}
\\end{aligned}
$$

A typo shows inline: $\\frac{1}{$.

## Diagrams

\`\`\`mermaid
graph LR
  A[Browser] -->|HTTPS| B(Tailscale)
  B --> C{Spring Boot}
  C -->|vault| D[(Files)]
  C -->|history| E[(Git)]
\`\`\`

\`\`\`mermaid
sequenceDiagram
  participant P as Phone
  participant S as Server
  P->>S: PUT /api/files
  S-->>P: 200 version
  S-)P: SSE file.changed
\`\`\`

\`\`\`mermaid
pie title Notes by folder
  "Projects" : 5
  "Daily" : 45
  "Ideas" : 2
\`\`\`

\`\`\`mermaid
graph TD
  A -->
\`\`\`

## Embedded note

![[Formulas]]
`;

const FORMULAS = `# Formulas

Transcluded notes render math and diagrams too: $a^2 + b^2 = c^2$.

> [!info] From another note
> $$\\sum_{k=1}^{n} k = \\frac{n(n+1)}{2}$$

\`\`\`mermaid
stateDiagram-v2
  [*] --> Draft
  Draft --> Saved: autosave
  Saved --> [*]
\`\`\`
`;

const DATA_JSON = `{
  "name": "notesapp",
  "kind": "text file",
  "editable": true
}
`;

export interface SeedFile {
  path: string;
  content: string;
  /** Minutes before "now". */
  age: number;
}

function dailyNotes(): SeedFile[] {
  const out: SeedFile[] = [];
  const today = new Date();
  for (let i = 0; i < 45; i++) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    const name = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const body =
      i === 0
        ? `# ${name}\n\n- Reviewed the [[Plan]]\n- [ ] Write the weekly review #work\n`
        : `# ${name}\n\n- Worked on ${i % 3 === 0 ? '[[Spec]]' : i % 3 === 1 ? '[[Plan B]]' : 'the backlog'}\n`;
    out.push({ path: `Daily/${name}.md`, content: body, age: i * 24 * 60 + 30 });
  }
  return out;
}

export function seedFiles(): SeedFile[] {
  return [
    { path: 'Welcome.md', content: WELCOME, age: 5 },
    { path: 'Plan.md', content: PLAN_ROOT, age: 300 },
    { path: 'Projects/Plan.md', content: PLAN, age: 60 },
    { path: 'Projects/Alpha/Spec.md', content: SPEC, age: 120 },
    { path: 'Projects/Alpha/notes.md', content: ALPHA_NOTES, age: 240 },
    { path: 'Archive/Spec.md', content: ARCHIVE_SPEC, age: 60 * 24 * 90 },
    { path: 'Archive/2025/Old.md', content: OLD, age: 60 * 24 * 300 },
    { path: 'Ideas/Plan B.md', content: PLAN_B, age: 90 },
    { path: 'Rich Markdown.md', content: RICH, age: 10 },
    { path: 'Ideas/Formulas.md', content: FORMULAS, age: 95 },
    { path: 'Reading/Book list.md', content: BOOKS, age: 60 * 24 * 3 },
    { path: 'Imported/Windows note.md', content: WINDOWS_NOTE, age: 60 * 24 * 10 },
    { path: 'Templates/Daily note.md', content: DAILY_TEMPLATE, age: 60 * 24 * 30 },
    { path: 'Templates/Meeting.md', content: MEETING_TEMPLATE, age: 60 * 24 * 30 },
    { path: 'Attachments/diagram.svg', content: DIAGRAM_SVG, age: 60 * 24 * 5 },
    { path: 'Scratch/data.json', content: DATA_JSON, age: 60 * 24 * 2 },
    { path: 'Projects/Project board.canvas', content: PROJECT_BOARD, age: 45 },
    { path: 'Projects/Canvas notes.md', content: CANVAS_NOTE, age: 50 },
    { path: 'Canvas/Big board.canvas', content: bigBoard(), age: 60 * 24 },
    ...dailyNotes(),
  ];
}
