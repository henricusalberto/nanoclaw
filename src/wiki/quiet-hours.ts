/**
 * Quiet-hours gate for the entity scanner. Between the configured
 * window (default 23:00–07:00 local time), LLM calls are suppressed.
 * Messages continue to enqueue; a morning flush cron drains the queue
 * at 07:05.
 *
 * Wall-clock hour in the configured IANA timezone is computed via
 * Intl.DateTimeFormat so DST is handled correctly without a date library.
 */

export interface QuietHoursConfig {
  /** IANA timezone, e.g. "Europe/Berlin". */
  tz: string;
  /** Start hour inclusive, 0–23. */
  startHour: number;
  /** End hour exclusive, 0–23. */
  endHour: number;
}

export const DEFAULT_QUIET_HOURS: QuietHoursConfig = {
  tz: 'Europe/Berlin',
  startHour: 23,
  endHour: 7,
};

function localHour(now: Date, tz: string): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const hourPart = parts.find((p) => p.type === 'hour');
  if (!hourPart) return now.getHours();
  const h = parseInt(hourPart.value, 10);
  // Intl sometimes returns "24" for midnight in hour12:false mode.
  return h === 24 ? 0 : h;
}

/**
 * Returns true if `now` is inside the quiet window. Wraps midnight —
 * e.g. 23:00–07:00 returns true at 01:00.
 */
export function isQuietHour(now: Date, cfg: QuietHoursConfig): boolean {
  const h = localHour(now, cfg.tz);
  if (cfg.startHour === cfg.endHour) return false;
  if (cfg.startHour < cfg.endHour) {
    return h >= cfg.startHour && h < cfg.endHour;
  }
  // Window wraps across midnight
  return h >= cfg.startHour || h < cfg.endHour;
}
