import { RegisteredFunction } from '../orchestrator/functionRegistry';
import { toSlackMention } from '../utils/assignee';

type AskClarificationArgs = {

  question: string;

  missingFields?: Array<'assignee' | 'dueTime' | 'title' | 'description' | 'priority' | string>;

  draftSummary?: string;
};

const FIELD_LABEL: Record<string, string> = {
  assignee: '负责人 / Assignee',
  dueTime: '截止时间 / Due time',
  title: '任务标题 / Title',
  description: '任务描述 / Description',
  priority: '优先级 / Priority',
};

export function askClarificationFunction(): RegisteredFunction {
  return {
    name: 'AskClarification',
    description:
      'Post a clarifying question back to the owner in the same channel/thread when the task is ambiguous. Use this BEFORE [CreateTask] whenever assignee, dueTime, title, or scope is missing or unclear. Do not save anything to the database.',
    inputExample:
      '{"question":"Who should own this and when is it due?","missingFields":["assignee","dueTime"],"draftSummary":"Prepare Q4 forecast."}',

    handler: async (args: AskClarificationArgs, context) => {
      const question = (args?.question || '').trim();
      if (!question) {
        return {
          status: 'error',
          message: 'A question is required for AskClarification.',
        };
      }

      const ownerMention = toSlackMention(context.slack.userId);

      const missingFields = Array.isArray(args.missingFields)
        ? args.missingFields
            .map((f) => (typeof f === 'string' ? f.trim() : ''))
            .filter((f) => f.length > 0)
        : [];

      const blocks: any[] = [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `${ownerMention} ❓ *I need a bit more info before I create this task:*\n${question}`,
          },
        },
      ];

      if (args.draftSummary) {
        blocks.push({
          type: 'context',
          elements: [{ type: 'mrkdwn', text: `📝 Draft so far: _${args.draftSummary.trim()}_` }],
        });
      }

      if (missingFields.length > 0) {
        const formatted = missingFields
          .map((f) => `• ${FIELD_LABEL[f] ?? f}`)
          .join('\n');
        blocks.push({
          type: 'context',
          elements: [{ type: 'mrkdwn', text: `Missing:\n${formatted}` }],
        });
      }

      await context.slack.send({
        text: `Need clarification: ${question}`,
        blocks,
      });

      return {
        status: 'success',
        message: `Asked for clarification: ${question}`,
        data: {
          action: 'clarification_requested',
          missingFields,
          draftSummary: args.draftSummary ?? null,
        },
      };
    },
  };
}
