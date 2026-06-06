import { App, BlockAction, ButtonAction } from '@slack/bolt';
import { FunctionRegistry } from '../orchestrator/functionRegistry';
import { handleConversationTurn } from '../orchestrator/handleConversationTurn';
import { prisma } from '../lib/prisma';
import { buildTaskListMessage } from './listTasks';
import { refreshOwnerHome } from './taskCardUpdater';
import { createLogger } from '../lib/logger';
import { buildUserMessagePayload, getConversationKey } from '../lib/sendHelpers';
import { conversationStore } from '../orchestrator/conversationStore';
import { detectLanguageFromTexts } from '../lib/i18n';

const log = createLogger('Actions');

type PendingState = {
  taskId: string;
  kind: 'not_completed_reason' | 'blocked_reason';
};

const pendingReasonByUser = new Map<string, PendingState>();

export function isAwaitingReasonFromUser(userId: string): boolean {
  return pendingReasonByUser.has(userId);
}

/**
 * Decide reply language from the task this button is on (its title /
 * description / recent progress text). For most handlers `task` is in scope,
 * so this is the most reliable signal — and it stays in the matching language
 * even when the workspace mixes English-named tasks with Chinese conversation
 * or vice versa.
 */
function langForTask(task: { title: string; description?: string | null; lastProgressSummary?: string | null } | null | undefined): 'en' | 'zh' {
  if (!task) return 'en';
  return detectLanguageFromTexts([task.title, task.description, task.lastProgressSummary]);
}

export async function consumeReasonReply(userId: string, channelId: string, text: string, client: any): Promise<boolean> {
  const pending = pendingReasonByUser.get(userId);
  if (!pending) return false;
  pendingReasonByUser.delete(userId);

  try {
    const task = await prisma.task.findUnique({ where: { id: pending.taskId } });
    if (!task) {
      const lang = /[一-鿿]/.test(text) ? 'zh' : 'en';
      await client.chat.postMessage({
        channel: channelId,
        text: lang === 'zh' ? '没找到这个任务。' : 'Task not found.',
      });
      return true;
    }
    const lang = langForTask(task);

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

    const ownerId = updated.initiator || updated.createdBy;
    if (ownerId) refreshOwnerHome(client, ownerId).catch(() => undefined);

    await client.chat.postMessage({
      channel: channelId,
      text: lang === 'zh' ? '收到,记下了。' : 'got it, written down.',
    });
  } catch (err) {
    log.error('Failed to consume reason reply', { error: String(err) });
    const lang = /[一-鿿]/.test(text) ? 'zh' : 'en';
    await client.chat.postMessage({
      channel: channelId,
      text: lang === 'zh' ? '没记上,再试一次。' : "couldn't record that, try once more.",
    });
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

      const ownerId = updated.initiator || updated.createdBy;
      if (ownerId) refreshOwnerHome(client, ownerId).catch(() => undefined);

      // Ephemeral confirm — short, locale-matching. No "Marked X complete"
      // banner; the verb carries it.
      if (channelId) {
        const lang = langForTask(updated);
        await client.chat.postEphemeral({
          channel: channelId,
          user: userId,
          text: lang === 'zh' ? `《${updated.title}》收尾了。` : `closed "${updated.title}".`,
        });
      }
    } catch (err) {
      log.error('task_mark_complete failed', { error: String(err) });
      if (channelId) {
        await client.chat.postEphemeral({
          channel: channelId,
          user: userId,
          text: 'could not close that — try again?',
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
          await client.chat.postEphemeral({ channel: channelId, user: userId, text: 'task not found.' });
        }
        return;
      }
      await prisma.task.delete({ where: { id: taskId } });

      if (channelId) {
        const lang = langForTask(existing);
        await client.chat.postEphemeral({
          channel: channelId,
          user: userId,
          text: lang === 'zh' ? `删了《${existing.title}》。` : `dropped "${existing.title}".`,
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
        await client.chat.postEphemeral({ channel: channelId, user: userId, text: "couldn't delete that one." });
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
        text: 'task not found.',
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

      const lang = langForTask(updated);
      const ownerId = updated.initiator || updated.createdBy;
      if (ownerId) {
        refreshOwnerHome(client, ownerId).catch(() => undefined);

        // Route the owner-side message through the orchestrator so the LLM
        // phrases it in workspace voice, instead of hand-templating "✅ X
        // marked Y complete." which reads as a notification.
        try {
          const dm = await client.conversations.open({ users: ownerId });
          const dmChannel = (dm as any).channel?.id || ownerId;
          await handleConversationTurn({
            client,
            registry,
            userId: ownerId,
            channelId: dmChannel,
            teamId: null,
            enterpriseId: null,
            fallbackTs: `${Date.now() / 1000}`,
            // Synthetic prompt to the AI describing what to say. Not visible to user.
            text: `<@${body.user.id}> just clicked "mark complete" on the task titled "${updated.title}". Write ONE short sentence to the owner letting them know — in ${lang === 'zh' ? 'Chinese' : 'English'}, no emoji, no bold, no "marked complete" banner. Just a colleague's note.`,
            triggerHint: 'button_completion_relay',
          });
        } catch {
          // best-effort
        }
      }

      // Acknowledge to the clicker. Locale matches the task.
      await client.chat.postMessage({
        channel: body.user.id,
        text: lang === 'zh' ? '好的,记下了。' : 'got it.',
      });
    } catch (err) {
      log.error('progress_task_completed failed', { error: String(err) });
      await client.chat.postMessage({ channel: body.user.id, text: "couldn't update that — try again?" });
    }
  });

  app.action<BlockAction<ButtonAction>>('progress_task_blocked', async ({ ack, body, client, action }) => {
    await ack();
    const taskId = action.value;
    if (!taskId) return;
    pendingReasonByUser.set(body.user.id, { taskId, kind: 'blocked_reason' });

    // Decide language from the task we just clicked on.
    const task = await prisma.task.findUnique({ where: { id: taskId } });
    const lang = langForTask(task);
    await client.chat.postMessage({
      channel: body.user.id,
      text: lang === 'zh'
        ? '收到 — 一两句话告诉我卡在哪了。'
        : "got it — what's blocking you? a sentence or two is fine.",
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
      const lang = langForTask(task);
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
        text: lang === 'zh'
          ? `已经 DM 了 <@${task.assignee}> — 一有回应就告诉你。`
          : `pinged <@${task.assignee}> — I'll let you know when they reply.`,
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
      const task = await prisma.task.findUnique({ where: { id: taskId } });
      await prisma.task.update({
        where: { id: taskId },
        data: { lastSilenceAlertAt: new Date() },
      });
      const lang = langForTask(task);
      await client.chat.postMessage({
        channel: body.user.id,
        text: lang === 'zh'
          ? '行,你来跟。有新动静我同步。'
          : "you've got it — I'll surface anything new.",
      });
    } catch (err) {
      log.error('silence_owner_handles failed', { error: String(err) });
    }
  });
}
