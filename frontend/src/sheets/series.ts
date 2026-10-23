// Number series for fills (DESIGN §6.21.5, §6.42): as in Google Sheets, a fill from two or more
// numbers that step evenly (1, 2 or 10, 20, 30) continues the series (3, 4 or 40, 50) instead of
// repeating them; a single number, or numbers that do not step evenly, are copied. Pure.

/** The series `values` start, as its first value and step, or null when they are not one. */
export function numberSeries(values: ReadonlyArray<number | null>): { first: number; step: number; decimals: number } | null {
  if (values.length < 2 || values.some((v) => v === null || !Number.isFinite(v))) return null;
  const nums = values as number[];
  const step = nums[1] - nums[0];
  for (let i = 2; i < nums.length; i++) if (Math.abs(nums[i] - nums[i - 1] - step) > 1e-9 * Math.max(1, Math.abs(step))) return null;
  const decimals = Math.max(...nums.map((n) => (String(n).split('.')[1] ?? '').length));
  return { first: nums[0], step, decimals };
}

/** The series' value at `index` (0 is its first value; negative before it), rounded as its values are. */
export function seriesValue(series: { first: number; step: number; decimals: number }, index: number): number {
  const v = series.first + series.step * index;
  return Number(v.toFixed(Math.min(series.decimals, 12)));
}
