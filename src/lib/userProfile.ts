import { WebClient } from '@slack/web-api';
import { createLogger } from './logger';

const log = createLogger('UserProfile');

/**
 * What we actually need to know about a Slack user, separate from the raw
 * `users.info` blob. Kept narrow so we don't accidentally rely on volatile
 * fields and so the cache footprint stays small.
 */
export type UserProfile = {
  userId: string;
  /** IANA tz identifier from Slack ("America/Detroit"), or null if unknown. */
  tz: string | null;
  /** Slack's human-readable label ("Eastern Daylight Time"), or null. */
  tzLabel: string | null;
  /** Display name to show in messages — display_name preferred, then real_name. */
  displayName: string | null;
};

const cache = new Map<string, { profile: UserProfile; cachedAt: number }>();
const TTL_MS = 6 * 60 * 60 * 1000;

function key(teamId: string | null, enterpriseId: string | null, userId: string): string {
  return `${teamId ?? '-'}|${enterpriseId ?? '-'}|${userId}`;
}

/**
 * Look up a Slack user's timezone + display name, with a 6-hour TTL cache.
 *
 * Timezones move rarely (someone has to relocate or fly across timezones AND
 * manually update Slack), so 6 hours is a sweet spot — long enough to amortize
 * the API call across hours of conversation, short enough that a real change
 * is reflected within a working day. The cache is in-memory only; a process
 * restart re-fetches on demand.
 *
 * Returns null only when the lookup truly fails (Slack API error, missing
 * scope, deleted user). The caller should treat null as "unknown" and fall
 * back to a workspace-level or server-level default — never assume UTC.
 */
export async function getUserProfile(
  client: WebClient,
  userId: string,
  workspace: { teamId: string | null; enterpriseId: string | null }
): Promise<UserProfile | null> {
  const k = key(workspace.teamId, workspace.enterpriseId, userId);
  const hit = cache.get(k);
  if (hit && Date.now() - hit.cachedAt < TTL_MS) return hit.profile;

  try {
    const result = (await client.users.info({ user: userId })) as any;
    const user = result?.user;
    if (!user) return null;
    const profile: UserProfile = {
      userId,
      tz: typeof user.tz === 'string' ? user.tz : null,
      tzLabel: typeof user.tz_label === 'string' ? user.tz_label : null,
      displayName:
        user.profile?.display_name?.trim() ||
        user.profile?.real_name?.trim() ||
        user.real_name?.trim() ||
        user.name ||
        null,
    };
    cache.set(k, { profile, cachedAt: Date.now() });
    return profile;
  } catch (err) {
    log.warn('users.info lookup failed', { userId, error: String(err) });
    return null;
  }
}

/** Drop the cached profile (e.g. after we learn a TZ change). Rarely needed. */
export function invalidateUserProfile(
  userId: string,
  workspace: { teamId: string | null; enterpriseId: string | null }
): void {
  cache.delete(key(workspace.teamId, workspace.enterpriseId, userId));
}
