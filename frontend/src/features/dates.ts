// dayjs with the plugins that cover the moment.js tokens of Obsidian date formats (DESIGN §6.12),
// registered once. Daily notes and templates format dates in the browser's local time zone.
import dayjs from 'dayjs';
import advancedFormat from 'dayjs/plugin/advancedFormat';
import customParseFormat from 'dayjs/plugin/customParseFormat';
import isoWeek from 'dayjs/plugin/isoWeek';
import localizedFormat from 'dayjs/plugin/localizedFormat';
import weekOfYear from 'dayjs/plugin/weekOfYear';
import weekYear from 'dayjs/plugin/weekYear';

dayjs.extend(advancedFormat);
dayjs.extend(customParseFormat);
dayjs.extend(weekOfYear);
dayjs.extend(isoWeek);
dayjs.extend(weekYear);
dayjs.extend(localizedFormat);

export { dayjs };
export type { Dayjs } from 'dayjs';

/** Tokens that dayjs formats differently from moment.js; the settings UI warns about them. */
const UNSUPPORTED = /(?<![A-Za-z])(DDDD|DDD|E|e)(?![A-Za-z])/;

/** Unsupported tokens outside `[literal]` brackets, or null. */
export function unsupportedTokens(format: string): string | null {
  const outsideLiterals = format.replace(/\[[^\]]*\]/g, '');
  const m = UNSUPPORTED.exec(outsideLiterals);
  return m ? m[1] : null;
}
