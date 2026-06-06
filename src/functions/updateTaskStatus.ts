import { TaskStatus } from '@prisma/client';
import { RegisteredFunction } from '../orchestrator/functionRegistry';
import { refreshOwnerHome } from '../slack/taskCardUpdater';

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
        // The allowed values live in the tool description (which feeds the
        // prompt). At runtime we don't echo the enum list back — that's an
        // internal vocabulary that doesn't belong in any user-visible path.
        return { status: 'error', message: 'Unknown status value.' };
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

        // NO templated announcement. The orchestrator's natural-language reply
        // ("好的,已取消了《banner》") covers the user-visible confirmation.
        // A "📌 *X* → *Y*" widget stapled to every status change reads as a
        // dashboard pin, not a colleague.

        return {
          status: 'success',
          message: 'Task status updated.',
          data: {
            taskId,
            status: nextStatus,
            taskTitle: updated.title,
            action: 'status_updated',
          },
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
