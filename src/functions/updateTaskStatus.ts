import { TaskStatus } from '@prisma/client';
import { RegisteredFunction } from '../orchestrator/functionRegistry';
import {
  syncChannelTaskCard,
  persistChannelMessageTs,
  refreshOwnerHome,
} from '../slack/taskCardUpdater';

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

        const ts = await syncChannelTaskCard(context.slack.client, updated);
        if (ts && ts !== updated.channelMessageTs) {
          await persistChannelMessageTs(updated.id, ts);
        }
        const ownerId = updated.initiator || updated.createdBy;
        if (ownerId) refreshOwnerHome(context.slack.client, ownerId).catch(() => undefined);

        await context.slack.send(
          `📌 *${updated.title}* → *${nextStatus}*${args.note ? `\n_${args.note}_` : ''}`
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
