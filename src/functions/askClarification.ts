import { RegisteredFunction } from '../orchestrator/functionRegistry';
import { toSlackMention } from '../utils/assignee';
import { detectLanguageFromTexts } from '../lib/i18n';

type AskClarificationArgs = {

  question: string;

  missingFields?: Array<'assignee' | 'dueTime' | 'title' | 'description' | 'priority' | string>;

  draftSummary?: string;
};

const FIELD_LABEL: Record<'en' | 'zh', Record<string, string>> = {
  en: {
    assignee: 'Assignee',
    dueTime: 'Due time',
    title: 'Task title',
    description: 'Description',
    priority: 'Priority',
  },
  zh: {
    assignee: '负责人',
    dueTime: '截止时间',
    title: '任务标题',
    description: '任务描述',
    priority: '优先级',
  },
};

const COPY = {
  en: {
    needInfo: 'I need a bit more info before I create this task:',
    draft: 'Draft so far',
    missing: 'Missing',
  },
  zh: {
    needInfo: '建任务前还需要你补一下:',
    draft: '目前的草稿',
    missing: '缺少',
  },
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

      // Language follows the question itself + any draft context. If the AI is
      // asking in Chinese, the prefix/labels need to be Chinese — anything else
      // breaks the "no mixed languages" rule and shows up as the kind of jarring
      // half-translated UI we've been actively tearing out.
      const lang = detectLanguageFromTexts([question, args.draftSummary ?? null]);
      const copy = COPY[lang];
      const fieldLabels = FIELD_LABEL[lang];

      const blocks: any[] = [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `${ownerMention} ❓ *${copy.needInfo}*\n${question}`,
          },
        },
      ];

      if (args.draftSummary) {
        blocks.push({
          type: 'context',
          elements: [{ type: 'mrkdwn', text: `📝 ${copy.draft}: _${args.draftSummary.trim()}_` }],
        });
      }

      if (missingFields.length > 0) {
        const formatted = missingFields
          .map((f) => `• ${fieldLabels[f] ?? f}`)
          .join('\n');
        blocks.push({
          type: 'context',
          elements: [{ type: 'mrkdwn', text: `${copy.missing}:\n${formatted}` }],
        });
      }

      // The top-level `text` is fallback / notification text — Slack uses it for
      // mobile previews. Keep it in the question's language too.
      const fallbackText = lang === 'zh' ? `需要补充: ${question}` : `Need clarification: ${question}`;
      await context.slack.send({ text: fallbackText, blocks });

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
