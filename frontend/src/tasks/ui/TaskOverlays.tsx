// The tasks feature's overlay host (registerOverlay, DESIGN §6.8): the quick-add dialog (eager,
// so its field takes focus inside the opening gesture), the task detail sheet and a list's color
// choice (lazy).
import { lazy, Suspense } from 'react';
import { QuickAddDialog } from '../quickadd/QuickAdd';
import { useTaskUi } from './state';

const TaskDetail = lazy(() => import('./TaskDetail'));
const ListColorDialog = lazy(() => import('./ListColorDialog').then((m) => ({ default: m.ListColorDialog })));

export function TaskOverlays() {
  const quickAdd = useTaskUi((s) => s.quickAdd);
  const seq = useTaskUi((s) => s.quickAddSeq);
  const detailId = useTaskUi((s) => s.detailId);
  const colorListId = useTaskUi((s) => s.colorListId);
  return (
    <>
      {quickAdd && <QuickAddDialog key={seq} context={quickAdd} />}
      {detailId && (
        <Suspense fallback={null}>
          <TaskDetail key={detailId} id={detailId} />
        </Suspense>
      )}
      {colorListId && (
        <Suspense fallback={null}>
          <ListColorDialog key={colorListId} listId={colorListId} />
        </Suspense>
      )}
    </>
  );
}
