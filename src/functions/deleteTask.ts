import { RegisteredFunction } from '../orchestrator/functionRegistry';
import { refreshOwnerHome } from '../slack/taskCardUpdater';

type DeleteTaskArgs = {
  taskId: string;
};

export function deleteTaskFunction(): RegisteredFunction {
  return {
    name: 'DeleteTask',
    description:
      'Permanently remove a task. Use only when the owner explicitly asks to delete (not "cancel" — for that, use [UpdateTaskStatus] with status=CANCELLED).',
    inputExample: '{"taskId":"clxyz123"}',
    handler: async (args: DeleteTaskArgs, context) => {
      const taskId = args?.taskId;
      if (!taskId || typeof taskId !== 'string') {
        return {
          status: 'error',
          message: 'A valid taskId is required to delete a task.',
        };
      }

      let existing;
      try {
        existing = await context.prisma.task.findUnique({ where: { id: taskId } });
        if (!existing) {
          return { status: 'error', message: 'Task not found.' };
        }
        await context.prisma.task.delete({ where: { id: taskId } });
      } catch (error: any) {
        return {
          status: 'error',
          message: 'Could not delete the task.',
        };
      }

      // No "🗑️ Deleted task X" banner — the orchestrator's natural reply
      // covers it. The banner pattern was making deletion feel like a system
      // event, not "ok, dropped that one."
      const ownerId = existing.initiator || existing.createdBy;
      if (ownerId) refreshOwnerHome(context.slack.client, ownerId).catch(() => undefined);

      return {
        status: 'success',
        message: 'Task deleted.',
        data: { taskId, taskTitle: existing.title, action: 'deleted' },
      };
    },
  };
}
