/**
 * Policy: choose a reminder lead time based on how far in the future the task deadline is.
 * Returns milliseconds to subtract from deadline to compute the reminder time.
 *
 * Buckets:
 * - <= 10 minutes  -> 5 minutes before
 * - <= 30 minutes  -> 10 minutes before
 * - <= 2 hours     -> 30 minutes before
 * - <= 6 hours     -> 1 hour before
 * - <= 24 hours    -> 2 hours before
 * - <= 72 hours    -> 4 hours before
 * - > 72 hours     -> 6 hours before
 */
export function computeReminderLeadMs(msUntil: number): number {
  const m = 60 * 1000;
  const h = 60 * m;
  if (msUntil <= 10 * m) return 5 * m;   // <=10m -> 5m before
  if (msUntil <= 30 * m) return 10 * m;  // <=30m -> 10m before
  if (msUntil <= 2 * h) return 30 * m;   // <=2h -> 30m before
  if (msUntil <= 6 * h) return 60 * m;   // <=6h -> 1h before
  if (msUntil <= 24 * h) return 2 * h;   // <=24h -> 2h before
  if (msUntil <= 72 * h) return 4 * h;   // <=72h -> 4h before
  return 6 * h;                          // >72h -> 6h before
}
