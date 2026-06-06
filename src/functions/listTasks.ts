import { RegisteredFunction } from '../orchestrator/functionRegistry';
import { buildTaskListMessage } from '../slack/listTasks';

type ListTasksArgs = {
  scope?: 'pending' | 'completed' | 'all';
  userId?: string;
};

export function listTasksFunction(): RegisteredFunction {
  return {
    name: 'ListTasks',
    description:
      "Show the requester a summary of their tasks. scope = 'pending' (default), 'completed', or 'all'. Use this when the user asks to see, review, or modify tasks.",
    inputExample: '{"scope":"pending"}',
    handler: async (args: ListTasksArgs, context) => {
      const scope = args?.scope ?? 'pending';
      const targetUserId = args?.userId || context.slack.userId;

      const message = await buildTaskListMessage(context.prisma, targetUserId, {
        showCompleted: scope === 'completed',
        showAll: scope === 'all',
        teamId: context.slack.teamId ?? null,
        enterpriseId: context.slack.enterpriseId ?? null,
      });

      await context.slack.send(message);

      return {
        status: 'success',
        message: 'Task list shown.',
        data: { scope, userId: targetUserId, action: 'listed' },
      };
    },
  };
}
