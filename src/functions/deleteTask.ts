import { RegisteredFunction } from '../orchestrator/functionRegistry';

type DeleteTaskArgs = {
  taskId: string;
};

export function deleteTaskFunction(): RegisteredFunction {
  return {
    name: 'DeleteTask',
    description: 'Remove a task permanently when it is no longer needed. Requires the taskId.',
    inputExample: '{"taskId": "clxyz123"}',
    handler: async (args: DeleteTaskArgs, context) => {
      const taskId = args?.taskId;

      if (!taskId || typeof taskId !== 'string') {
        return {
          status: 'error',
          message: 'A valid taskId is required to delete a task.',
        };
      }

      try {
        await context.prisma.task.delete({ where: { id: taskId } });
      } catch (error: any) {
        return {
          status: 'error',
          message: error?.message ?? 'Failed to delete task.',
        };
      }

      await context.slack.send(`🗑️ Task ${taskId} deleted.`);

      return {
        status: 'success',
        message: `Deleted task ${taskId}.`,
      };
    },
  };
}

