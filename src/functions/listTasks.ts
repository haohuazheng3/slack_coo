import { RegisteredFunction } from '../orchestrator/functionRegistry';
import { buildTaskListMessage } from '../slack/listTasks';

type ListTasksArgs = {
  scope?: 'pending' | 'completed' | 'all';
};

export function listTasksFunction(): RegisteredFunction {
  return {
    name: 'ListTasks',
    description:
      'Show the requester a summary of their tasks. Scope can be pending (default), completed, or all.',
    inputExample: '{"scope": "pending"}',
    handler: async (args: ListTasksArgs, context) => {
      const scope = args?.scope ?? 'pending';

      const message = await buildTaskListMessage(context.prisma, context.slack.userId, {
        showCompleted: scope === 'completed',
        showAll: scope === 'all',
      });

      await context.slack.send(message);

      return {
        status: 'success',
        message: `Listed ${scope} tasks.`,
      };
    },
  };
}

