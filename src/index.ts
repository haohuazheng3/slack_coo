import { App, ExpressReceiver, LogLevel as BoltLogLevel } from '@slack/bolt';
import dotenv from 'dotenv';

import { prisma } from './lib/prisma';
import { createLogger } from './lib/logger';
import { getBotUserId } from './lib/slackClient';

import { FunctionRegistry } from './orchestrator/functionRegistry';
import { registerCoreFunctions } from './functions';
import { handleConversationTurn } from './orchestrator/handleConversationTurn';
import { conversationStore } from './orchestrator/conversationStore';

import { startTaskReminderScheduler } from './scheduler/taskReminder';
import { startProgressCheckScheduler } from './scheduler/progressCheck';

import {
  registerActions,
  isAwaitingReasonFromUser,
  consumeReasonReply,
} from './slack/actions';
import { buildHomeView } from './slack/homeView';
import { getConversationKey } from './lib/sendHelpers';

import { prismaInstallationStore } from './installation/installationStore';
import { failureHtml, installLandingHtml, sendHtml, successHtml } from './installation/pages';

dotenv.config();

const log = createLogger('App');

const requiredEnv = [
  'SLACK_CLIENT_ID',
  'SLACK_CLIENT_SECRET',
  'SLACK_SIGNING_SECRET',
  'SLACK_STATE_SECRET',
  'OPENAI_API_KEY',
  'DATABASE_URL',
];
for (const k of requiredEnv) {
  if (!process.env[k]) {
    console.error(`Missing required env var: ${k}`);
    process.exit(1);
  }
}

const BOT_SCOPES = [
  'app_mentions:read',
  'chat:write',
  'chat:write.public',
  'im:history',
  'im:read',
  'im:write',
  'users:read',
];

const PORT = Number(process.env.PORT) || 3030;
const BASE_URL = process.env.BASE_URL?.replace(/\/$/, '') || '';

const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET!,
  clientId: process.env.SLACK_CLIENT_ID!,
  clientSecret: process.env.SLACK_CLIENT_SECRET!,
  stateSecret: process.env.SLACK_STATE_SECRET!,
  scopes: BOT_SCOPES,
  installationStore: prismaInstallationStore,
  installerOptions: {
    directInstall: true,
    redirectUriPath: '/slack/oauth_redirect',
    installPath: '/slack/install',
    callbackOptions: {
      success: (_installation, _options, _req, res) => {
        sendHtml(res as any, successHtml());
      },
      failure: (error, _options, _req, res) => {
        sendHtml(res as any, failureHtml(error?.message ?? String(error)), 500);
      },
    },
  },
  endpoints: {
    events: '/slack/events',
  },
  logLevel: (process.env.BOLT_LOG_LEVEL as BoltLogLevel) ?? BoltLogLevel.WARN,
});

const app = new App({ receiver });

const functionRegistry = new FunctionRegistry();
registerCoreFunctions(functionRegistry);

registerActions(app, functionRegistry);

receiver.router.get('/healthz', (_req, res) => {
  res.status(200).json({ ok: true, time: new Date().toISOString() });
});

receiver.router.get('/', (_req, res) => {
  const installUrl = BASE_URL
    ? `${BASE_URL}/slack/install`
    : '/slack/install';
  sendHtml(res, installLandingHtml(installUrl));
});

app.event('app_mention', async ({ event, client, context }) => {
  const userId = (event as any).user as string | undefined;
  const channelId = (event as any).channel as string | undefined;
  const text = ((event as any).text as string | undefined) ?? '';
  const ts = (event as any).ts as string | undefined;
  const incomingThreadTs = (event as any).thread_ts as string | undefined;

  if (!userId || !channelId) return;

  const teamId = context.teamId ?? null;
  const enterpriseId = context.enterpriseId ?? null;

  const threadTs = incomingThreadTs || ts;
  const botUserId =
    context.botUserId ?? (await getBotUserId(teamId, enterpriseId));
  const sanitized = botUserId
    ? text.replace(new RegExp(`<@${botUserId}>`, 'g'), '').trim()
    : text;

  await handleConversationTurn({
    client,
    registry: functionRegistry,
    userId,
    channelId,
    teamId,
    enterpriseId,
    threadTs,
    fallbackTs: ts,
    text: sanitized || text,
  });
});

app.message(async ({ message, client, context }) => {
  if ((message as any).subtype) return;
  if ((message as any).bot_id) return;

  const userId = (message as any).user as string | undefined;
  const channelId = (message as any).channel as string | undefined;
  const text = (message as any).text as string | undefined;
  const ts = (message as any).ts as string | undefined;
  const threadTs = (message as any).thread_ts as string | undefined;

  if (!userId || !channelId || !text) return;

  if (channelId.startsWith('D') && isAwaitingReasonFromUser(userId)) {
    const handled = await consumeReasonReply(userId, channelId, text, client);
    if (handled) return;
  }

  const isDm = channelId.startsWith('D');
  if (!isDm) {

    if (!threadTs) return;
    const key = getConversationKey(channelId, threadTs, ts);
    if (!conversationStore.has(key)) return;
  }

  await handleConversationTurn({
    client,
    registry: functionRegistry,
    userId,
    channelId,
    teamId: context.teamId ?? null,
    enterpriseId: context.enterpriseId ?? null,
    threadTs,
    fallbackTs: ts,
    text,
  });
});

app.event('app_home_opened', async ({ event, client }) => {
  const userId = (event as any).user as string;
  try {
    const view = await buildHomeView(prisma, userId);
    await client.views.publish({ user_id: userId, view });
  } catch (err) {
    log.error('Failed to publish home view', { userId, error: String(err) });
  }
});

app.event('app_uninstalled', async ({ context }) => {
  const teamId = context.teamId ?? null;
  const enterpriseId = context.enterpriseId ?? null;
  try {
    if (prismaInstallationStore.deleteInstallation) {
      await prismaInstallationStore.deleteInstallation({
        teamId: teamId ?? undefined,
        enterpriseId: enterpriseId ?? undefined,
        isEnterpriseInstall: Boolean(context.isEnterpriseInstall),
      } as any);
    }
    const { evictTeamFromCache } = await import('./lib/slackClient');
    evictTeamFromCache(teamId, enterpriseId);
    log.info('App uninstalled, installation removed', { teamId, enterpriseId });
  } catch (err) {
    log.error('Failed to handle app_uninstalled', { error: String(err) });
  }
});

(async () => {
  await app.start(PORT);
  log.info('Slack AI COO is running (multi-tenant OAuth)', {
    port: PORT,
    installPath: '/slack/install',
    redirectPath: '/slack/oauth_redirect',
    baseUrl: BASE_URL || '(set BASE_URL for the landing page link)',
  });

  startTaskReminderScheduler();
  startProgressCheckScheduler(functionRegistry);
})();

const shutdown = async (signal: string) => {
  log.info(`Shutting down (${signal})`);
  try {
    await prisma.$disconnect();
  } catch {

  }
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
