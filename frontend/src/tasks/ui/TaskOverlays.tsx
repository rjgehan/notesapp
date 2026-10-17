// The tasks feature's overlay host (registerOverlay, DESIGN §6.8): the quick-add dialog (eager,
// so its field takes focus inside the opening gesture) and the task detail sheet (lazy).
import { lazy, Suspense } from 'react';
import { QuickAddDialog } from '../quickadd/QuickAdd';
import { useTaskUi } from './state';

const TaskDetail = lazy(() => import('./TaskDetail'));

export function TaskOverlays() {
  const quickAdd = useTaskUi((s) => s.quickAdd);
  const seq = useTaskUi((s) => s.quickAddSeq);
  const detailId = useTaskUi((s) => s.detailId);
  return (
    <>
      {quickAdd && <QuickAddDialog key={seq} context={quickAdd} />}
      {detailId && (
        <Suspense fallback={null}>
          <TaskDetail key={detailId} id={detailId} />
        </Suspense>
      )}
    </>
  );
}
