// Public publishing (ROADMAP item 26, DESIGN §5.28) through the extension points (§6.8): the
// publish dialog as an overlay and a palette command for the open note. The dialog says when
// publishing is off on the server, so the command is always offered for notes.
import { Globe } from 'lucide-react';
import { currentTree } from '../../api/hooks';
import { registerCommand, registerOverlay } from '../../extensions';
import { openPublishDialog } from '../../features/publish';
import { isMarkdownViewPath } from '../../views/registry';
import { PublishDialog } from './PublishDialog';

/** Plain notes only: drawings stored as `.excalidraw.md` are shown by another view. */
export function canPublish(path: string | null): path is string {
  return path !== null && isMarkdownViewPath(path) && currentTree().byPath.get(path)?.kind === 'note';
}

export function registerPublish(): void {
  registerOverlay({ id: 'publish', component: PublishDialog });
  registerCommand({
    id: 'file.publish',
    name: 'Publish note to the web',
    icon: Globe,
    when: (c) => canPublish(c.activePath),
    run: (c) => openPublishDialog(c.activePath!),
  });
}
