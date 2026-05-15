import { TaskStatus } from '@prisma/client';
import { RegisteredFunction } from '../orchestrator/functionRegistry';
import { interpretEmployeeProgress } from '../services/aiSummarizer';
import { toSlackMention } from '../utils/assignee';
import { openDm } from '../lib/sendHelpers';
import {
  syncChannelTaskCard,
  persistChannelMessageTs,
  refreshOwnerHome,
} from '../slack/taskCardUpdater';
import { createLogger } from '../lib/logger';

const log = createLogger('RecordProgress');

type RecordProgressArgs = {

  taskId?: string;

  employeeReply: string;

  status?: TaskStatus;
  progressPercent?: number;
  summary?: string;
};

export function recordProgressFunction(): RegisteredFunction {
  return {
    name: 'RecordProgress',
    description:
      "When an employee replies in DM about a task (or in any context that gives you their status), interpret the reply, store an AI-generated owner-facing summary, update task status/progress, then notify the owner via DM and refresh the channel card + Home tab. Pass the employee's raw reply as employeeReply; you may also override the status, progressPercent, and summary if you are confident.",
    inputExample:
      '{"taskId":"clxyz123","employeeReply":"I have drafted the slides, blocked by missing data from finance."}',

    handler: async (args: RecordProgressArgs, context) => {
      const { prisma, slack } = context;

      const taskId = (args?.taskId || '').trim();
      const reply = (args?.employeeReply || '').trim();

      if (!taskId) {
        return { status: 'error', message: 'taskId is required.' };
      }
      if (!reply) {
        return { status: 'error', message: 'employeeReply is required.' };
      }

      const task = await prisma.task.findUnique({ where: { id: taskId } });
      if (!task) {
        return { status: 'error', message: `Task ${taskId} not found.` };
      }

      const interpretation = await interpretEmployeeProgress({
        taskTitle: task.title,
        taskDescription: task.description,
        dueAt: task.time,
        previousSummary: task.lastProgressSummary,
        employeeReply: reply,
      });

      const finalStatus = args.status && isValidStatus(args.status) ? args.status : interpretation.status;
      const finalPercent =
        typeof args.progressPercent === 'number'
          ? clamp(args.progressPercent)
          : interpretation.progressPercent;
      const finalSummary = (args.summary?.trim() || interpretation.ownerSummary).slice(0, 500);

      const isComplete = finalStatus === 'COMPLETED';
      const isFailure = finalStatus === 'FAILED';

      const updated = await prisma.task.update({
        where: { id: taskId },
        data: {
          status: finalStatus,
          progressPercent: isComplete ? 100 : finalPercent,
          lastProgressSummary: finalSummary,
          lastProgressAt: new Date(),
          completed: isComplete,
          completedAt: isComplete ? new Date() : null,
          notCompletedReason:
            isFailure || finalStatus === 'BLOCKED'
              ? interpretation.blocker || finalSummary
              : null,
          notCompletedReasonAt:
            isFailure || finalStatus === 'BLOCKED' ? new Date() : null,
        },
      });

      await prisma.progressUpdate.create({
        data: {
          taskId: updated.id,
          source: 'employee_reply',
          authorId: context.slack.userId,
          rawText: reply,
          summary: finalSummary,
          progressPercent: updated.progressPercent,
          statusAtTime: updated.status,
        },
      });

      log.info('Progress recorded', {
        taskId: updated.id,
        status: updated.status,
        progress: updated.progressPercent,
      });

      const ts = await syncChannelTaskCard(slack.client, updated);
      if (ts && ts !== updated.channelMessageTs) {
        await persistChannelMessageTs(updated.id, ts);
      }

      const ownerId = updated.initiator || updated.createdBy;
      if (ownerId) {
        const ownerDm = await openDm(slack.client, ownerId);
        if (ownerDm) {
          const headerEmoji = isComplete ? '✅' : isFailure ? '❌' : finalStatus === 'BLOCKED' ? '⛔' : '🚧';
          await slack.client.chat.postMessage({
            channel: ownerDm,
            text: `${headerEmoji} Progress update on "${updated.title}"`,
            blocks: [
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: [
                    `${headerEmoji} *${updated.title}* — ${labelOf(finalStatus)}`,
                    `*Assignee:* ${toSlackMention(updated.assignee)}`,
                    `*Progress:* ${updated.progressPercent}%`,
                    `*Summary:* ${finalSummary}`,
                    interpretation.blocker
                      ? `*Blocker:* ${interpretation.blocker}`
                      : '',
                  ]
                    .filter(Boolean)
                    .join('\n'),
                },
              },
              {
                type: 'context',
                elements: [
                  {
                    type: 'mrkdwn',
                    text: `_Open Home tab for full dashboard. Original message from ${toSlackMention(context.slack.userId)}:_\n>${reply.replace(/\n/g, '\n>')}`,
                  },
                ],
              },
            ],
          });
        }

        refreshOwnerHome(slack.client, ownerId).catch(() => undefined);
      }

      return {
        status: 'success',
        message: `Recorded progress for "${updated.title}" — ${updated.status}, ${updated.progressPercent}%.`,
        data: {
          taskId: updated.id,
          title: updated.title,
          status: updated.status,
          progressPercent: updated.progressPercent,
          summary: finalSummary,
          action: 'progress_recorded',
        },
      };
    },
  };
}

function clamp(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function isValidStatus(s: unknown): s is TaskStatus {
  const all: TaskStatus[] = [
    'PENDING_CLARIFICATION',
    'NOT_STARTED',
    'IN_PROGRESS',
    'BLOCKED',
    'COMPLETED',
    'FAILED',
    'CANCELLED',
  ];
  return typeof s === 'string' && all.includes(s as TaskStatus);
}

function labelOf(status: TaskStatus): string {
  return (
    {
      PENDING_CLARIFICATION: 'Awaiting clarification',
      NOT_STARTED: 'Not started',
      IN_PROGRESS: 'In progress',
      BLOCKED: 'Blocked',
      COMPLETED: 'Completed',
      FAILED: 'Not completed',
      CANCELLED: 'Cancelled',
    } as Record<TaskStatus, string>
  )[status];
}
