import { TaskStatus } from '@prisma/client';
import { RegisteredFunction } from '../orchestrator/functionRegistry';
import { refreshOwnerHome } from '../slack/taskCardUpdater';
import { detectLanguageFromTexts, getTranslator } from '../lib/i18n';

const VALID_STATUS: TaskStatus[] = [
  'PENDING_CLARIFICATION',
  'NOT_STARTED',
  'IN_PROGRESS',
  'BLOCKED',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
];

type UpdateTaskStatusArgs = {
  taskId: string;

  status?: TaskStatus;

  completed?: boolean;
  note?: string;
};

export function updateTaskStatusFunction(): RegisteredFunction {
  return {
    name: 'UpdateTaskStatus',
    description:
      "Set a task's status when you know it directly (e.g. owner says 'cancel this' or 'mark complete'). Prefer [RecordProgress] when you also have a free-form status from the employee.",
    inputExample: '{"taskId":"clxyz123","status":"COMPLETED"}',
    handler: async (args: UpdateTaskStatusArgs, context) => {
      const taskId = (args?.taskId || '').trim();
      if (!taskId) return { status: 'error', message: 'taskId is required.' };

      let nextStatus: TaskStatus | undefined = args.status;
      if (!nextStatus && typeof args.completed === 'boolean') {
        nextStatus = args.completed ? 'COMPLETED' : 'IN_PROGRESS';
      }
      if (!nextStatus || !VALID_STATUS.includes(nextStatus)) {
        return {
          status: 'error',
          message: `status must be one of ${VALID_STATUS.join(', ')}.`,
        };
      }

      const isCompleted = nextStatus === 'COMPLETED';
      const isFailureOrBlocked = nextStatus === 'FAILED' || nextStatus === 'BLOCKED';

      try {
        const updated = await context.prisma.task.update({
          where: { id: taskId },
          data: {
            status: nextStatus,
            completed: isCompleted,
            completedAt: isCompleted ? new Date() : null,
            progressPercent: isCompleted ? 100 : undefined,
            notCompletedReason: isFailureOrBlocked && args.note ? args.note : null,
            notCompletedReasonAt: isFailureOrBlocked ? new Date() : null,
          },
        });

        const ownerId = updated.initiator || updated.createdBy;
        if (ownerId) {
          refreshOwnerHome(context.slack.client, ownerId, {
            teamId: context.slack.teamId ?? null,
            enterpriseId: context.slack.enterpriseId ?? null,
          }).catch(() => undefined);
        }

        // Localized status announcement. The raw enum (`CANCELLED`) is for the
        // database and the AI's tool-call context — never for the user-facing
        // string. Use the i18n table so a Chinese workspace sees 已取消, not
        // CANCELLED. The orchestrator's own natural-language reply follows
        // this and provides the conversational framing.
        const lang = detectLanguageFromTexts([updated.title, updated.description, updated.lastProgressSummary]);
        const translator = getTranslator(lang);
        const noteSuffix = args.note ? `\n_${args.note}_` : '';
        await context.slack.send(
          `📌 *${updated.title}* → *${translator.statusLabel(nextStatus)}*${noteSuffix}`
        );

        return {
          status: 'success',
          message: `Task ${taskId} status set to ${nextStatus}.`,
          data: { taskId, status: nextStatus, action: 'status_updated' },
        };
      } catch (error: any) {
        return {
          status: 'error',
          message: error?.message ?? 'Failed to update task status.',
        };
      }
    },
  };
}
