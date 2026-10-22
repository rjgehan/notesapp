// Unified diff views over @codemirror/merge (DESIGN §6.10 Compare, §6.11 History). Loaded lazily
// with the history panel and the conflict compare view.
import { syntaxHighlighting } from '@codemirror/language';
import { goToNextChunk, goToPreviousChunk, getChunks, originalDocChangeEffect, unifiedMergeView } from '@codemirror/merge';
import { ChangeSet, EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { obsidianHighlight } from './highlight';
import { markdownNoteLanguage } from './language';
import { remoteChanges } from './remoteDiff';

export interface DiffViewHandle {
  view: EditorView;
  next(): void;
  previous(): void;
  /** Number of changed chunks. */
  chunkCount(): number;
  destroy(): void;
}

function language(markdown: boolean): Extension {
  return markdown ? [markdownNoteLanguage(), syntaxHighlighting(obsidianHighlight)] : [];
}

function handle(view: EditorView): DiffViewHandle {
  return {
    view,
    next: () => void goToNextChunk(view),
    previous: () => void goToPreviousChunk(view),
    chunkCount: () => getChunks(view.state)?.chunks.length ?? 0,
    destroy: () => view.destroy(),
  };
}

/**
 * Read-only unified diff of a historical version against the current text: unchanged regions are
 * collapsed, deletions show what the old version had.
 */
export function createHistoryDiffView(parent: HTMLElement, historical: string, current: string, opts: { markdown?: boolean } = {}): DiffViewHandle {
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: current,
      extensions: [
        EditorView.lineWrapping,
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        language(opts.markdown ?? true),
        unifiedMergeView({
          original: historical,
          mergeControls: false,
          highlightChanges: true,
          gutter: true,
          collapseUnchanged: { margin: 3, minSize: 4 },
        }),
      ],
    }),
  });
  return handle(view);
}

/** A read-only editor for a historical version's full text. */
export function createReadOnlyView(parent: HTMLElement, text: string, opts: { markdown?: boolean } = {}): EditorView {
  return new EditorView({
    parent,
    state: EditorState.create({
      doc: text,
      extensions: [EditorView.lineWrapping, EditorState.readOnly.of(true), EditorView.editable.of(false), language(opts.markdown ?? true)],
    }),
  });
}

/**
 * Conflict compare (DESIGN §6.10): the document is mine (or an automatic merge), the original is
 * theirs, and each chunk can be accepted (keep mine) or rejected (take theirs). The resulting
 * document is what "Save merged" sends.
 */
export function createCompareView(parent: HTMLElement, doc: string, theirs: string, opts: { markdown?: boolean } = {}): DiffViewHandle {
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        history(),
        EditorView.lineWrapping,
        language(opts.markdown ?? true),
        keymap.of([...historyKeymap, ...defaultKeymap]),
        unifiedMergeView({ original: theirs, mergeControls: true, highlightChanges: true, gutter: true }),
      ],
    }),
  });
  return handle(view);
}

/** Replaces the compared-against text in place (theirs changed again while comparing). */
export function updateCompareOriginal(view: EditorView, previous: string, next: string): void {
  if (previous === next) return;
  const changes = ChangeSet.of(remoteChanges(previous, next), previous.length);
  view.dispatch({ effects: originalDocChangeEffect(view.state, changes) });
}
