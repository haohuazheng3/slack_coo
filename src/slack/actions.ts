import { App, BlockAction, ButtonAction } from '@slack/bolt';
import { FunctionRegistry } from '../orchestrator/functionRegistry';
import { handleConversationTurn } from '../orchestrator/handleConversationTurn';
import { prisma } from '../lib/prisma';
import { buildTaskListMessage } from './listTasks';
import {
  syncChannelTaskCard,
  persistChannelMessageTs,
  refreshOwnerHome,
} from './taskCardUpdater';
import { createLogger } from '../lib/logger';
import { buildUserMessagePayload, getConversationKey } from '../lib/sendHelpers';
import { conversationStore } from '../orchestrator/conversationStore';

const log = createLogger('Actions');

type PendingState = {
  taskId: string;
  kind: 'not_completed_reason' | 'blocked_reason';
};

const pendingReasonByUser = new Map<string, PendingState>();

export function isAwaitingReasonFromUser(userId: string): boolean {
  return pendingReasonByUser.has(userId);
}

export async function consumeReasonReply(userId: string, channelId: string, text: string, client: any): Promise<boolean> {
  const pending = pendingReasonByUser.get(userId);
  if (!pending) return false;
  pendingReasonByUser.delete(userId);

  try {
    const task = await prisma.task.findUnique({ where: { id: pending.taskId } });
    if (!task) {
      await client.chat.postMessage({ channel: channelId, text: '❌ Task not found.' });
      return true;
    }

    const updated = await prisma.task.update({
      where: { id: pending.taskId },
      data: {
        status: pending.kind === 'not_completed_reason' ? 'FAILED' : 'BLOCKED',
        completed: false,
        notCompletedReason: text,
        notCompletedReasonAt: new Date(),
        lastProgressSummary: text.slice(0, 280),
        lastProgressAt: new Date(),
      },
    });
    await prisma.progressUpdate.create({
      data: {
        taskId: pending.taskId,
        source: 'employee_reply',
        authorId: userId,
        rawText: text,
        summary: text.slice(0, 280),
        statusAtTime: updated.status,
        progressPercent: updated.progressPercent,
      },
    });

    const ts = await syncChannelTaskCard(client, updated);
    if (ts && ts !== updated.channelMessageTs) {
      await persistChannelMessageTs(updated.id, ts);
    }
    const ownerId = updated.initiator || updated.createdBy;
    if (ownerId) refreshOwnerHome(client, ownerId).catch(() => undefined);

    await client.chat.postMessage({ channel: channelId, text: '📝 Thanks, recorded.' });
  } catch (err) {
    log.error('Failed to consume reason reply', { error: String(err) });
    await client.chat.postMessage({ channel: channelId, text: '❌ Failed to record. Please try again.' });
  }
  return true;
}

export function registerActions(app: App, registry: FunctionRegistry) {

  app.action<BlockAction<ButtonAction>>('task_mark_complete', async ({ ack, body, client, action }) => {
    await ack();
    const taskId = action.value;
    const userId = body.user.id;
    const container = (body as any).container || {};
    const channelId = ((body as any).channel && (body as any).channel.id) || container.channel_id;

    if (!taskId) return;

    try {
      const updated = await prisma.task.update({
        where: { id: taskId },
        data: {
          status: 'COMPLETED',
          completed: true,
          completedAt: new Date(),
          progressPercent: 100,
          lastProgressSummary: 'Marked complete via button.',
          lastProgressAt: new Date(),
        },
      });

      await prisma.progressUpdate.create({
        data: {
          taskId: updated.id,
          source: 'manual_owner',
          authorId: userId,
          summary: `Marked complete by ${userId} via button.`,
          statusAtTime: 'COMPLETED',
          progressPercent: 100,
        },
      });

      const ts = await syncChannelTaskCard(client, updated);
      if (ts && ts !== updated.channelMessageTs) {
        await persistChannelMessageTs(updated.id, ts);
      }
      const ownerId = updated.initiator || updated.createdBy;
      if (ownerId) refreshOwnerHome(client, ownerId).catch(() => undefined);

      if (channelId) {
        await client.chat.postEphemeral({
          channel: channelId,
          user: userId,
          text: `✅ Marked "${updated.title}" complete.`,
        });
      }
    } catch (err) {
      log.error('task_mark_complete failed', { error: String(err) });
      if (channelId) {
        await client.chat.postEphemeral({
          channel: channelId,
          user: userId,
          text: '❌ Failed to mark complete.',
        });
      }
    }
  });

  app.action<BlockAction<ButtonAction>>('task_delete', async ({ ack, body, client, action }) => {
    await ack();
    const taskId = action.value;
    const userId = body.user.id;
    const container = (body as any).container || {};
    const channelId = ((body as any).channel && (body as any).channel.id) || container.channel_id;

    if (!taskId) return;

    try {
      const existing = await prisma.task.findUnique({ where: { id: taskId } });
      if (!existing) {
        if (channelId) {
          await client.chat.postEphemeral({ channel: channelId, user: userId, text: '❌ Task not found.' });
        }
        return;
      }
      await prisma.task.delete({ where: { id: taskId } });

      if (channelId) {
        await client.chat.postEphemeral({
          channel: channelId,
          user: userId,
          text: `🗑️ Deleted "${existing.title}".`,
        });
      }

      const messageTs = (body as any).message?.ts;
      const messageChannel = (body as any).channel?.id;
      if (messageTs && messageChannel) {
        try {
          // Let buildTaskListMessage auto-detect language from the user's tasks.
          const refreshed = await buildTaskListMessage(prisma, userId, {
            showCompleted: false,
            showAll: false,
          });
          await client.chat.update({
            channel: messageChannel,
            ts: messageTs,
            text: refreshed.text,
            blocks: refreshed.blocks,
          });
        } catch {

        }
      }

      const ownerId = existing.initiator || existing.createdBy;
      if (ownerId) refreshOwnerHome(client, ownerId).catch(() => undefined);
    } catch (err) {
      log.error('task_delete failed', { error: String(err) });
      if (channelId) {
        await client.chat.postEphemeral({ channel: channelId, user: userId, text: '❌ Failed to delete task.' });
      }
    }
  });

  app.action<BlockAction<ButtonAction>>('list_tasks', async ({ ack, body, client, action }) => {
    await ack();
    const userId = action.value || body.user.id;
    const message = await buildTaskListMessage(prisma, userId, {
      showCompleted: false,
      showAll: false,
    });
    await client.chat.postMessage({
      channel: userId,
      text: message.text,
      blocks: message.blocks,
    });
  });

  app.action<BlockAction<ButtonAction>>('task_edit_start', async ({ ack, body, client, action }) => {
    await ack();
    const taskId = action.value;
    if (!taskId) return;

    const userId = body.user.id;
    const container = (body as any).container || {};
    const channelId = ((body as any).channel && (body as any).channel.id) || container.channel_id;
    const threadTs = container.thread_ts || (body as any).message?.thread_ts;
    const messageTs = container.message_ts || (body as any).message?.ts;

    if (!channelId) return;

    const task = await prisma.task.findUnique({ where: { id: taskId } });
    if (!task) {
      await client.chat.postEphemeral({
        channel: channelId,
        user: userId,
        text: '❌ Task not found.',
      });
      return;
    }

    const conversationKey = getConversationKey(channelId, threadTs, messageTs);
    const selectionPayload = buildUserMessagePayload({
      userId,
      channelId,
      text: `User clicked Modify for task "${task.title}". Please ask which field(s) to change (title, description, assignee, dueTime, priority) and then call [UpdateTaskDetails] with taskId="${task.id}".`,
      metadata: {
        taskId: task.id,
        title: task.title,
        assignee: task.assignee,
        dueTime: task.time.toISOString(),
      },
    });
    conversationStore.append(conversationKey, { role: 'user', content: selectionPayload });

    await handleConversationTurn({
      client,
      registry,
      userId,
      channelId,
      threadTs: threadTs || messageTs,
      fallbackTs: messageTs,
      text: `User initiated edit for task ${task.title}`,
      metadata: { taskId: task.id },
    });
  });

  app.action<BlockAction<ButtonAction>>('progress_task_completed', async ({ ack, body, client, action }) => {
    await ack();
    const taskId = action.value;
    if (!taskId) return;

    try {
      const updated = await prisma.task.update({
        where: { id: taskId },
        data: {
          status: 'COMPLETED',
          completed: true,
          completedAt: new Date(),
          progressPercent: 100,
          lastProgressSummary: 'Reported complete via button.',
          lastProgressAt: new Date(),
          notCompletedReason: null,
          notCompletedReasonAt: null,
        },
      });
      await prisma.progressUpdate.create({
        data: {
          taskId: updated.id,
          source: 'employee_reply',
          authorId: body.user.id,
          summary: 'Reported complete via button.',
          statusAtTime: 'COMPLETED',
          progressPercent: 100,
        },
      });

      const ts = await syncChannelTaskCard(client, updated);
      if (ts && ts !== updated.channelMessageTs) {
        await persistChannelMessageTs(updated.id, ts);
      }
      const ownerId = updated.initiator || updated.createdBy;
      if (ownerId) {
        refreshOwnerHome(client, ownerId).catch(() => undefined);

        try {
          const dm = await client.conversations.open({ users: ownerId });
          const dmChannel = (dm as any).channel?.id || ownerId;
          await client.chat.postMessage({
            channel: dmChannel,
            text: `✅ <@${body.user.id}> marked *${updated.title}* complete.`,
          });
        } catch {

        }
      }

      await client.chat.postMessage({
        channel: body.user.id,
        text: '✅ Marked as completed. Thank you!',
      });
    } catch (err) {
      log.error('progress_task_completed failed', { error: String(err) });
      await client.chat.postMessage({ channel: body.user.id, text: '❌ Failed to update status.' });
    }
  });

  app.action<BlockAction<ButtonAction>>('progress_task_blocked', async ({ ack, body, client, action }) => {
    await ack();
    const taskId = action.value;
    if (!taskId) return;
    pendingReasonByUser.set(body.user.id, { taskId, kind: 'blocked_reason' });
    await client.chat.postMessage({
      channel: body.user.id,
      text: '⛔ Got it. In one or two sentences, what is blocking you? (I will summarize this for the owner.)',
    });
  });

  // Owner silence-alert actions (see scheduler/progressCheck.ts).
  // "Nudge them for me" → bot DMs the assignee again with a soft check-in.
  // "I'll handle it"    → just acknowledge, suppress further alerts on this silence window.
  app.action<BlockAction<ButtonAction>>('silence_nudge_assignee', async ({ ack, body, client, action }) => {
    await ack();
    const taskId = action.value;
    if (!taskId) return;
    try {
      const task = await prisma.task.findUnique({ where: { id: taskId } });
      if (!task) return;
      const { nudgeProgressFunction } = await import('../functions/nudgeProgress');
      const fn = nudgeProgressFunction();
      await fn.handler(
        { taskId, reason: 'owner_requested' },
        {
          prisma,
          slack: {
            client,
            channelId: task.channelId,
            userId: task.assignee,
            rawText: '',
            threadTs: undefined,
            teamId: task.teamId,
            enterpriseId: task.enterpriseId,
            send: async () => undefined,
          },
        }
      );
      await client.chat.postMessage({
        channel: body.user.id,
        text: `OK, I just nudged <@${task.assignee}>. I'll loop back the moment they reply.`,
      });
    } catch (err) {
      log.error('silence_nudge_assignee failed', { error: String(err) });
    }
  });

  app.action<BlockAction<ButtonAction>>('silence_owner_handles', async ({ ack, body, client, action }) => {
    await ack();
    const taskId = action.value;
    if (!taskId) return;
    try {
      // Bump lastSilenceAlertAt so the cron doesn't re-alert on this same window —
      // the owner has explicitly taken ownership of the follow-up.
      await prisma.task.update({
        where: { id: taskId },
        data: { lastSilenceAlertAt: new Date() },
      });
      await client.chat.postMessage({
        channel: body.user.id,
        text: `Got it — leaving it with you. I'll keep tracking and surface anything new.`,
      });
    } catch (err) {
      log.error('silence_owner_handles failed', { error: String(err) });
    }
  });
}
