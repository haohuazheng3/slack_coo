import { WebClient } from '@slack/web-api';
import { getBotTokenForTeam, getBotUserIdForTeam } from '../installation/installationStore';
import { createLogger } from './logger';

const log = createLogger('SlackClient');

/**
 * In-process cache of (teamId+enterpriseId) -> WebClient.
 * WebClient is thread-safe and reusable; we cache to avoid recreating per call.
 */
const clientCache = new Map<string, WebClient>();
const botUserIdCache = new Map<string, string>();

function cacheKey(teamId?: string | null, enterpriseId?: string | null): string {
  return `${teamId ?? '-'}|${enterpriseId ?? '-'}`;
}

/**
 * Resolve a WebClient for a given Slack workspace, hydrated from the InstallationStore.
 * Returns null if no installation exists yet for that team (e.g. the workspace uninstalled).
 */
export async function getClientForTeam(
  teamId: string | null | undefined,
  enterpriseId?: string | null
): Promise<WebClient | null> {
  const key = cacheKey(teamId, enterpriseId);
  const cached = clientCache.get(key);
  if (cached) return cached;

  const token = await getBotTokenForTeam(teamId ?? null, enterpriseId ?? null);
  if (!token) {
    log.warn('No installation found for team', { teamId, enterpriseId });
    return null;
  }

  const client = new WebClient(token);
  clientCache.set(key, client);
  return client;
}

/**
 * Resolve the bot's own user ID inside a specific workspace.
 * Used so the AI orchestrator can strip "<@BOT>" mentions from incoming events.
 */
export async function getBotUserId(
  teamId: string | null | undefined,
  enterpriseId?: string | null
): Promise<string | null> {
  const key = cacheKey(teamId, enterpriseId);
  const cached = botUserIdCache.get(key);
  if (cached) return cached;

  const id = await getBotUserIdForTeam(teamId ?? null, enterpriseId ?? null);
  if (id) botUserIdCache.set(key, id);
  return id;
}

/**
 * Drop cached references for a workspace. Call after handling an `app_uninstalled` event.
 */
export function evictTeamFromCache(teamId?: string | null, enterpriseId?: string | null): void {
  const key = cacheKey(teamId, enterpriseId);
  clientCache.delete(key);
  botUserIdCache.delete(key);
}
