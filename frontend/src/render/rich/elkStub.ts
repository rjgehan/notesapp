// Stands in for elkjs (EPL-2.0, 1.4 MB) in the bundle: vite.config.ts aliases
// `elkjs/lib/elk.bundled.js` here. Mermaid is configured with the dagre layout and `layout` is a
// secure key (rich/mermaid.ts), so this is never constructed; if it were, the diagram shows the error.
export default class ELK {
  constructor() {
    throw new Error('The ELK layout is not available in NotesApp; diagrams use the dagre layout.');
  }
}
