// The icon of a property type (ROADMAP item 13), as Obsidian draws them.
import { Calendar, CalendarClock, CheckSquare, Hash, List, Tags, Text, Type } from 'lucide-react';
import type { PropertyType } from '../../api/types';

export function TypeIcon({ type, size = 14 }: { type: PropertyType; size?: number }) {
  const props = { size, 'aria-hidden': true } as const;
  switch (type) {
    case 'text':
      return <Text {...props} />;
    case 'multitext':
      return <List {...props} />;
    case 'number':
      return <Hash {...props} />;
    case 'checkbox':
      return <CheckSquare {...props} />;
    case 'date':
      return <Calendar {...props} />;
    case 'datetime':
      return <CalendarClock {...props} />;
    case 'tags':
      return <Tags {...props} />;
    case 'aliases':
      return <Type {...props} />;
  }
}
