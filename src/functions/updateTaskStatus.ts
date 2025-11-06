import { RegisteredFunction } from '../orchestrator/functionRegistry';

type UpdateTaskStatusArgs = {
  taskId: string;
  completed: boolean;
  note?: string;
};

export function updateTaskStatusFunction(): RegisteredFunction {
  return {
    name: 'UpdateTaskStatus',
    description: 'Mark a task as completed or pending. Provide taskId and completed flag, optional note.',
    inputExample: '{"taskId": "clxyz123", "completed": true}',
    handler: async (args: UpdateTaskStatusArgs, context) => {
      const { taskId, completed, note } = args ?? {} as UpdateTaskStatusArgs;

      if (!taskId || typeof taskId !== 'string') {
        return {
          status: 'error',
          message: 'taskId is required.',
        };
      }

      if (typeof completed !== 'boolean') {
        return {
          status: 'error',
          message: 'completed must be true or false.',
        };
      }

      try {
        await context.prisma.task.update({
          where: { id: taskId },
          data: {
            completed,
            notCompletedReason: !completed && note ? note : null,
          },
        });
      } catch (error: any) {
        return {
          status: 'error',
          message: error?.message ?? 'Failed to update task status.',
        };
      }

      const statusText = completed ? 'completed' : 'marked as pending';
      const noteText = note ? `\n📝 Note: ${note}` : '';

      await context.slack.send(`✅ Task ${taskId} ${statusText}.${noteText}`.trim());

      return {
        status: 'success',
        message: `Task ${taskId} ${statusText}.`,
      };
    },
  };
}

