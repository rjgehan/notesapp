---
tags: [welcome]
---
# Welcome to NotesApp

This vault is a folder of plain Markdown files on your own server. Everything you write is saved as you type, and every change goes into history. This note is a short tour; delete it whenever you like.

## Notes and links

- Create a note with **New note** (`Mod-Alt-N`) or open the quick switcher (`Mod-O`) and type a name that does not exist yet.
- Link notes with double brackets: [[My first note]]. A link to a note that does not exist is shown as unresolved; following it creates the note.
- Link to a heading with `[[Note#Heading]]`, and show other text with `[[Note|label]]`.
- Paste or drop an image to embed it: it is stored in `Attachments/` and inserted as `![[image.png]]`.
- Renaming or moving a note updates the links that point to it.
- The **Backlinks** panel lists the notes that link here, and plain-text mentions you can turn into links.

## Tags and search

- Write a tag anywhere in the text, like #welcome, or nest it: #ideas/later.
- The **Tags** panel lists every tag with its count.
- Search (`Mod-Shift-F`) understands `"exact phrases"`, `tag:ideas`, `path:Daily`, `file:plan` and `-word` to exclude.

## Daily notes and templates

- **Open today's daily note** creates `Daily/YYYY-MM-DD.md` (the folder and format are in Settings).
- Notes in the `Templates/` folder can be inserted with **Insert template**. In a template, `{{title}}`, `{{date}}` and `{{time}}` are replaced; `{{date:dddd, MMMM Do YYYY}}` takes any date format.

## Shortcuts

| Action | Keys |
|---|---|
| Quick switcher | `Mod-O` |
| Command palette | `Mod-P` |
| New note | `Mod-Alt-N` |
| Search in all notes | `Mod-Shift-F` |
| Toggle reading and editing | `Mod-E` |
| Follow the link under the cursor | `Mod-Enter` |
| Toggle a checkbox | `Mod-L` |
| Bold, italic, link | `Mod-B`, `Mod-I`, `Mod-K` |
| Back and forward | `Mod-Alt-←`, `Mod-Alt-→` |
| Settings | `Mod-,` |

`Mod` is `Cmd` on Apple devices and `Ctrl` elsewhere.

## Where your history lives

- The vault is a git repository. Edits are committed automatically about 30 seconds after you stop typing, with your name as the author; changes made outside the app (over SSH, for example) are committed as **External**.
- The **History** panel shows every version of a note, with a diff, and can restore any of them.
- Deleted notes go to the **Trash**, from where they can be restored. Their content was committed to history first.
- If two devices edit the same note, nothing is overwritten silently: you choose which version to keep, or merge them.
