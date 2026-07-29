/**
 * Date ranges, resolved from the query string.
 *
 * All arithmetic is done on UTC parts and formatted back to `YYYY-MM-DD`
 * strings — never through a local-timezone `Date`. Meal dates are calendar
 * dates, not instants, and treating them as instants is how "today" silently
 * becomes "yesterday" west of Greenwich.
 */

export interface Range {
  from: string;
  to: string;
  days: number;
  label: string;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

export function shiftDays(date: string, delta: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return iso(d);
}

export function today(): string {
  return iso(new Date());
}

export const PRESETS = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
] as const;

export function resolveRange(params: { from?: string; to?: string; days?: string }): Range {
  const to = params.to && /^\d{4}-\d{2}-\d{2}$/.test(params.to) ? params.to : today();
  if (params.from && /^\d{4}-\d{2}-\d{2}$/.test(params.from)) {
    const from = params.from;
    const days = Math.max(
      1,
      Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1
    );
    return { from, to, days, label: `${days} days` };
  }
  const days = Number(params.days) > 0 ? Math.min(Number(params.days), 366) : 30;
  return { from: shiftDays(to, -(days - 1)), to, days, label: `${days} days` };
}
