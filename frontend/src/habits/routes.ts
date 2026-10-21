// Locations of the habits page (`/x/habits`, DESIGN §6.35).

export const HABITS_ROUTE = '/x/habits';

export function habitsUrl(opts: { view?: 'new' | 'edit'; habit?: string; day?: string } = {}): string {
  const params = new URLSearchParams();
  if (opts.view) params.set('view', opts.view);
  if (opts.habit) params.set('habit', opts.habit);
  if (opts.day) params.set('day', opts.day);
  const q = params.toString();
  return HABITS_ROUTE + (q ? '?' + q : '');
}
