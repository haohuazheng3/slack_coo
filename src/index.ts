import { App, ExpressReceiver, LogLevel as BoltLogLevel } from '@slack/bolt';
import dotenv from 'dotenv';

import { prisma } from './lib/prisma';
import { createLogger } from './lib/logger';
import { getBotUserId } from './lib/slackClient';

import { FunctionRegistry } from './orchestrator/functionRegistry';
import { registerCoreFunctions } from './functions';
import { handleConversationTurn } from './orchestrator/handleConversationTurn';
import { conversationStore } from './orchestrator/conversationStore';

import { startProgressCheckScheduler } from './scheduler/progressCheck';
import { shouldEngageAmbient } from './orchestrator/ambientGate';
import { eventDedupeKey, markSeenOrSkip } from './lib/eventDedupe';

import {
  registerActions,
  isAwaitingReasonFromUser,
  consumeReasonReply,
} from './slack/actions';
import { buildHomeView } from './slack/homeView';
import { getConversationKey } from './lib/sendHelpers';

import { prismaInstallationStore, getInstallerUserId } from './installation/installationStore';
import {
  failureHtml,
  installLandingHtml,
  readLangFromRequest,
  sendHtml,
  successHtml,
} from './installation/pages';

import { verifyDashboardToken } from './dashboard/auth';
import { buildDashboardSnapshot } from './dashboard/data';
import { renderDashboard, renderExpiredOrInvalid, LANG_SWITCH_PLACEHOLDER } from './dashboard/pages';

import { registerFeedbackHandlers } from './feedback/handlers';
import { renderFeedbackAdmin, renderFeedbackEmpty } from './feedback/pages';

dotenv.config();

const log = createLogger('App');

const requiredEnv = [
  'SLACK_CLIENT_ID',
  'SLACK_CLIENT_SECRET',
  'SLACK_SIGNING_SECRET',
  'SLACK_STATE_SECRET',
  'ANTHROPIC_API_KEY',
  'DATABASE_URL',
];
for (const k of requiredEnv) {
  if (!process.env[k]) {
    console.error(`Missing required env var: ${k}`);
    process.exit(1);
  }
}

// Ambient-listening scopes: channels:history + groups:history let the bot *see*
// non-mention messages in channels it's been invited to — without that, we can never
// be a real colleague-in-the-room, only a tool you summon. Existing workspaces will
// need to re-install to grant the new scopes; that's unavoidable.
const BOT_SCOPES = [
  'app_mentions:read',
  'chat:write',
  'chat:write.public',
  'channels:history',
  'groups:history',
  'im:history',
  'im:read',
  'im:write',
  'users:read',
  // `commands` powers the optional /feedback slash command. The 🐞 button under
  // every bot reply is the primary entry point and works without this scope;
  // /feedback is just a convenience for "general feedback not tied to a
  // specific reply". Existing workspaces don't have to reinstall just for this.
  'commands',
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
      success: (_installation, _options, req, res) => {
        // Slack's OAuth redirect doesn't preserve our `?lang=` choice, so the
        // success page defaults to English with the in-nav switcher available.
        const lang = req ? readLangFromRequest(req as any) : 'en';
        sendHtml(res as any, successHtml(lang));
      },
      failure: (error, _options, req, res) => {
        const lang = req ? readLangFromRequest(req as any) : 'en';
        sendHtml(res as any, failureHtml(error?.message ?? String(error), lang), 500);
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
registerFeedbackHandlers(app);

receiver.router.get('/healthz', (_req, res) => {
  res.status(200).json({ ok: true, time: new Date().toISOString() });
});

receiver.router.get('/', (req, res) => {
  const installUrl = BASE_URL
    ? `${BASE_URL}/slack/install`
    : '/slack/install';
  const lang = readLangFromRequest(req);
  sendHtml(res, installLandingHtml(installUrl, lang));
});

// Dashboard — opened from the Slack Home tab via a signed URL. The token in
// the query proves which Slack user (and which workspace) is asking; we never
// trust a `userId` from the request body or query directly. See dashboard/auth.ts.
receiver.router.get('/dashboard', async (req, res) => {
  const token = (req.query?.token ?? '').toString();
  const langQuery = (req.query?.lang ?? '').toString().toLowerCase();
  const langOverride = langQuery === 'en' || langQuery === 'zh' ? langQuery : null;

  const verified = verifyDashboardToken(token);
  if (!verified.ok) {
    // Don't leak which failure mode it was — same screen for expired vs forged.
    sendHtml(res, renderExpiredOrInvalid(langOverride ?? 'en'), 401);
    return;
  }
  const { uid, tid, eid } = verified.payload;

  try {
    const snapshot = await buildDashboardSnapshot({
      prisma,
      ownerId: uid,
      teamId: tid,
      enterpriseId: eid,
    });

    // Look up the viewer's timezone so every deadline on the page renders in
    // their local clock — the whole reason the user complained about UTC times.
    let viewerTz: string | null = null;
    try {
      const wsClient = await (await import('./lib/slackClient')).getClientForTeam(tid, eid);
      if (wsClient) {
        const profile = await (await import('./lib/userProfile')).getUserProfile(wsClient, uid, {
          teamId: tid,
          enterpriseId: eid,
        });
        viewerTz = profile?.tz ?? null;
      }
    } catch (err) {
      log.warn('Could not resolve dashboard viewer timezone', { error: String(err) });
    }

    // Deep-link back to Slack — opens the Aiptima Home tab if possible.
    const slackDeepLink = tid
      ? `slack://app?team=${encodeURIComponent(tid)}&id=A_AIPTIMA&tab=home`
      : 'https://slack.com/';

    let html = renderDashboard({ snapshot, langOverride, slackDeepLink, viewerTz });

    // Swap the lang-switcher placeholder for real URLs that preserve the token.
    // (We don't want the token interpolated twice into the template body.)
    const baseUrl = `/dashboard?token=${encodeURIComponent(token)}&lang=`;
    html = html.split(LANG_SWITCH_PLACEHOLDER).join(baseUrl);

    sendHtml(res, html);
  } catch (err) {
    log.error('Dashboard render failed', { error: String(err), uid });
    sendHtml(res, renderExpiredOrInvalid(langOverride ?? 'en'), 500);
  }
});

// Feedback view — open to every member of the workspace during internal beta.
// Signed token still required (so random internet visitors can't see anything),
// but no extra "you must be the installer" gate. If we ever go past beta we'll
// likely want to gate this back down — for now everyone with a valid token can
// see every report for their workspace.
receiver.router.get('/feedback', async (req, res) => {
  const token = (req.query?.token ?? '').toString();
  const verified = verifyDashboardToken(token);
  if (!verified.ok) {
    sendHtml(res, renderFeedbackEmpty('Link expired or invalid. Re-open from the Slack Home tab.'), 401);
    return;
  }
  const { tid, eid } = verified.payload;

  try {
    const reports = await prisma.feedbackReport.findMany({
      where: { teamId: tid, enterpriseId: eid },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    sendHtml(
      res,
      renderFeedbackAdmin({
        reports,
        workspaceName: tid,
        baseUrl: BASE_URL,
        showActions: true,
      })
    );
  } catch (err) {
    log.error('Feedback page render failed', { error: String(err) });
    sendHtml(res, renderFeedbackEmpty('Something broke while loading reports.'), 500);
  }
});

app.event('app_mention', async ({ event, client, context }) => {
  const userId = (event as any).user as string | undefined;
  const channelId = (event as any).channel as string | undefined;
  const text = ((event as any).text as string | undefined) ?? '';
  const ts = (event as any).ts as string | undefined;
  const incomingThreadTs = (event as any).thread_ts as string | undefined;

  if (!userId || !channelId) return;

  // Slack delivers both `app_mention` and `message.channels` for a channel
  // @-mention; we want to process the message exactly once. The dedupe key
  // is the underlying message ts, which is the same across both events.
  if (markSeenOrSkip(eventDedupeKey(event)) === 'duplicate') {
    log.info('Skipping duplicate app_mention', { ts });
    return;
  }

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
    triggerHint: 'app_mention',
  });
});

app.message(async ({ message, client, context }) => {
  // Allow file_share through so deliverable uploads ("here's the banner") reach
  // the orchestrator. Drop other subtypes (joins / leaves / edits / pins).
  const subtype = (message as any).subtype as string | undefined;
  if (subtype && subtype !== 'file_share') return;
  if ((message as any).bot_id) return;

  const userId = (message as any).user as string | undefined;
  const channelId = (message as any).channel as string | undefined;
  const text = (message as any).text as string | undefined;
  const ts = (message as any).ts as string | undefined;
  const threadTs = (message as any).thread_ts as string | undefined;
  const files = (message as any).files as Array<any> | undefined;
  const hasFiles = Array.isArray(files) && files.length > 0;

  // Allow file-share messages with no caption text. text must be a string for
  // downstream code, default to empty.
  const normalizedText = (text ?? '').toString();
  if (!userId || !channelId) return;
  if (!normalizedText && !hasFiles) return;

  // Cheap noise filter: a pure-emoji / pure-punctuation / single-character
  // reply ("👀", "👍", "ok", ".") doesn't deserve an Opus inference. The owner
  // gets routed straight to the orchestrator below, so without this filter
  // every reaction-style ping burns tokens for no value.
  const trimmedText = normalizedText.trim();
  if (!hasFiles && trimmedText.length <= 3 && /^[\p{P}\p{S}\p{Z}\p{Emoji}\s]*$/u.test(trimmedText)) {
    return;
  }

  // Compose the text the orchestrator sees: caption + a description of the
  // file(s) attached so the AI can interpret "稿子在这里" + uploaded.png as
  // a likely delivery without needing a separate channel for file metadata.
  let effectiveText = normalizedText;
  if (hasFiles) {
    const fileDescriptions = files!
      .map((f: any) => {
        const name = f.name || f.title || 'file';
        const mime = f.mimetype ? ` (${f.mimetype})` : '';
        return `${name}${mime}`;
      })
      .join(', ');
    const fileLine = `[attached: ${fileDescriptions}]`;
    effectiveText = normalizedText ? `${normalizedText}\n${fileLine}` : fileLine;
  }

  const teamId = context.teamId ?? null;
  const enterpriseId = context.enterpriseId ?? null;
  const isDm = channelId.startsWith('D');

  // Channel messages that @-mention the bot are ALREADY handled by the
  // `app_mention` event handler above. Slack delivers both, so we have to
  // pick a lane and skip the other one here — otherwise the orchestrator
  // runs twice and we end up creating duplicate tasks etc.
  if (!isDm) {
    const botUid = context.botUserId ?? (await getBotUserId(teamId, enterpriseId));
    if (botUid && normalizedText.includes(`<@${botUid}>`)) return;
  }

  // Belt-and-suspenders dedupe for Slack at-least-once retries and any
  // other subscription overlap we haven't accounted for.
  if (markSeenOrSkip(eventDedupeKey(message)) === 'duplicate') {
    log.info('Skipping duplicate message', { channelId, ts });
    return;
  }

  if (isDm && isAwaitingReasonFromUser(userId)) {
    const handled = await consumeReasonReply(userId, channelId, normalizedText, client);
    if (handled) return;
  }

  // DMs always get the full turn — that surface is 1:1 and intentional.
  if (isDm) {
    await handleConversationTurn({
      client,
      registry: functionRegistry,
      userId,
      channelId,
      teamId,
      enterpriseId,
      threadTs,
      fallbackTs: ts,
      text: effectiveText,
      triggerHint: 'dm',
    });
    return;
  }

  // In channels: if this is a follow-up inside a thread the bot is already part of,
  // continue the conversation without re-gating — it's clearly addressed to us.
  if (threadTs) {
    const key = getConversationKey(channelId, threadTs, ts);
    if (conversationStore.has(key)) {
      await handleConversationTurn({
        client,
        registry: functionRegistry,
        userId,
        channelId,
        teamId,
        enterpriseId,
        threadTs,
        fallbackTs: ts,
        text: effectiveText,
        triggerHint: 'thread_followup',
      });
      return;
    }
  }

  // Owner-priority engagement: if the speaker is the workspace installer (the
  // owner who set Aiptima up), engage automatically — no ambient gate, no LLM
  // round-trip to decide whether to listen. Their channel messages are nearly
  // always directive or work-related, and making them @-mention to be heard
  // defeats the "quiet colleague" feel we're going for. Other speakers still
  // get the gate so employees aren't shadowed across every channel.
  const installerId = await getInstallerUserId(teamId, enterpriseId);
  if (installerId && userId === installerId) {
    await handleConversationTurn({
      client,
      registry: functionRegistry,
      userId,
      channelId,
      teamId,
      enterpriseId,
      threadTs,
      fallbackTs: ts,
      text: effectiveText,
      triggerHint: 'owner_channel_speech',
    });
    return;
  }

  // Ambient path: any other channel message from someone other than the owner.
  // The LLM gate defaults to silence — if it says no, we never speak.
  const botUserId = context.botUserId ?? (await getBotUserId(teamId, enterpriseId));
  let gate;
  try {
    gate = await shouldEngageAmbient({
      prisma,
      teamId,
      enterpriseId,
      channelId,
      speakerUserId: userId,
      text: effectiveText,
      isSelf: botUserId ? userId === botUserId : false,
      botUserId,
    });
  } catch (err) {
    log.warn('Ambient gate threw — staying silent', { error: String(err) });
    return;
  }

  if (!gate.engage) return;

  log.info('Ambient gate engaged', { channelId, userId, why: gate.why });
  await handleConversationTurn({
    client,
    registry: functionRegistry,
    userId,
    channelId,
    teamId,
    enterpriseId,
    threadTs,
    fallbackTs: ts,
    text: effectiveText,
    triggerHint: `ambient:${gate.why}`,
  });
});

app.event('app_home_opened', async ({ event, client, context }) => {
  const userId = (event as any).user as string;
  try {
    const view = await buildHomeView(prisma, userId, {
      teamId: context.teamId ?? null,
      enterpriseId: context.enterpriseId ?? null,
    });
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
    const { evictWorkspaceOwnerCache } = await import('./installation/installationStore');
    evictWorkspaceOwnerCache(teamId, enterpriseId);
    log.info('App uninstalled, installation removed', { teamId, enterpriseId });
  } catch (err) {
    log.error('Failed to handle app_uninstalled', { error: String(err) });
  }
});

(async () => {
  await app.start(PORT);
  log.info('Aiptima is running (multi-tenant OAuth)', {
    port: PORT,
    installPath: '/slack/install',
    redirectPath: '/slack/oauth_redirect',
    baseUrl: BASE_URL || '(set BASE_URL for the landing page link)',
  });

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
