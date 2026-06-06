import { RegisteredFunction } from '../orchestrator/functionRegistry';
import { toSlackMention } from '../utils/assignee';
import { openDm, postMessageWithFeedback } from '../lib/sendHelpers';
import { conversationStore } from '../orchestrator/conversationStore';
import { createLogger } from '../lib/logger';
import { detectLanguageFromTexts } from '../lib/i18n';
import { formatDateTime } from '../lib/timezone';
import { getUserProfile } from '../lib/userProfile';

const log = createLogger('NudgeProgress');

type NudgeProgressArgs = {
  taskId: string;

  reason?: 'scheduled' | 'pre_due' | 'overdue' | 'owner_requested';
  customMessage?: string;
};

export function nudgeProgressFunction(): RegisteredFunction {
  return {
    name: 'NudgeProgress',
    description:
      "DM the task's assignee to ask for a status update. Use when scheduled cadence triggers, when due-time is near, or when the owner explicitly asks. The DM thread will be tagged so the assignee's next reply is interpreted as a progress update for this task.",
    inputExample: '{"taskId":"clxyz123","reason":"pre_due"}',

    handler: async (args: NudgeProgressArgs, context) => {
      const { prisma, slack } = context;
      const taskId = (args?.taskId || '').trim();
      if (!taskId) {
        return { status: 'error', message: 'taskId is required.' };
      }

      const task = await prisma.task.findUnique({ where: { id: taskId } });
      if (!task) {
        return { status: 'error', message: 'Task not found.' };
      }
      if (task.status === 'COMPLETED' || task.status === 'CANCELLED') {
        return {
          status: 'error',
          message: 'Task is already closed; no nudge needed.',
        };
      }

      const dmChannel = await openDm(slack.client, task.assignee);
      if (!dmChannel) {
        return { status: 'error', message: 'Could not open a DM with the assignee.' };
      }

      // Display the deadline in the ASSIGNEE's local timezone — they're the one
      // about to read this DM. Locale follows the task content language.
      const assigneeProfile = await getUserProfile(slack.client, task.assignee, {
        teamId: slack.teamId ?? null,
        enterpriseId: slack.enterpriseId ?? null,
      });
      const lang = detectLanguageFromTexts([task.title, task.description, task.lastProgressSummary]);
      const dueText = formatDateTime(task.time, {
        tz: assigneeProfile?.tz ?? process.env.DEFAULT_TIMEZONE,
        locale: lang,
      });
      const ownerMention = toSlackMention(task.initiator || task.createdBy);
      const reason = args.reason ?? 'scheduled';

      // Flowing one-sentence DM instead of a bolded title + 📅 due + 📝 description
      // mini-card. The assignee sees a teammate's note, not a notification widget.
      // Locale-aware throughout — Chinese workspace gets Chinese end-to-end.
      const bodyText = args.customMessage?.trim() || buildNudgeBody({
        lang,
        reason,
        title: task.title,
        description: task.description ?? null,
        dueText,
        ownerMention,
      });

      // Buttons only on overdue / owner_requested — for routine check-ins, the
      // affordance gets in the way; the assignee can just reply naturally.
      const showButtons = reason === 'overdue' || reason === 'owner_requested';
      const blocks: any[] = [
        { type: 'section', text: { type: 'mrkdwn', text: bodyText } },
      ];
      if (showButtons) {
        blocks.push({
          type: 'actions',
          elements: [
            {
              // Emoji-only button labels — work across languages without us picking one.
              type: 'button',
              text: { type: 'plain_text', text: '✅' },
              style: 'primary',
              action_id: 'progress_task_completed',
              value: task.id,
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: '⛔' },
              action_id: 'progress_task_blocked',
              value: task.id,
            },
          ],
        });
      }

      await postMessageWithFeedback(slack.client, {
        channel: dmChannel,
        text: bodyText,
        blocks,
      });

      const now = new Date();
      await prisma.task.update({
        where: { id: taskId },
        data: { lastNudgeAt: now, progressPingSentAt: now },
      });
      await prisma.progressUpdate.create({
        data: {
          taskId,
          source: 'system',
          summary: `Nudged assignee (${args.reason ?? 'scheduled'}).`,
          progressPercent: task.progressPercent,
          statusAtTime: task.status,
        },
      });

      const convKey = `DM:${dmChannel}`;
      conversationStore.append(convKey, {
        role: 'assistant',
        content: `ToolResult: ${JSON.stringify({
          name: 'NudgeProgress',
          data: { taskId, title: task.title, assignee: task.assignee },
        })}`,
      });

      log.info('Nudge sent', { taskId, assignee: task.assignee, reason: args.reason });

      return {
        status: 'success',
        message: 'Nudge sent.',
        data: { taskId, assignee: task.assignee, channel: dmChannel, reason: args.reason },
      };
    },
  };
}

/**
 * Compose the assignee DM as one flowing sentence rather than a stacked
 * "header / *title* / 📅 Due / intro" card. Each reason gets a slightly
 * different opener so the same person doesn't get the identical line every
 * scheduled check-in.
 */
function buildNudgeBody(args: {
  lang: 'en' | 'zh';
  reason: 'scheduled' | 'pre_due' | 'overdue' | 'owner_requested';
  title: string;
  description: string | null;
  dueText: string;
  ownerMention: string;
}): string {
  const { lang, reason, title, description, dueText, ownerMention } = args;
  const ctx = description ? (lang === 'zh' ? `(背景:${description})` : `(context: ${description})`) : '';
  const tail =
    lang === 'zh'
      ? `一两句就够 — 在做 / 一半 / 卡在 X / 做完了 都行,我帮你跟 ${ownerMention} 同步。`
      : `One line is plenty — "on it" / "halfway" / "blocked on X" / "done" — I'll handle the loop back to ${ownerMention}.`;

  if (lang === 'zh') {
    switch (reason) {
      case 'pre_due':
        return `提醒一下,《${title}》${dueText} 之前要 ${ctx}\n${tail}`;
      case 'overdue':
        return `《${title}》${dueText} 已经到期了 ${ctx}\n${tail}`.trim();
      case 'owner_requested':
        return `${ownerMention} 想了解一下《${title}》进展如何 ${ctx}\n${tail}`.trim();
      default:
        return `《${title}》这边进展怎样? ${dueText} 之前要 ${ctx}\n${tail}`.trim();
    }
  }

  switch (reason) {
    case 'pre_due':
      return `Heads up — "${title}" is due ${dueText} ${ctx}\n${tail}`.trim();
    case 'overdue':
      return `Just flagging — "${title}" was due ${dueText} ${ctx}\n${tail}`.trim();
    case 'owner_requested':
      return `${ownerMention} asked how "${title}" is going ${ctx}\n${tail}`.trim();
    default:
      return `Quick one — how's "${title}" going? Due ${dueText} ${ctx}\n${tail}`.trim();
  }
}
