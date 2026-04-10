/**
 * Tiny shared helpers for the two daily-USD ledgers (scan-budget.ts
 * and dream-budget.ts). Both ledgers reset at local midnight in a
 * configured IANA timezone, so they need an identical "what is
 * today's date in this tz" function.
 *
 * The full ledger types stay separate because their state shapes
 * differ — scan-budget tracks a single scalar bucket, dream-budget
 * tracks one bucket per tier — and forcing them through a common
 * generic adds more code than it saves.
 */

/**
 * Format `now` as `YYYY-MM-DD` in the supplied IANA timezone. Used by
 * both ledgers as the date-rollover key.
 */
export function localDateString(now: Date, tz: string): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(now);
}
