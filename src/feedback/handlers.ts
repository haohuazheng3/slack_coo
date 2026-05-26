/**
 * The Slack-side surface of the feedback flow.
 *
 * Three entry points:
 *   1. `feedback_open` action — fires when a user clicks the 🐞 button under a
 *      bot reply. We open a modal asking them to describe the problem.
 *   2. `feedback_submit` view — fires when they submit the modal. We capture
 *      a full snapshot (conversation, tasks, metadata) and save to Postgres.
 *   3. `/feedback` slash command — opens the same modal without a specific
 *      message anchor (for general "the bot feels off lately" reports).
 *
 * The snapshot is captured at SUBMIT time (not click time) so the data is
 * fresh — if the user describes a bug that just happened on the next turn
 * after they clicked, the next-turn state is included.
 */

import type { App, BlockAction, ButtonAction, SlackViewAction, SlackCommandMiddlewareArgs } from '@slack/bolt';
import { prisma } from '../lib/prisma';
import { conversationStore } from '../orchestrator/conversationStore';
import { getConversationKey } from '../lib/sendHelpers';
import { getUserProfile } from '../lib/userProfile';
import { createLogger } from '../lib/logger';

const log = createLogger('Feedback');

const VIEW_CALLBACK_ID = 'feedback_submit';

// ─────────── modal builder ───────────

/**
 * Build the description-input modal. `privateMetadata` carries enough context
 * for us to recover the user's situation at submit time — channel, the
 * message they clicked (if any), the speaker. Slack limits private_metadata
 * to ~3000 chars, more than enough for these few fields.
 */
function buildModalView(args: {
  privateMetadata: string;
  defaultLang: 'en' | 'zh';
}) {
  const isZh = args.defaultLang === 'zh';
  return {
    type: 'modal' as const,
    callback_id: VIEW_CALLBACK_ID,
    private_metadata: args.privateMetadata,
    title: {
      type: 'plain_text' as const,
      text: isZh ? '反馈 Aiptima 的问题' : 'Report an Aiptima issue',
    },
    submit: { type: 'plain_text' as const, text: isZh ? '提交' : 'Submit' },
    close: { type: 'plain_text' as const, text: isZh ? '取消' : 'Cancel' },
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: isZh
            ? '_告诉我们刚才发生了什么。不用整理,想到什么写什么——bot 的对话上下文我们会自动一起保存。_'
            : "_Tell us what happened. No need to write it up cleanly — we capture the bot's conversation context automatically._",
        },
      },
      {
        type: 'input',
        block_id: 'description_block',
        label: {
          type: 'plain_text' as const,
          text: isZh ? '出了什么问题' : 'What went wrong',
        },
        element: {
          type: 'plain_text_input' as const,
          action_id: 'description_input',
          multiline: true,
          placeholder: {
            type: 'plain_text' as const,
            text: isZh
              ? '示例:它把任务给错人了 / 时间算错了 / 应该用中文但回英文了 …'
              : 'e.g. Assigned to the wrong person · Deadline parsed wrong · Replied in English when I asked in Chinese …',
          },
          min_length: 1,
          max_length: 2000,
        },
      },
    ],
  };
}

type PrivateMeta = {
  /** Slack channel id of the bot message the user clicked (if any). */
  channelId?: string;
  /** Bot message ts (for anchoring + recovering conversation). */
  messageTs?: string;
  /** Thread ts if the message was in a thread. */
  threadTs?: string;
  /** The visible text of the bot message they clicked on (fallback if conversationStore lost it). */
  triggerText?: string;
  /** Trigger source — button | slash_command. */
  source: 'button' | 'slash_command';
};

// ─────────── registration ───────────

export function registerFeedbackHandlers(app: App): void {
  // ─── button click → open modal ───
  app.action<BlockAction<ButtonAction>>('feedback_open', async ({ ack, body, client }) => {
    await ack();

    try {
      const channelId = (body as any).channel?.id ?? (body as any).container?.channel_id;
      const message = (body as any).message;
      const messageTs = message?.ts;
      const threadTs = message?.thread_ts;

      // Capture visible text — both top-level text and any mrkdwn from blocks.
      let triggerText = '';
      if (typeof message?.text === 'string') triggerText = message.text;
      if (Array.isArray(message?.blocks)) {
        const fromBlocks: string[] = [];
        for (const b of message.blocks) {
          if (b?.text?.text) fromBlocks.push(String(b.text.text));
        }
        if (fromBlocks.length > 0) triggerText = `${triggerText}\n${fromBlocks.join('\n')}`.trim();
      }
      triggerText = triggerText.slice(0, 4000); // private_metadata budget

      const meta: PrivateMeta = {
        channelId,
        messageTs,
        threadTs,
        triggerText,
        source: 'button',
      };

      // Crude language inference for the modal labels: if the user's button
      // sits below Chinese content, the modal should also be Chinese.
      const defaultLang: 'en' | 'zh' = /[一-鿿]/.test(triggerText) ? 'zh' : 'en';

      await client.views.open({
        trigger_id: body.trigger_id,
        view: buildModalView({
          privateMetadata: JSON.stringify(meta),
          defaultLang,
        }),
      });
    } catch (err) {
      log.error('feedback_open failed', { error: String(err) });
    }
  });

  // ─── view submit → save report ───
  app.view(VIEW_CALLBACK_ID, async ({ ack, body, view, client }) => {
    await ack();

    let meta: PrivateMeta;
    try {
      meta = JSON.parse(view.private_metadata || '{}');
    } catch {
      meta = { source: 'button' };
    }

    const description = (
      view.state.values.description_block?.description_input?.value ?? ''
    ).trim();

    if (!description) {
      log.warn('Empty feedback description, skipping save');
      return;
    }

    const reporterId = body.user.id;
    const teamId = body.team?.id ?? null;
    const enterpriseId = (body as any).enterprise?.id ?? null;

    // ─── build snapshots ───
    // Conversation: best-effort pull from the in-memory store. If lost across a
    // restart, we still have `triggerText` captured at click time.
    let conversationSnapshot: any[] = [];
    if (meta.channelId) {
      const key = getConversationKey(meta.channelId, meta.threadTs, meta.messageTs);
      conversationSnapshot = conversationStore.get(key);
    }

    // Tasks: take a snapshot of every open task owned by the reporter — that's
    // the most likely subject of a "the bot did something weird" report. Cheap
    // query, bounded result set.
    let taskSnapshot: any[] = [];
    try {
      const tasks = await prisma.task.findMany({
        where: {
          teamId,
          enterpriseId,
          OR: [{ initiator: reporterId }, { createdBy: reporterId }, { assignee: reporterId }],
          status: { notIn: ['COMPLETED', 'CANCELLED'] },
        },
        orderBy: { time: 'asc' },
        take: 30,
      });
      taskSnapshot = tasks.map((t) => ({
        id: t.id,
        title: t.title,
        description: t.description,
        status: t.status,
        priority: t.priority,
        assignee: t.assignee,
        initiator: t.initiator,
        time: t.time.toISOString(),
        progressPercent: t.progressPercent,
        lastProgressSummary: t.lastProgressSummary,
        lastProgressAt: t.lastProgressAt?.toISOString() ?? null,
        createdAt: t.createdAt.toISOString(),
        updatedAt: t.updatedAt.toISOString(),
      }));
    } catch (err) {
      log.warn('Failed to snapshot tasks', { error: String(err) });
    }

    // Reporter display name — cached for the admin view so it doesn't have to
    // round-trip Slack on every render.
    let reporterName: string | null = null;
    try {
      const profile = await getUserProfile(client, reporterId, { teamId, enterpriseId });
      reporterName = profile?.displayName ?? null;
    } catch {
      // ignore — name is decorative.
    }

    const metadata = {
      surface:
        meta.channelId?.startsWith('D') ? 'dm' : meta.channelId ? 'channel' : 'unknown',
      channelId: meta.channelId ?? null,
      triggerSource: meta.source,
    };

    try {
      const saved = await prisma.feedbackReport.create({
        data: {
          teamId,
          enterpriseId,
          reporterId,
          reporterName,
          triggerChannelId: meta.channelId ?? '',
          triggerMessageTs: meta.messageTs ?? null,
          triggerThreadTs: meta.threadTs ?? null,
          triggerText: meta.triggerText ?? null,
          description,
          conversationSnapshot: conversationSnapshot as any,
          taskSnapshot: taskSnapshot as any,
          metadata: metadata as any,
        },
      });
      log.info('Saved feedback report', { id: saved.id, reporterId });
    } catch (err) {
      log.error('Failed to save feedback', { error: String(err) });
      return;
    }

    // Thank-you DM. No feedback button on this one (skipFeedbackButton),
    // otherwise meta-feedback loops get weird.
    try {
      const dm = await client.conversations.open({ users: reporterId });
      const dmChannel = (dm as any).channel?.id;
      if (dmChannel) {
        const thankYou =
          /[一-鿿]/.test(description)
            ? '🐞 已记录,谢谢——开发那边会查看这条反馈。'
            : '🐞 Got it — saved this report for the dev team to look at. Thanks.';
        await client.chat.postMessage({
          channel: dmChannel,
          text: thankYou,
          // Intentionally no `withFeedbackButton` wrap — meta-feedback recursion is annoying.
        });
      }
    } catch {
      // Thank-you is decorative — fine if it fails.
    }
  });

  // ─── /feedback slash command → open the same modal, no message anchor ───
  app.command('/feedback', async (args: SlackCommandMiddlewareArgs) => {
    const { ack, body } = args;
    // Bolt's middleware passes a `client` at runtime; the typed signature is a
    // bit narrower than reality. Cast explicitly so we can open the modal.
    const client = (args as any).client;
    await ack();
    try {
      const meta: PrivateMeta = {
        source: 'slash_command',
        // For slash commands we don't have a message to anchor to; the user is
        // saying "something feels off in general". Snapshot still happens at
        // submit time, scoped to the reporter's recent tasks.
      };
      const text = (body as any).text || '';
      const defaultLang: 'en' | 'zh' = /[一-鿿]/.test(text) ? 'zh' : 'en';

      await client.views.open({
        trigger_id: (body as any).trigger_id,
        view: buildModalView({
          privateMetadata: JSON.stringify(meta),
          defaultLang,
        }),
      });
    } catch (err) {
      log.error('/feedback slash command failed', { error: String(err) });
    }
  });
}
