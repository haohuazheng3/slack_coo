import { RegisteredFunction } from '../orchestrator/functionRegistry';
import { toSlackMention } from '../utils/assignee';
import { openDm } from '../lib/sendHelpers';
import { conversationStore } from '../orchestrator/conversationStore';
import { createLogger } from '../lib/logger';

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
        return { status: 'error', message: `Task ${taskId} not found.` };
      }
      if (task.status === 'COMPLETED' || task.status === 'CANCELLED') {
        return {
          status: 'error',
          message: `Task ${taskId} is already ${task.status.toLowerCase()}, no nudge needed.`,
        };
      }

      const dmChannel = await openDm(slack.client, task.assignee);
      if (!dmChannel) {
        return { status: 'error', message: 'Could not open a DM with the assignee.' };
      }

      const dueText = task.time.toLocaleString();
      const ownerMention = toSlackMention(task.initiator || task.createdBy);

      const headerByReason: Record<string, string> = {
        scheduled: '🤝 Daily check-in',
        pre_due: '⏰ Quick status before due time',
        overdue: '⚠️ Task is past due',
        owner_requested: `🔍 ${ownerMention} asked for an update`,
      };
      const header = headerByReason[args.reason ?? 'scheduled'] ?? '🤝 Status check';

      const introLine = (args.customMessage?.trim() || `How's progress on this? Even a sentence helps — I'll summarize it for ${ownerMention}.`);

      await slack.client.chat.postMessage({
        channel: dmChannel,
        text: `${header}: ${task.title}`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: [
                `${header}`,
                `*${task.title}*`,
                task.description ? `📝 ${task.description}` : '',
                `📅 Due: ${dueText}`,
                ``,
                introLine,
              ]
                .filter(Boolean)
                .join('\n'),
            },
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: { type: 'plain_text', text: '✅ Mark complete' },
                style: 'primary',
                action_id: 'progress_task_completed',
                value: task.id,
              },
              {
                type: 'button',
                text: { type: 'plain_text', text: '⛔ I am blocked' },
                action_id: 'progress_task_blocked',
                value: task.id,
              },
            ],
          },
        ],
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
        message: `Nudged ${toSlackMention(task.assignee)} for status on "${task.title}".`,
        data: { taskId, assignee: task.assignee, channel: dmChannel, reason: args.reason },
      };
    },
  };
}
