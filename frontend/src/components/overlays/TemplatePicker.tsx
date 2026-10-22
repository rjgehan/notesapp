// Template picker (DESIGN §6.12): fuzzy over GET /api/templates. Inserts into the open note at its
// stored selection, or creates a new note from the template (in the default new-note location, or
// in the folder whose menu opened it).
import { LayoutTemplate } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTemplates } from '../../api/hooks';
import type { TemplateEntry } from '../../api/types';
import { createNote, newNoteFolder } from '../../features/fileOps';
import { clearTemplatePickerFolder, templatePickerFolder } from '../../features/folderTemplates';
import { fuzzyRank } from '../../features/fuzzy';
import { activePath } from '../../features/navigation';
import { folderOf } from '../../features/paths';
import { toast } from '../../state/toasts';
import { useUi } from '../../state/ui';
import { documents } from '../../sync/instance';
import { Picker } from './Picker';

/** Templates (and the YAML library behind the frontmatter merge) load on first use. */
const loadTemplates = () => import('../../features/templates');

export function TemplatePicker({ mode }: { mode: 'insert' | 'new' }) {
  const templates = useTemplates();
  const [query, setQuery] = useState('');
  const [target] = useState(activePath);
  const [inFolder] = useState(templatePickerFolder);
  useEffect(() => clearTemplatePickerFolder, []);
  const items = useMemo(() => {
    const list = templates.data?.templates ?? [];
    return query.trim() === '' ? list : fuzzyRank(query, list, [(t) => t.name, (t) => t.path], 50).map((r) => r.item);
  }, [templates.data, query]);
  const close = () => useUi.getState().setOverlay(null);

  const pick = (t: TemplateEntry) => {
    close();
    if (mode === 'new') {
      // The pending view appears inside this gesture; the template's questions and the rendered
      // template follow. Rendered once the note has its name too, so {{title}} is the title the
      // user types.
      createNote(
        inFolder ?? newNoteFolder(target),
        loadTemplates().then((m) => m.templateRenderer(t.path)),
      );
      return;
    }
    const session = target ? documents.get(target) : undefined;
    if (!session) {
      toast('Open a note to insert a template', { kind: 'error' });
      return;
    }
    void loadTemplates().then((m) => m.insertTemplate(session, t.path));
  };

  const folder = templates.data?.folder ?? '';
  return (
    <Picker
      label={mode === 'new' ? (inFolder ? `New note from template in ${inFolder}` : 'New note from template') : 'Insert template'}
      placeholder="Choose a template…"
      query={query}
      onQuery={setQuery}
      items={items}
      itemKey={(t) => t.path}
      renderItem={(t) => (
        <>
          <LayoutTemplate size={16} className="picker-item-icon" aria-hidden />
          <span className="picker-item-text">
            <span className="picker-item-label">{t.name}</span>
            {folderOf(t.path) !== folder && <span className="picker-item-detail">{folderOf(t.path)}</span>}
          </span>
        </>
      )}
      onPick={pick}
      onClose={close}
      empty={templates.isPending ? 'Loading…' : folder ? `No templates in “${folder}”.` : 'No templates found.'}
    />
  );
}
