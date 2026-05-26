import type { Installation, InstallationQuery, InstallationStore } from '@slack/oauth';
import { prisma } from '../lib/prisma';
import { createLogger } from '../lib/logger';

const log = createLogger('InstallationStore');

/**
 * Prisma-backed Slack InstallationStore.
 * One row per (teamId, enterpriseId) tuple. Bot token + bot id + metadata are persisted to Neon.
 *
 * Compatible with both single-workspace installs and Enterprise Grid org-level installs.
 */
export const prismaInstallationStore: InstallationStore = {
  async storeInstallation(installation: Installation) {
    const teamId = installation.team?.id ?? null;
    const enterpriseId = installation.enterprise?.id ?? null;
    const isEnterpriseInstall = Boolean(installation.isEnterpriseInstall);

    const botToken = installation.bot?.token;
    if (!botToken) {

      throw new Error('Cannot store installation without a bot token.');
    }

    const data = {
      teamId,
      enterpriseId,
      installerUserId: installation.user?.id ?? null,
      botId: installation.bot?.id ?? null,
      botUserId: installation.bot?.userId ?? null,
      botToken,
      botRefreshToken: installation.bot?.refreshToken ?? null,
      botTokenExpiresAt: installation.bot?.expiresAt
        ? new Date(installation.bot.expiresAt * 1000)
        : null,
      scopes: Array.isArray(installation.bot?.scopes)
        ? installation.bot!.scopes.join(',')
        : null,
      isEnterpriseInstall,
      raw: installation as any,
    };

    const existing = await prisma.slackInstallation.findFirst({
      where: { teamId, enterpriseId },
    });

    if (existing) {
      await prisma.slackInstallation.update({ where: { id: existing.id }, data });
      log.info('Updated existing installation', { teamId, enterpriseId });
    } else {
      await prisma.slackInstallation.create({ data });
      log.info('Created new installation', { teamId, enterpriseId });
    }
  },

  async fetchInstallation(query: InstallationQuery<boolean>): Promise<Installation> {
    const teamId = query.teamId ?? null;
    const enterpriseId = query.enterpriseId ?? null;

    const row = await prisma.slackInstallation.findFirst({
      where: {
        OR: [
          { teamId, enterpriseId },
          query.isEnterpriseInstall && enterpriseId ? { enterpriseId, teamId: null } : undefined,
        ].filter(Boolean) as any,
      },
      orderBy: { updatedAt: 'desc' },
    });

    if (!row) {
      throw new Error(
        `No installation found for teamId=${teamId} enterpriseId=${enterpriseId}`
      );
    }

    return row.raw as unknown as Installation;
  },

  async deleteInstallation(query: InstallationQuery<boolean>): Promise<void> {
    const teamId = query.teamId ?? null;
    const enterpriseId = query.enterpriseId ?? null;
    await prisma.slackInstallation.deleteMany({
      where: { teamId, enterpriseId },
    });
    log.info('Deleted installation', { teamId, enterpriseId });
  },
};

/**
 * Convenience for the scheduler / non-Slack-event contexts that just need the bot token.
 * Returns null if no installation exists for that team.
 */
export async function getBotTokenForTeam(
  teamId: string | null | undefined,
  enterpriseId?: string | null
): Promise<string | null> {
  if (!teamId && !enterpriseId) return null;
  const row = await prisma.slackInstallation.findFirst({
    where: {
      teamId: teamId ?? null,
      enterpriseId: enterpriseId ?? null,
    },
  });
  return row?.botToken ?? null;
}

export async function getBotUserIdForTeam(
  teamId: string | null | undefined,
  enterpriseId?: string | null
): Promise<string | null> {
  if (!teamId && !enterpriseId) return null;
  const row = await prisma.slackInstallation.findFirst({
    where: {
      teamId: teamId ?? null,
      enterpriseId: enterpriseId ?? null,
    },
  });
  return row?.botUserId ?? null;
}

/**
 * The Slack user id of the person who installed the app to this workspace.
 *
 * We treat them as the "workspace owner" for engagement decisions — when they
 * speak in a channel, the bot engages directly without going through the
 * ambient relevance gate. Employees (everyone else) still get the gate, so
 * they aren't followed everywhere they post.
 *
 * Cached in memory per (teamId, enterpriseId) — installer changes only when
 * someone re-installs from another account, which is rare. We invalidate on
 * `evictWorkspaceOwnerCache` (called from `app_uninstalled`).
 */
const installerCache = new Map<string, { id: string | null; at: number }>();
const INSTALLER_TTL_MS = 30 * 60 * 1000;

function ownerCacheKey(teamId: string | null, enterpriseId: string | null): string {
  return `${teamId ?? '-'}|${enterpriseId ?? '-'}`;
}

export async function getInstallerUserId(
  teamId: string | null | undefined,
  enterpriseId?: string | null
): Promise<string | null> {
  if (!teamId && !enterpriseId) return null;
  const k = ownerCacheKey(teamId ?? null, enterpriseId ?? null);
  const hit = installerCache.get(k);
  if (hit && Date.now() - hit.at < INSTALLER_TTL_MS) return hit.id;
  const row = await prisma.slackInstallation.findFirst({
    where: {
      teamId: teamId ?? null,
      enterpriseId: enterpriseId ?? null,
    },
    select: { installerUserId: true },
  });
  const id = row?.installerUserId ?? null;
  installerCache.set(k, { id, at: Date.now() });
  return id;
}

export function evictWorkspaceOwnerCache(
  teamId: string | null | undefined,
  enterpriseId?: string | null
): void {
  installerCache.delete(ownerCacheKey(teamId ?? null, enterpriseId ?? null));
}
