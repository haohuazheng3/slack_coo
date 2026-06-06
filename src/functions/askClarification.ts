import { RegisteredFunction } from '../orchestrator/functionRegistry';
import { toSlackMention } from '../utils/assignee';

type AskClarificationArgs = {
  question: string;
  /** Kept in the schema for the AI's reasoning context — not rendered as a UI block. */
  missingFields?: Array<'assignee' | 'dueTime' | 'title' | 'description' | 'priority' | string>;
  /** Kept in the schema for the AI's reasoning context — not rendered as a UI block. */
  draftSummary?: string;
};

export function askClarificationFunction(): RegisteredFunction {
  return {
    name: 'AskClarification',
    description:
      "Post a clarifying question back to the owner in the same channel/thread when the task is ambiguous. Use this BEFORE [CreateTask] whenever assignee, dueTime, title, or scope is missing or unclear. Ask ONE concrete question — include the missing field naturally in the question itself, e.g. \"who's owning this and by when?\" — not \"I need: assignee, deadline\". Does not save anything to the database.",
    inputExample:
      '{"question":"who do you want me to give this to and by when?"}',

    handler: async (args: AskClarificationArgs, context) => {
      const question = (args?.question || '').trim();
      if (!question) {
        return { status: 'error', message: 'A question is required for AskClarification.' };
      }

      const ownerMention = toSlackMention(context.slack.userId);

      // No widget UI — no emoji prefix, no bold "I need more info" lead-in, no
      // draft echo, no "Missing:" bullet list, no divider. Just the AI's
      // question prose, addressed to the owner. The AI's job (per tool
      // description) is to ask ONE concrete question that already names what's
      // missing inside it — no need for the bot to scaffold structure around it.
      await context.slack.send({
        text: question,
        blocks: [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: `${ownerMention} ${question}` },
          },
        ],
      });

      return {
        status: 'success',
        message: 'Clarification asked.',
        data: {
          action: 'clarification_requested',
          missingFields: args.missingFields ?? null,
          draftSummary: args.draftSummary ?? null,
        },
      };
    },
  };
}
