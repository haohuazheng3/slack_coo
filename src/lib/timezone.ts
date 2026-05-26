/**
 * Timezone-aware formatting helpers.
 *
 * Two principles drive the choices here:
 *
 *   1. STORE in UTC, DISPLAY in the viewer's local TZ. We have a `Date` column
 *      in Postgres (`Task.time`) which is always UTC under the hood. Renderers
 *      must opt into a timezone explicitly; never call bare `toLocaleString()`
 *      on a Date intended for users — it'll use the server's TZ (which is UTC
 *      on Render) and silently mislead anyone outside that timezone.
 *
 *   2. The display TZ is the VIEWER's, not the creator's. A task created by
 *      an owner in Detroit, assigned to someone in London, should look like
 *      "tomorrow at 6 PM" to the owner AND "tomorrow at 11 PM" to the
 *      assignee — same UTC instant, two locally-correct strings. Global
 *      remote teams shouldn't have to mentally convert.
 */

const FALLBACK_TZ = process.env.DEFAULT_TIMEZONE || 'America/New_York';

/**
 * Normalize an arbitrary string into a valid IANA timezone identifier, or
 * fall back to the server default if it isn't recognized. Catches things like
 * empty strings, accidental nullish values, or stale TZ identifiers.
 */
function safeTimeZone(tz: string | null | undefined): string {
  if (!tz) return FALLBACK_TZ;
  try {
    // Throws RangeError if tz is not a valid IANA name on this Node version.
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return FALLBACK_TZ;
  }
}

export type FormatLocale = 'en' | 'zh';

/**
 * Format a date for display to a specific viewer.
 *
 * Locale governs the calendar/format conventions:
 *   - zh: "2026/5/27 18:00" (24h, YYYY/M/D — matches Chinese reading habits)
 *   - en: "May 27, 2026, 6:00 PM" (American long form)
 *
 * Timezone is applied independently of locale, so a Detroit viewer reading
 * Chinese gets "2026/5/27 18:00" in their local clock; a London viewer reading
 * Chinese gets "2026/5/27 23:00" for the same UTC instant.
 */
export function formatDateTime(
  date: Date,
  opts: { tz?: string | null; locale?: FormatLocale } = {}
): string {
  const tz = safeTimeZone(opts.tz);
  const locale = opts.locale ?? 'en';

  if (locale === 'zh') {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: tz,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date);
  }

  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date);
}

/**
 * Translate an IANA timezone identifier into something a person would actually
 * say in conversation. The `America/New_York` style is precise but jarring
 * inside a sentence — especially in Chinese, where "纽约时间" or "美东时间"
 * reads as ordinary speech. The Slack `users.info` response also gives a
 * tz_label like "Eastern Daylight Time" we can fall back to for English.
 */
export function humanizeTimeZone(
  tz: string | null | undefined,
  locale: FormatLocale = 'en',
  tzLabel?: string | null
): string {
  const safe = safeTimeZone(tz);

  // A small dictionary for the most common North American + APAC + EU zones.
  // The full IANA list has 600+ entries; we only translate the ones our users
  // are realistically in. Anything not in this table falls back to tzLabel
  // (from Slack) or the IANA string itself.
  const ZH: Record<string, string> = {
    'America/New_York': '美东时间',
    'America/Detroit': '美东时间',
    'America/Chicago': '美中时间',
    'America/Denver': '美山区时间',
    'America/Los_Angeles': '美西时间',
    'America/Anchorage': '阿拉斯加时间',
    'Pacific/Honolulu': '夏威夷时间',
    'America/Toronto': '美东时间',
    'America/Vancouver': '美西时间',
    'Europe/London': '伦敦时间',
    'Europe/Paris': '中欧时间',
    'Europe/Berlin': '中欧时间',
    'Europe/Madrid': '中欧时间',
    'Europe/Amsterdam': '中欧时间',
    'Asia/Shanghai': '北京时间',
    'Asia/Hong_Kong': '香港时间',
    'Asia/Taipei': '台北时间',
    'Asia/Singapore': '新加坡时间',
    'Asia/Tokyo': '东京时间',
    'Asia/Seoul': '首尔时间',
    'Asia/Kolkata': '印度时间',
    'Asia/Dubai': '迪拜时间',
    'Australia/Sydney': '悉尼时间',
    'UTC': 'UTC',
  };

  if (locale === 'zh') {
    return ZH[safe] ?? tzLabel ?? safe;
  }
  // English: Slack's tz_label ("Eastern Daylight Time") is the most human; use
  // it when available, else fall back to the IANA string.
  return tzLabel ?? safe;
}
