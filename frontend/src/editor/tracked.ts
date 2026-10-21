// Ranges followed through every change of a document, local or remote, while something outside
// the editor works on them asynchronously: Convert checkbox to task (ROADMAP item 4) creates a
// task from a line, then replaces exactly that line, wherever edits have moved it meanwhile, and
// only if it is still the same text. Like pending uploads (uploads.ts), a tracked range is editor
// state, never document text, so nothing of it is ever saved.
import { StateEffect, StateField, type EditorState } from '@codemirror/state';

export interface TrackedRange {
  id: number;
  from: number;
  to: number;
}

/**
 * Starts following a range. Text inserted at either edge stays outside it: a whole line followed
 * this way still starts and ends a line after a line is added above or below it, while a caller
 * that checks this notices a line typed onto at its start or end.
 */
export const trackRange = StateEffect.define<TrackedRange>({
  map: (r, mapping) => ({ ...r, from: mapping.mapPos(r.from, 1), to: mapping.mapPos(r.to, -1) }),
});

export const untrackRange = StateEffect.define<number>();

export const trackedRangesField = StateField.define<readonly TrackedRange[]>({
  create: () => [],
  update(value, tr) {
    let next = tr.docChanged ? value.map((r) => ({ ...r, from: tr.changes.mapPos(r.from, 1), to: tr.changes.mapPos(r.to, -1) })) : value;
    for (const e of tr.effects) {
      if (e.is(trackRange)) next = [...next, e.value];
      else if (e.is(untrackRange)) next = next.filter((r) => r.id !== e.value);
    }
    return next;
  },
});

/** Where a tracked range is now, or undefined (never tracked, or the field is not configured). */
export function trackedRange(state: EditorState, id: number): TrackedRange | undefined {
  return (state.field(trackedRangesField, false) ?? []).find((r) => r.id === id);
}
