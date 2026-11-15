/**
 * Small, dependency-free helpers for ISO calendar dates (YYYY-MM-DD), computed in UTC so results
 * never depend on the host time zone.
 */

const MS_PER_DAY = 86_400_000;

function parse(iso: string): Date {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new RangeError(`Invalid ISO date: ${iso}`);
  return d;
}

const fmt = (d: Date): string => d.toISOString().slice(0, 10);

export function addDays(iso: string, days: number): string {
  return fmt(new Date(parse(iso).getTime() + days * MS_PER_DAY));
}

/** Adds calendar months, clamping to the last day of the target month (Jan 31 + 1 → Feb 28/29). */
export function addMonths(iso: string, months: number): string {
  const d = parse(iso);
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return fmt(target);
}

/** Whole days from `from` to `to` (positive when `to` is later). */
export function daysBetween(from: string, to: string): number {
  return Math.round((parse(to).getTime() - parse(from).getTime()) / MS_PER_DAY);
}

export function lastDayOfPreviousMonth(now: Date): string {
  return fmt(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)));
}
