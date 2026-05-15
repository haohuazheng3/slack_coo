import { TaskPriority } from '@prisma/client';
import { RegisteredFunction } from '../orchestrator/functionRegistry';
import { ParsedTaskInput, normalizeToDBTask } from '../services/normalizeTask';
import { toSlackMention } from '../utils/assignee';
import { prisma } from '../lib/prisma';
import { openDm } from '../lib/sendHelpers';
import {
  syncChannelTaskCard,
  persistChannelMessageTs,
  refreshOwnerHome,
} from '../slack/taskCardUpdater';
import { createLogger } from '../lib/logger';

const log = createLogger('CreateTask');

type CreateTaskArgs = {
  title: string;
  description?: string;
  dueTime?: string;
  reminder?: string;
  assignee?: string;
  assignees?: string[];
  initiator?: string;
  priority?: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
};

function normalizePriority(value: unknown): TaskPriority {
  if (typeof value !== 'string') return 'NORMAL';
  const upper = value.trim().toUpperCase();
  if (upper === 'LOW' || upper === 'HIGH' || upper === 'URGENT' || upper === 'NORMAL') {
    return upper as TaskPriority;
  }
  return 'NORMAL';
}

export function createTaskFunction(): RegisteredFunction {
  return {
    name: 'CreateTask',
    description:
      'Persist a task ONLY after you have a clear title, a Slack assignee, and a dueTime. If any of those are missing, call [AskClarification] first instead.',
    inputExample:
      '{"title":"Prepare Q4 forecast","description":"Pull numbers from finance, draft 1-pager","dueTime":"2025-01-05T14:00:00-05:00","assignee":"<@U123>","priority":"HIGH"}',

    handler: async (args: CreateTaskArgs, context) => {
      if (!args || typeof args !== 'object') {
        return { status: 'error', message: 'Invalid arguments received.' };
      }

      const title = (args.title || '').trim();
      if (!title) {
        return { status: 'error', message: 'Task title is required.' };
      }
      if (!args.assignee && (!args.assignees || args.assignees.length === 0)) {
        return {
          status: 'error',
          message: 'Assignee is required. Call [AskClarification] first if unknown.',
        };
      }
      if (!args.dueTime) {
        return {
          status: 'error',
          message: 'dueTime is required. Call [AskClarification] first if unknown.',
        };
      }

      const payload: ParsedTaskInput = {
        title,
        task: args.description ?? args.title,
        time: args.dueTime,
        reminder_time: args.reminder,
        assignee: args.assignee,
        assignees: args.assignees,
        initiator: args.initiator ?? context.slack.userId,
        channelId: context.slack.channelId,
        createdBy: context.slack.userId,
        rawText: context.slack.rawText,
      };

      let normalized;
      try {
        normalized = normalizeToDBTask(payload);
      } catch (e: any) {
        return { status: 'error', message: e?.message ?? 'Failed to normalize task.' };
      }

      const priority = normalizePriority(args.priority);
      const description = (args.description || '').trim() || null;

      const created = await prisma.task.create({
        data: {
          title: normalized.title,
          description,
          time: normalized.time,
          assignee: normalized.assignee,
          assignees: normalized.assignees,
          channelId: normalized.channelId,
          threadTs: context.slack.threadTs ?? null,
          createdBy: normalized.createdBy,
          initiator: normalized.initiator,
          teamId: context.slack.teamId ?? null,
          enterpriseId: context.slack.enterpriseId ?? null,
          status: 'NOT_STARTED',
          priority,
          deadlineReminderSentAt: new Date(),
        },
      });
      log.info('Task created', { taskId: created.id, title: created.title });

      const cardTs = await syncChannelTaskCard(context.slack.client, created);
      if (cardTs) {
        await persistChannelMessageTs(created.id, cardTs);
      }

      const dueText = created.time.toLocaleString();
      const assigneeMention = toSlackMention(created.assignee);
      const assigneesMention = Array.isArray(created.assignees) && created.assignees.length > 0
        ? created.assignees.map((a) => toSlackMention(a)).join(', ')
        : assigneeMention;

      const assigneeDm = await openDm(context.slack.client, created.assignee);
      if (assigneeDm) {
        await context.slack.client.chat.postMessage({
          channel: assigneeDm,
          text: `🆕 New task: ${created.title}`,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: [
                  `🆕 *You were assigned a task by ${toSlackMention(created.initiator || created.createdBy)}*`,
                  `*${created.title}*`,
                  description ? `📝 ${description}` : '',
                  `📅 Due: ${dueText}`,
                  `🏷 Priority: ${priority}`,
                  `\n_I will check in periodically. Just reply here when you have updates._`,
                ]
                  .filter(Boolean)
                  .join('\n'),
              },
            },
          ],
        });
      }

      const initiatorId = created.initiator || created.createdBy;
      if (initiatorId && initiatorId !== created.assignee) {
        const ownerDm = await openDm(context.slack.client, initiatorId);
        if (ownerDm) {
          await context.slack.client.chat.postMessage({
            channel: ownerDm,
            text: `✅ Task created for ${assigneesMention}: ${created.title}`,
          });
        }
      }

      if (initiatorId) {
        refreshOwnerHome(context.slack.client, initiatorId).catch(() => undefined);
      }

      return {
        status: 'success',
        message: `Created task "${created.title}" for ${assigneeMention}.`,
        data: {
          taskId: created.id,
          title: created.title,
          assignee: created.assignee,
          initiator: initiatorId,
          time: created.time.toISOString(),
          priority: created.priority,
          action: 'created',
        },
      };
    },
  };
}
