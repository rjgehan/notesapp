// Habit colours: the eight categorical hues of the app's charts (DESIGN §6.35). A habit without a
// `color` gets one from its path, so it keeps its colour on every device.
import { hash53 } from '../flashcards/ids';

export const HABIT_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];

const CSS_COLOR = /^(#[0-9a-f]{3,8}|[a-z]+|rgba?\([\d\s,.%]+\)|hsla?\([\d\s,.%deg]+\))$/i;

export function habitColor(h: { color: string | null; path: string }): string {
  if (h.color && CSS_COLOR.test(h.color)) return h.color;
  return HABIT_COLORS[hash53(h.path) % HABIT_COLORS.length];
}
