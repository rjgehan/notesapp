// `/x/tasks/list/:id` (ROADMAP item 4, List and Kanban views): one list, by its id.
import { useParams } from 'react-router';
import { ListScreen } from './ListScreen';

export default function ListPage() {
  const { id = '' } = useParams();
  return <ListScreen listId={id} />;
}
