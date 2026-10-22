// The pending uploads' widgets (DESIGN §6.6 #10) in the note editor; the field itself is in
// uploads.ts, which sessions use without an editor (and without CodeMirror's view in the main chunk).
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import { uploadsField } from './uploads';

class UploadWidget extends WidgetType {
  readonly label: string;
  constructor(label: string, verb = 'Uploading') {
    super();
    this.label = `${verb} ${label}…`;
  }
  override eq(other: UploadWidget): boolean {
    return other.label === this.label;
  }
  toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = 'cm-upload-placeholder';
    el.setAttribute('aria-live', 'polite');
    el.textContent = this.label;
    return el;
  }
  override ignoreEvent(): boolean {
    return false;
  }
}

/** Shows each pending upload as a widget at its position. */
export const uploadWidgets = EditorView.decorations.from(uploadsField, (uploads): DecorationSet =>
  Decoration.set(
    uploads.map((u) => Decoration.widget({ widget: new UploadWidget(u.label, u.verb), side: -1 }).range(u.pos)),
    true,
  ),
);
