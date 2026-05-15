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
