// The Mermaid package's own entry (render/rich/mermaidShared.ts imports it by path, since
// vite.config.ts points the bare `mermaid` at that module).
declare module 'mermaid/dist/mermaid.core.mjs' {
  import mermaid from 'mermaid';
  export default mermaid;
}
